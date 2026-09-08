/**
 * A long job finishes; a stuck one is stopped.
 *
 * ⚠️ THE ROUND CAP WAS 30, AND 30 IS SMALLER THAN AN ORDINARY JOB. Asked to pull
 * a page of skills and install them, the turn that was actually doing it spent
 * 14 fetch_url and 13 write_file calls — 27 of its 30 rounds on the work itself
 * — and was cut off mid-install. Three turns before it went the same way.
 *
 * A round cap is a backstop against looping forever. It is not a work budget.
 * The thing that tells "working" from "stuck" is identical-call detection, which
 * existed the whole time and only ever printed a nudge. These are the two cases
 * that have to come out differently, so they are the two cases here.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const { runTurn, foldOldToolResults } = await import('../server/providers.js')
let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }
const dir = mkdtempSync(join(tmpdir(), 'rx-rounds-'))

/** A stub model. `plan(i)` returns the tool calls for round i, or null to stop. */
async function drive (plan, session) {
  let round = 0
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c
    const calls = plan(round++)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (!calls) {
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'all done' }, finish_reason: 'stop' }] }) + '\n\n')
    } else {
      calls.forEach((c, i) => res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `t${round}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] }) + '\n\n'))
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n')
    }
    res.write('data: [DONE]\n\n'); res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const seen = { tools: 0, halt: null, done: false }
  await runTurn({
    provider: { id: 'stub', type: 'openai', baseUrl: `http://127.0.0.1:${server.address().port}` },
    model: 'stub', apiKey: 'x',
    session: session || { cwd: dir, messages: [{ role: 'user', text: 'go' }] },
    useTools: true, computerControl: false, skills: [], persona: '',
    emit: ev => {
      if (ev.type === 'tool_start') seen.tools++
      if (ev.type === 'halt') seen.halt = ev
      if (ev.type === 'done') seen.done = true
    },
    requestApproval: null, signal: new AbortController().signal
  })
  server.close()
  return { ...seen, rounds: round }
}

// ── real work, well past the old cap, must finish ───────────────────────────
// 40 rounds of DIFFERENT work: exactly the shape of "fetch a skill, write a
// skill", forty times. Under the old cap this died at 30 with nothing to show.
{
  const r = await drive(i => (i < 40 ? [{ name: 'read_file', args: { path: join(dir, 'f' + i + '.txt') } }] : null))
  ok('a job that needs 40 rounds of real work runs to the end', r.done && !r.halt, r.halt ? 'halted: ' + r.halt.reason : '')
  ok('and every one of those rounds actually ran', r.tools === 40, `${r.tools} tool calls`)
}

// ── a stuck agent is stopped, and told why ──────────────────────────────────
// ⚠️ THE NUDGE WAS THE WHOLE ENFORCEMENT, and a nudge is a suggestion. The same
// call, forever, is what a runaway actually looks like.
{
  const r = await drive(() => [{ name: 'read_file', args: { path: join(dir, 'same.txt') } }])
  ok('an agent repeating one call is stopped', Boolean(r.halt), 'no halt')
  ok('and the reason says stuck, not that it ran out of rounds', r.halt?.reason === 'stuck', r.halt?.reason)
  // Well before the 200 backstop — the point is that the DETECTOR stopped it.
  ok('it is stopped quickly, not after 200 rounds', r.rounds < 30, `${r.rounds} rounds`)
  ok('the explanation names the tool', /read_file/.test(r.halt?.text || ''))
  ok('and says the work above is kept', /saved/i.test(r.halt?.text || ''))
}

// ── the backstop still exists ───────────────────────────────────────────────
// Varied calls forever: the repeat detector never fires, so the round cap is
// what has to stop it. It must still be there, just far out of the way.
{
  const r = await drive(i => [{ name: 'read_file', args: { path: join(dir, 'v' + i + '.txt') } }])
  ok('an agent that never repeats is still stopped eventually', Boolean(r.halt), 'ran forever')
  ok('by the round backstop', r.halt?.reason === 'rounds', r.halt?.reason)
  ok('at 200, not 30', r.rounds > 100, `${r.rounds} rounds`)
}

// ── a long-lived chat must still be able to run a turn ──────────────────────
// ⚠️ THE BUDGET COUNTER IS THE SESSION'S WHOLE LIFE, NOT THIS TURN'S. Shipped a
// "per turn" ceiling compared against the running total, so a chat that had ever
// spent more than the limit halted INSTANTLY on every turn after — zero tool
// calls, no work done, and "keep going" could never do anything. Tony's chat had
// 29.8M tokens behind it against a 2M limit: permanently bricked, and strictly
// worse than the round cap it replaced.
{
  const heavy = {
    cwd: dir,
    messages: [{ role: 'user', text: 'go' }],
    // Ten times the ceiling, already spent, before this turn starts.
    stats: { turns: 40, inTokens: 20_000_000, outTokens: 200_000, llmMs: 0, toolMs: 0 }
  }
  const r = await drive(i => (i < 3 ? [{ name: 'read_file', args: { path: join(dir, 'x' + i + '.txt') } }] : null), heavy)
  ok('a chat with 20M tokens of history can still run a turn', r.done && !r.halt,
     r.halt ? `halted immediately: ${r.halt.reason}` : '')
  ok('and the work in it actually happens', r.tools === 3, `${r.tools} tool calls`)
}

// ── old tool results do not ride along forever ──────────────────────────────
// ⚠️ 98% OF A REAL CHAT WAS TOOL RESULTS. 540,000 characters, of which 1,739
// were things Tony typed; fetch_url alone was half, as five raw API responses
// kept whole and re-sent every round. 135k tokens a request x 30 rounds a turn.
{
  const big = 'y'.repeat(40_000)
  const msgs = Array.from({ length: 12 }, () => ({ role: 'assistant', parts: [{ type: 'tool', name: 'fetch_url', result: big }] }))
  const folded = foldOldToolResults(msgs)
  const before = JSON.stringify(msgs).length, after = JSON.stringify(folded).length
  ok('an old heavy result is folded down', after < before / 1.5, `${before} -> ${after}`)
  // ⚠️ THE RECENT ONES MUST SURVIVE WHOLE. That is the window the agent is still
  // working in; trimming there would make it re-run what it just did.
  ok('the last six messages keep their results in full',
     folded.slice(-6).every(m => m.parts[0].result.length === 40_000))
  ok('and the trimmed ones say so, naming the tool',
     /trimmed/.test(folded[0].parts[0].result) && /fetch_url/.test(folded[0].parts[0].result))
  // Nothing is destroyed — this shapes the REQUEST, not the transcript.
  ok('the original messages are untouched', msgs[0].parts[0].result.length === 40_000)
  ok('a short chat is returned exactly as it was',
     foldOldToolResults(msgs.slice(0, 3)) === msgs.slice(0, 3) || JSON.stringify(foldOldToolResults(msgs.slice(0, 3))) === JSON.stringify(msgs.slice(0, 3)))
  ok('a small result is left alone',
     foldOldToolResults(Array.from({ length: 12 }, () => ({ role: 'assistant', parts: [{ type: 'tool', name: 'read_file', result: 'tiny' }] })))[0].parts[0].result === 'tiny')
}

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  long work finishes; a stuck agent is stopped and says so`)
process.exit(fail ? 1 : 0)
