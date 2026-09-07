// The loop runner's server side, exercised against a Radiant this script starts.
//
// ⚠️ THE PUMP IS THE RISKIEST CODE IN THE FEATURE and none of it is reachable
// from the pure tests in test-loops.mjs: which step runs next, whether a fresh
// session is made for a retry, whether the attempt cap actually stops anything.
// All of that is decided from the transcript on disk, which means it can be
// tested by writing the transcript — no model, no key, no network.
//
// ⚠️ AND NOT ON PORT 5834. Radiant.app owns that whenever it is open, so a gate
// pointed there runs against the INSTALLED build and writes into Tony's real
// chats. Own server, own data directory — same rule as test-tasks.mjs.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'radiant-looprun-'))
const PORT = 5851
const B = `http://127.0.0.1:${PORT}`
const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, RADIANT_DIR: dir, RADIANT_PORT: String(PORT) },
  stdio: 'ignore'
})
const stop = () => { try { server.kill() } catch {}; try { rmSync(dir, { recursive: true, force: true }) } catch {} }
process.on('exit', stop)
let ready = false
for (let i = 0; i < 120; i++) {
  try { const r = await fetch(B + '/api/version'); if (r.ok && (await r.json())?.version) { ready = true; break } } catch {}
  await new Promise(r => setTimeout(r, 250))
}
if (!ready) { console.log('  the test server never came up'); stop(); process.exit(1) }

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, console.log(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }
const j = async (m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })
  return r.json().catch(() => null)
}
/** Put words in the agent's mouth: what the turn would have written. */
const say = (sid, text) => {
  const f = join(dir, 'sessions', sid + '.json')
  const s = JSON.parse(readFileSync(f, 'utf8'))
  s.messages.push({ role: 'assistant', parts: [{ type: 'text', text }] })
  writeFileSync(f, JSON.stringify(s, null, 2))
}

// ── one loop, one failed check, one retry, one pass ─────────────────────────
const loop = await j('POST', '/api/loops', {
  title: 'Ship the parser',
  cwd: '/tmp',
  steps: [
    { title: 'Write it', check: 'the tests pass', maxAttempts: 2 },
    { title: 'Tidy up' }                       // deliberately unchecked
  ]
})
await j('POST', `/api/loops/${loop.id}/start`)

let a = await j('POST', `/api/loops/${loop.id}/advance`)
ok('the first advance hands back work', a.action === 'work', a.action)
ok('the work prompt states the finish condition', a.prompt.includes('the tests pass'))
ok('and does not yet mention a failure', !/previous attempt/i.test(a.prompt))
const s1 = a.sessionId

say(s1, 'Done, I wrote the parser.')
a = await j('POST', `/api/loops/${loop.id}/advance`)
ok('after the turn it asks for a check', a.action === 'check', a.action)
ok('the check runs where the work is', a.sessionId === s1)

say(s1, 'I looked at the suite.\nVERDICT: FAIL — the tests were never run')
a = await j('POST', `/api/loops/${loop.id}/advance`)
ok('a failed check retries the step', a.action === 'work', a.action)
ok('the retry carries the reason', /the tests were never run/.test(a.prompt))
// ⚠️ A RETRY GETS A FRESH CONVERSATION. Reusing the session left the failed
// attempt in context and the model treated its own earlier answer as settled.
ok('the retry gets a fresh conversation', a.sessionId !== s1)
ok('the attempt count moved on', a.loop.steps[0].attempts === 2, String(a.loop.steps[0].attempts))

say(a.sessionId, 'Ran them this time.')
a = await j('POST', `/api/loops/${loop.id}/advance`)
say(a.sessionId, 'VERDICT: PASS')
a = await j('POST', `/api/loops/${loop.id}/advance`)
ok('a passing check moves to the next step', a.action === 'work' && /Step 2 of 2/.test(a.prompt), a.action)
ok('the first step is recorded as passed', a.loop.steps[0].state === 'passed', a.loop.steps[0].state)

say(a.sessionId, 'Tidied.')
a = await j('POST', `/api/loops/${loop.id}/advance`)
ok('an unchecked step finishes when its turn ends', a.action === 'done', a.action)
ok('and the loop is done', a.loop.state === 'done', a.loop.state)

// ── a step that can never pass has to stop ──────────────────────────────────
const l2 = await j('POST', '/api/loops', { title: 'Impossible', steps: [{ title: 'Do it', check: 'never', maxAttempts: 2 }] })
await j('POST', `/api/loops/${l2.id}/start`)
let tries = 0, ended = null
for (let i = 0; i < 12 && !ended; i++) {
  const r = await j('POST', `/api/loops/${l2.id}/advance`)
  if (r.action === 'work') { tries++; say(r.sessionId, 'tried'); continue }
  if (r.action === 'check') { say(r.sessionId, 'VERDICT: FAIL — still no'); continue }
  ended = r
}
ok('a step that cannot pass stops', ended?.action === 'failed', ended?.action)
ok('after exactly the attempts it was allowed', tries === 2, String(tries))
ok('and the step says why', /still no/.test(ended?.loop.steps[0].lastFail || ''), ended?.loop.steps[0].lastFail)

// ⚠️ A CHECK THAT ANSWERS NEITHER WORD IS NOT A PASS. This is the failure that
// would make the whole layer worthless: the one case where the check did not
// happen is the one where it must not report the step done.
const l3 = await j('POST', '/api/loops', { title: 'Mumbles', steps: [{ title: 'Do it', check: 'x', maxAttempts: 1 }] })
await j('POST', `/api/loops/${l3.id}/start`)
let r3 = await j('POST', `/api/loops/${l3.id}/advance`); say(r3.sessionId, 'did it')
r3 = await j('POST', `/api/loops/${l3.id}/advance`); say(r3.sessionId, 'Looks fine to me!')
r3 = await j('POST', `/api/loops/${l3.id}/advance`)
ok('a check that never says PASS or FAIL is not a pass', r3.action === 'failed', r3.action)

// ── a run in flight is not editable ─────────────────────────────────────────
// Rewriting the steps leaves the index pointing at a step that no longer exists
// and the attempt counts belonging to prompts that are gone.
const l4 = await j('POST', '/api/loops', { title: 'Busy', steps: [{ title: 'a' }, { title: 'b' }] })
await j('POST', `/api/loops/${l4.id}/start`)
const edit = await j('PATCH', `/api/loops/${l4.id}`, { steps: [{ title: 'c' }] })
ok('a running loop refuses a step rewrite', Boolean(edit.error), JSON.stringify(edit).slice(0, 80))
await j('POST', `/api/loops/${l4.id}/stop`)
const edit2 = await j('PATCH', `/api/loops/${l4.id}`, { steps: [{ title: 'c' }] })
ok('and accepts it once stopped', edit2.steps?.length === 1 && edit2.steps[0].title === 'c')
// A loop with no steps could never run and could never be fixed from the UI.
const empty = await j('POST', '/api/loops', { title: 'Nothing', steps: [] })
ok('a loop with no steps is refused', Boolean(empty.error))
// An advance on a loop nobody started must not start one.
const idle = await j('POST', `/api/loops/${l4.id}/advance`)
ok('advancing a loop that is not running does nothing', idle.action === 'idle', idle.action)

stop()
console.log(`\n${pass}/${pass + fail} passed  ·  the loop retries what fails and stops when it cannot pass`)
process.exit(fail ? 1 : 0)
