/**
 * Can a web page you did not open drive your agent?
 *
 * ⚠️ THE SERVER TRUSTS EVERY LOOPBACK REQUEST, AND THE CORS LAYER REFLECTS ANY
 * ORIGIN. Together those mean an ordinary page in the user's browser — nothing
 * to do with Radiant — can fetch http://127.0.0.1:5834/api/config, read the
 * reply (because Access-Control-Allow-Origin comes back as that page's own
 * origin), and go on to drive /api/chat. No token is needed: the request looks
 * local. This asserts the door is shut, and it is the regression test for the
 * whole class.
 *
 * Same-origin and no-Origin requests MUST keep working — that is the app's own
 * UI and the phone over Tailscale, and breaking them is worse than the hole.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 5893
const dir = mkdtempSync(join(tmpdir(), 'rx-origin-'))
// ⚠️ SEED A CREDENTIAL, or the redaction assertions below pass vacuously on an
// empty profile and prove nothing. This is a fake token in a throwaway dir.
writeFileSync(join(dir, 'config.json'), JSON.stringify({
  settings: {},
  mcpServers: [{ id: 'probe', name: 'probe', url: 'https://example.invalid/mcp',
                 token: 'mcp-secret-should-never-reach-a-browser',
                 env: { PROBE_API_KEY: 'env-secret-should-never-reach-a-browser' } }]
}, null, 2))
const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, RADIANT_PORT: String(PORT), RADIANT_DIR: dir, NODE_ENV: 'production' },
  stdio: 'ignore'
})
process.on('exit', () => server.kill())
const base = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(base)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 250))
}

let pass = 0, fail = 0
const results = []
const ok = (name, cond, detail = '') => {
  cond ? pass++ : (fail++, results.push(`  FAIL ${name}${detail ? '\n        ' + detail : ''}`))
}

const get = (headers) => fetch(`${base}/api/config`, { headers })

// ── the hole ────────────────────────────────────────────────────────────────
const evil = await get({ Origin: 'https://evil.example.com' })
ok('a third-party origin is refused', evil.status === 401 || evil.status === 403,
   `got HTTP ${evil.status}`)
ok('a third-party origin gets no Access-Control-Allow-Origin',
   evil.headers.get('access-control-allow-origin') === null,
   `got ${evil.headers.get('access-control-allow-origin')}`)

// ── the three ways through the first fix ────────────────────────────────────
// ⚠️ THE FIRST GATE COMPARED ORIGIN AGAINST THE HOST HEADER. Both are sent by
// the client, so it only asked whether the request agreed with itself, and any
// name an attacker controls satisfies that. Measured against the shipped build:
// a plain third-party Origin correctly returned 401, and each of these returned
// 200. The expected origin is built at boot now and never read off the request.
const rebind = await get({ Host: `attacker.example:${PORT}`, Origin: `http://attacker.example:${PORT}` })
ok('a page claiming to be the address it is calling is refused (DNS rebinding)',
   rebind.status === 401 || rebind.status === 403, `got HTTP ${rebind.status}`)

// Any extension was trusted as a group, which reached /api and the /term socket
// — a pty. The Radiant extension only ever opens /ws/extension, so that is the
// one place an extension origin is accepted now.
const anyExt = await get({ Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
ok('an unrelated browser extension is refused', anyExt.status === 401 || anyExt.status === 403,
   `got HTTP ${anyExt.status}`)

// A browser omits Origin on a no-cors subresource load, so `<img src=…>` counted
// as "no Origin, therefore the app itself". Sec-Fetch-* is what tells them apart:
// browsers always send it, curl and the iOS client never do.
const asImage = await get({
  Host: `127.0.0.1:${PORT}`,
  'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image'
})
ok('a page loading a Radiant URL as an image is refused',
   asImage.status === 401 || asImage.status === 403, `got HTTP ${asImage.status}`)

// ── what must not regress ───────────────────────────────────────────────────
const bare = await get({})
ok('a request with no Origin still works (the app itself)', bare.status === 200, `got HTTP ${bare.status}`)
const same = await get({ Origin: base })
ok('a same-origin request still works', same.status === 200, `got HTTP ${same.status}`)
const fetched = await get({ Host: `127.0.0.1:${PORT}`, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' })
ok('the app window\'s own fetch still works', fetched.status === 200, `got HTTP ${fetched.status}`)
const named = await get({ Host: `localhost:${PORT}`, Origin: `http://localhost:${PORT}` })
ok('localhost spelt out still works', named.status === 200, `got HTTP ${named.status}`)

// ── the dev-proxy exemption must not exist in a shipped build ───────────────
// ⚠️ THIS IS A HOLE THAT IS SUPPOSED TO BE SHUT. `npm run dev` serves the UI
// from Vite on another port, which makes every write cross-origin — reads passed
// and writes came back 401, because a browser omits Origin on a same-origin GET
// and sends it on a POST. RADIANT_DEV_ORIGIN reopens the door for exactly one
// origin. The server above runs WITHOUT it, so this asserts the door is shut
// when nobody asked for it; the second server asserts the variable is what opens
// it, rather than something else having quietly started working.
const vite = await get({ Host: `localhost:5833`, Origin: 'http://localhost:5833' })
ok('the dev origin is refused when RADIANT_DEV_ORIGIN is not set',
   vite.status === 401 || vite.status === 403, `got HTTP ${vite.status}`)

const DEV_PORT = PORT + 1
const devServer = spawn('node', ['server/index.js'], {
  env: { ...process.env, RADIANT_PORT: String(DEV_PORT), RADIANT_DIR: dir, NODE_ENV: 'production',
         RADIANT_DEV_ORIGIN: 'http://localhost:5833' },
  stdio: 'ignore'
})
process.on('exit', () => devServer.kill())
const devBase = `http://127.0.0.1:${DEV_PORT}`
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(devBase)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 250))
}
const devGet = h => fetch(`${devBase}/api/config`, { headers: h })
const devOk = await devGet({ Host: 'localhost:5833', Origin: 'http://localhost:5833' })
ok('with RADIANT_DEV_ORIGIN set, that one origin is allowed', devOk.status === 200, `got HTTP ${devOk.status}`)
// It names ONE origin. Setting it must not reopen the door generally.
const devEvil = await devGet({ Origin: 'https://evil.example.com' })
ok('and it does not let anything else through',
   devEvil.status === 401 || devEvil.status === 403, `got HTTP ${devEvil.status}`)
const devOther = await devGet({ Host: 'localhost:5999', Origin: 'http://localhost:5999' })
ok('nor another port on loopback',
   devOther.status === 401 || devOther.status === 403, `got HTTP ${devOther.status}`)
devServer.kill()

// ── credentials must not ride along in the config payload ───────────────────
if (bare.status === 200) {
  const cfg = await bare.json()
  const mcp = JSON.stringify(cfg.mcpServers || [])
  const whole = JSON.stringify(cfg)
  ok('the seeded MCP bearer token is not in the payload',
     !whole.includes('mcp-secret-should-never-reach-a-browser'))
  ok('the seeded MCP env secret is not in the payload',
     !whole.includes('env-secret-should-never-reach-a-browser'))
  ok('the MCP server itself is still listed (redacted, not removed)',
     Array.isArray(cfg.mcpServers) && cfg.mcpServers.length === 1)
}

server.kill()
console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  a page you did not open cannot drive the agent`)
process.exit(fail ? 1 : 0)
