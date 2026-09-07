// Talking to an OpenClaw gateway.
//
// OpenClaw is not like Hermes. Hermes keeps agent files on disk and ships a CLI,
// so relaying is "spawn it and read stdout". OpenClaw usually runs a *gateway*
// that hosts the fleet, and the machine running Radiant is often just a client
// pointing at it — the agents are on another box entirely. To list or talk to
// them we have to speak the gateway's protocol.
//
// The protocol, as the gateway enforces it:
//   • WebSocket to gateway.remote.url, token in the query string
//   • server sends  {type:"event", event:"connect.challenge", payload:{nonce}}
//   • we reply      {type:"req", id, method:"connect", params:{…, device:{…}}}
//     where device.signature is an Ed25519 signature over
//       ["v2", deviceId, clientId, clientMode, role, scopes.join(","),
//        signedAtMs, token, nonce].join("|")
//   • server answers {type:"res", id, payload:{connId, features:{methods}}}
//   • thereafter     {type:"req", id, method, params} / {type:"res", id, payload}
//
// ⚠️ CREDENTIALS ARE PER MACHINE AND CAN GO STALE. The device token is issued to
// this device by that gateway and is rejected with AUTH_DEVICE_TOKEN_MISMATCH
// once it no longer matches. That is a real, expected state — surface it,
// never paper over it, and never offer a Connect button that cannot connect.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'

const CLIENT_ID = 'gateway-client'   // the id the gateway allows for integrations
const CLIENT_MODE = 'backend'
const PROTOCOL = 4

function readJson (p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

// Where this machine's OpenClaw identity lives. Installs vary; check each root.
export function openclawIdentity () {
  const home = os.homedir()
  const roots = [process.env.OPENCLAW_HOME, path.join(home, '.openclaw'),
    path.join(home, '.config', 'openclaw'),
    path.join(home, 'Library', 'Application Support', 'OpenClaw')].filter(Boolean)
  for (const root of roots) {
    const cfg = readJson(path.join(root, 'openclaw.json'))
    if (!cfg) continue
    // A remote URL when this machine is a client; otherwise OpenClaw is running
    // here and serves the gateway locally. AI MBP hosts the fleet this way.
    const url = cfg.gateway?.remote?.url || 'ws://127.0.0.1:18789'
    const device = readJson(path.join(root, 'identity', 'device.json'))
    const auth = readJson(path.join(root, 'identity', 'device-auth.json'))
    const op = auth?.tokens?.operator
    if (url && device?.privateKeyPem && op?.token) return { root, url, device, op, mode: cfg.gateway?.mode }
  }
  return null
}

function signConnect (id, nonce, signedAt) {
  const payload = ['v2', id.device.deviceId, CLIENT_ID, CLIENT_MODE, 'operator',
    (id.op.scopes || []).join(','), String(signedAt), id.op.token, nonce].join('|')
  const key = crypto.createPrivateKey(id.device.privateKeyPem)
  return Buffer.from(crypto.sign(null, Buffer.from(payload, 'utf8'), key)).toString('base64url')
}

function publicKeyB64u (device) {
  const der = crypto.createPublicKey(device.publicKeyPem).export({ type: 'spki', format: 'der' })
  return Buffer.from(der.subarray(-32)).toString('base64url')   // raw Ed25519 key
}

// One connected session. Resolves once the gateway says hello.
export function connectGateway (id, { timeoutMs = 4500 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    // ⚠️ THE GATEWAY IS OFTEN ON ANOTHER MACHINE, SO THE CERTIFICATE HAS TO MEAN
    // SOMETHING. This carried `rejectUnauthorized: false`, which accepts any
    // certificate at all — self-signed, expired, wrong host. The file's own header
    // says the remote case is normal ("the machine running Radiant is often just a
    // client pointing at it"), so on a wss:// gateway that handed the operator
    // device token to anyone on the path, who could then relay to the real gateway
    // and read the whole session. A self-signed gateway needs a pinned `ca:` here,
    // not a switch that turns the check off.
    //
    // The token still goes in the query string because that is the gateway's own
    // protocol, not ours to change from this side — but it does mean the token
    // lands in any proxy or gateway access log. Worth moving to an Authorization
    // header on the OpenClaw side.
    const ws = new WebSocket(`${id.url}/?token=${encodeURIComponent(id.op.token)}`)
    const pending = new Map()
    const fail = e => { if (!settled) { settled = true; try { ws.close() } catch {}; reject(e) } }
    const timer = setTimeout(() => fail(new Error('gateway did not respond')), timeoutMs)

    const request = (method, params = {}) => new Promise((res, rej) => {
      const rid = crypto.randomUUID()
      pending.set(rid, { res, rej })
      ws.send(JSON.stringify({ type: 'req', id: rid, method, params }))
      setTimeout(() => { if (pending.delete(rid)) rej(new Error(`${method} timed out`)) }, timeoutMs)
    })

    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.type === 'event' && m.event === 'connect.challenge') {
        const nonce = m.payload?.nonce
        if (!nonce) return
        const signedAt = Date.now()
        request('connect', {
          minProtocol: PROTOCOL, maxProtocol: PROTOCOL,
          client: { id: CLIENT_ID, version: 'radiant', platform: process.platform, mode: CLIENT_MODE },
          role: 'operator', scopes: id.op.scopes || [],
          device: {
            id: id.device.deviceId, publicKey: publicKeyB64u(id.device),
            signature: signConnect(id, nonce, signedAt), signedAt, nonce
          },
          caps: ['tool-events'], auth: { deviceToken: id.op.token },
          userAgent: 'Radiant', locale: 'en-US'
        }).then(hello => {
          clearTimeout(timer); settled = true
          resolve({ hello, request, close: () => { try { ws.close() } catch {} } })
        }).catch(fail)
        return
      }
      if (m.type === 'res' && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id)
        if (m.error) rej(Object.assign(new Error(m.error.message || 'gateway error'), { gateway: m.error }))
        else res(m.payload)
      }
    })
    ws.on('error', e => fail(e))
    ws.on('close', (c, r) => fail(new Error(`gateway closed (${c}) ${r || ''}`.trim())))
  })
}

// ⚠️ DISCOVERY RUNS WHEN SETTINGS OPENS, SO IT MUST NOT BLOCK. An unreachable
// or stale gateway would otherwise stall the Agents pane for the full timeout.
// Short timeout, and cache the answer briefly so reopening Settings is instant.
let cache = { at: 0, value: null }
const CACHE_MS = 30000

// The fleet this gateway hosts. Returns {agents} or {error} — never throws, so
// discovery can report the real reason instead of silently showing nothing.
export async function listGatewayAgents () {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value
  const value = await probeGateway()
  cache = { at: Date.now(), value }
  return value
}

async function probeGateway () {
  const id = openclawIdentity()
  if (!id) return { error: null, agents: [] }          // OpenClaw not set up here
  let conn
  try {
    conn = await connectGateway(id)
    const payload = await conn.request('agents.list', {})
    const agents = payload?.agents || payload?.result?.agents || []
    return { url: id.url, agents }
  } catch (e) {
    const code = e.gateway?.details?.code || e.gateway?.code
    return { url: id.url, agents: [], error: friendlyError(code, e.message) }
  } finally { try { conn?.close() } catch {} }
}

function friendlyError (code, message) {
  if (code === 'AUTH_DEVICE_TOKEN_MISMATCH' || /device token mismatch/i.test(message || '')) {
    return "this Mac's OpenClaw device token is out of date — open OpenClaw here once to reissue it"
  }
  if (/closed \(1008\)|unauthorized/i.test(message || '')) return 'the gateway refused this device'
  if (/did not respond|timed out|ECONNREFUSED|EHOSTUNREACH/i.test(message || '')) return 'gateway unreachable'
  return message || 'could not reach the gateway'
}
