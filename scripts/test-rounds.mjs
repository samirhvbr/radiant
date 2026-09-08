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

const { runTurn } = await import('../server/providers.js')
let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }
const dir = mkdtempSync(join(tmpdir(), 'rx-rounds-'))

/** A stub model. `plan(i)` returns the tool calls for round i, or null to stop. */
async function drive (plan) {
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
    session: { cwd: dir, messages: [{ role: 'user', text: 'go' }] },
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

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  long work finishes; a stuck agent is stopped and says so`)
process.exit(fail ? 1 : 0)
