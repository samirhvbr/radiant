/**
 * What carries a cache breakpoint, and what must never carry one.
 *
 * ⚠️ THE FIRST VERSION OF THIS FEATURE WOULD HAVE COST MONEY AND SAVED NOTHING.
 * Prompt caching matches on an exact byte prefix. The breakpoint was placed on a
 * system prefix that included retrieved memory facts — which memory.js scores
 * against the CURRENT turn's text, so they differ almost every turn. Every
 * request would have written a fresh cache at 1.25x and read none of it back:
 * strictly worse than shipping no caching at all, for exactly the users it was
 * meant to help. It was caught in review rather than in a bill.
 *
 * That failure is invisible from the outside — the feature "works", requests
 * succeed, and the only symptom is a number nobody is looking at. So it is
 * pinned here as a property of the request we send: the volatile half sits
 * AFTER the marked block and is never marked itself.
 */
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { runTurn } = await import('../server/providers.js')
let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }
const dir = mkdtempSync(join(tmpdir(), 'rx-cache-'))

/** Run one turn against a stub and hand back the request body it sent. */
async function capture ({ type, providerId, model, cachingEnabled, cacheTtl, memory }) {
  let sent = null, headers = null
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c
    if (!sent) { sent = JSON.parse(body); headers = req.headers }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (type === 'anthropic') {
      res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 5 } } }) + '\n\n')
      res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) + '\n\n')
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }) + '\n\n')
      res.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n')
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\n')
    }
    res.write('data: [DONE]\n\n'); res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  await runTurn({
    provider: { id: providerId, type, baseUrl: `http://127.0.0.1:${server.address().port}` },
    model, apiKey: 'x',
    session: { cwd: dir, messages: [{ role: 'user', text: 'go' }] },
    useTools: true, computerControl: false, skills: [], persona: 'You are helpful.',
    memory: memory || null, cachingEnabled, cacheTtl,
    emit: () => {}, requestApproval: null, signal: new AbortController().signal
  })
  server.close()
  return { body: sent, headers }
}

const marks = o => JSON.stringify(o || {}).split('"cache_control"').length - 1

// ── the Anthropic path ──────────────────────────────────────────────────────
const FACTS = ['Tony prefers tabs over spaces', 'Tony ships Radiant from a Mac']
const { body: an } = await capture({ type: 'anthropic', providerId: 'anthropic', model: 'claude-opus-5', memory: FACTS })
ok('the system prompt is sent as blocks, not a bare string', Array.isArray(an.system))
ok('caching is on by default', marks(an.system) >= 1)

const marked = an.system.filter(b => b.cache_control)
ok('exactly one system block carries the breakpoint', marked.length === 1, `${marked.length} marked`)

// ⚠️ THE BUG THIS FEATURE ALMOST SHIPPED WITH.
const volatileBlocks = an.system.filter(b => FACTS.some(f => (b.text || '').includes(f)))
ok('the remembered facts are in the request at all', volatileBlocks.length === 1)
ok('...but NOT in the marked block — they change every turn, so a breakpoint there caches nothing',
   !FACTS.some(f => marked[0].text.includes(f)))
ok('...and they sit AFTER it, so their churn cannot reach the cached prefix',
   an.system.indexOf(volatileBlocks[0]) > an.system.indexOf(marked[0]))

ok('the message tail is cached by the documented top-level field', !!an.cache_control)

const { body: anOff } = await capture({ type: 'anthropic', providerId: 'anthropic', model: 'claude-opus-5', cachingEnabled: false, memory: FACTS })
ok('turning caching off marks nothing at all', marks(anOff.system) === 0 && !anOff.cache_control)
ok('and the prompt still carries everything it did before',
   FACTS.every(f => JSON.stringify(anOff.system).includes(f)))

const { headers: h1 } = await capture({ type: 'anthropic', providerId: 'anthropic', model: 'claude-opus-5', cacheTtl: '1h' })
ok('a one-hour cache asks for the beta header that enables it',
   (h1['anthropic-beta'] || '').includes('extended-cache-ttl'))
const { headers: h5 } = await capture({ type: 'anthropic', providerId: 'anthropic', model: 'claude-opus-5' })
ok('and the five-minute default does not', !(h5['anthropic-beta'] || '').includes('extended-cache-ttl'))

// ── the OpenAI-shaped paths ─────────────────────────────────────────────────
// OpenRouter passes Anthropic breakpoints through to Claude models. Nothing
// else on this path does, and an unrecognised field can be rejected outright.
const or = await capture({ type: 'openai', providerId: 'openrouter', model: 'anthropic/claude-opus-5' })
ok('OpenRouter Claude models are marked', marks(or.body.messages) >= 1)

const orPlain = await capture({ type: 'openai', providerId: 'openrouter', model: 'openai/gpt-5' })
ok('a non-Claude model on OpenRouter is not', marks(orPlain.body.messages) === 0)

const other = await capture({ type: 'openai', providerId: 'together', model: 'claude-opus-5' })
ok('and neither is a Claude-shaped name on some other provider', marks(other.body.messages) === 0)

// ⚠️ ONE SWITCH, EVERY PATH IT NAMES. Settings calls it "Prompt caching (Claude
// models)", and OpenRouter's Claude models are Claude models. Reading the flag
// in anthropicRound alone left this path caching after the user turned caching
// off — a switch that governs one provider and silently not another is worse
// than no switch, because you cannot tell which half you got.
const orOff = await capture({ type: 'openai', providerId: 'openrouter', model: 'anthropic/claude-opus-5', cachingEnabled: false })
ok('turning caching off reaches OpenRouter too, not just the Anthropic path',
   marks(orOff.body.messages) === 0)

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  the cached half never moves, and the switch reaches every path`)
process.exit(fail ? 1 : 0)
