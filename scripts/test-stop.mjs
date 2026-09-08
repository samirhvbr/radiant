// Does Stop actually stop?
//
// ⚠️ THE ONLY ABORT CHECK IN runTurn USED TO SIT AFTER THE APPROVAL PROMPT. So a
// turn found out it had been cancelled when the NEXT model request rejected —
// meaning every remaining tool in the round still ran, and a shell command ran to
// completion or to its 120-second timeout. Tony: "the stop button does not seem
// to be doing anything… agent just keeps talking and talking."
//
// This drives runTurn directly with a stub provider, so it needs no key, no
// network and no model: the question is whether the loop honours the signal.
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, console.log(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }

const dir = mkdtempSync(join(tmpdir(), 'rx-stop-'))
const marker = join(dir, 'ran-after-stop.txt')

const { runTool } = await import('../server/tools.js')

// ── a running command is killed, not merely ignored ─────────────────────────
{
  const ctl = new AbortController()
  const started = Date.now()
  const p = runTool('run_command', { command: `sleep 8; touch ${marker}` }, dir, ctl.signal)
  setTimeout(() => ctl.abort(), 300)
  const out = await p
  const took = Date.now() - started
  ok('a running command is killed when the turn is stopped', took < 3000, `took ${took}ms`)
  ok('and it says it was stopped', /stopped by you/.test(out), JSON.stringify(out).slice(0, 120))
  // ⚠️ THE ASSERTION THAT EARNS ITS KEEP. Returning early proves the PROMISE
  // resolved, not that the process died. If the child survived, the file appears
  // a few seconds later.
  await new Promise(r => setTimeout(r, 9000))
  ok('the process is really dead, not just abandoned', !existsSync(marker))
}

// ── the turn stops between tools, not after all of them ────────────────────
// ⚠️ A REAL HTTP STUB, NOT A SEAM IN THE PRODUCT. runTurn talks to an
// OpenAI-shaped endpoint, so the fake is one: a tiny server that streams a
// single round asking for three shell commands. That exercises the actual
// openaiRound parsing and the actual tool loop — a `__testRound` hook would have
// tested neither, and would have put a test-only branch in the run engine.
{
  const http = await import('node:http')
  const chunks = []
  const push = o => chunks.push(`data: ${JSON.stringify(o)}\n\n`)
  for (const [i, cmd] of [['sleep 3'], ['echo two'], ['echo three']].entries()) {
    push({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: 't' + i, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: cmd[0] }) } }] } }] })
  }
  push({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  const done = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'all done' }, finish_reason: 'stop' }] }) + '\n\n'
  // ⚠️ ONE ROUND OF TOOLS, THEN TALK. A stub that answers every round the same way
  // runs to MAX_ROUNDS — thirty rounds with a sleep in them is a five-minute test.
  const serve = () => { let n = 0; return (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (n++ === 0) for (const c of chunks) res.write(c)
    else res.write(done)
    res.write('data: [DONE]\n\n')
    res.end()
  } }
  const server = http.createServer(serve())
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const { runTurn } = await import('../server/providers.js')
  const ctl = new AbortController()
  const started = []
  let stoppedEvent = false
  const session = { cwd: dir, messages: [{ role: 'user', text: 'go' }] }
  await runTurn({
    provider: { id: 'stub', type: 'openai', baseUrl: `http://127.0.0.1:${port}` },
    model: 'stub', apiKey: 'x', session, useTools: true, computerControl: false,
    skills: [], persona: '',
    emit: ev => {
      if (ev.type === 'tool_start') {
        started.push(ev.args.command)
        // ⚠️ ABORT WHILE THE FIRST TOOL IS RUNNING, not before it starts. Aborting
        // on the tool_start event lands before that tool's own approval check, so
        // the turn returns without running anything — which proves nothing about
        // what happens to the tools AFTER a long one gets cancelled. The first
        // command sleeps; Stop arrives in the middle of it.
        if (started.length === 1) setTimeout(() => ctl.abort(), 400)
      }
      if (ev.type === 'stopped') stoppedEvent = true
    },
    requestApproval: null, signal: ctl.signal
  })
  server.close()

  ok('the turn reports that it stopped', stoppedEvent, 'no stopped event')
  // Aborted while the first tool ran — the other two must never start.
  ok('the rest of the round is not even started after Stop', started.length === 1,
     `started ${started.length}: ${started.join(', ')}`)

  // ⚠️ THE CONTROL, WITHOUT WHICH THE ASSERTION ABOVE IS WORTH NOTHING. "Only
  // one tool ran" is exactly what a stub that produced only ONE tool would also
  // show. Same server, same round, no abort: all three have to run, or the
  // interesting case was never set up.
  const server2 = http.createServer(serve())
  await new Promise(r => server2.listen(0, '127.0.0.1', r))
  const all = []
  await runTurn({
    provider: { id: 'stub', type: 'openai', baseUrl: `http://127.0.0.1:${server2.address().port}` },
    model: 'stub', apiKey: 'x', session: { cwd: dir, messages: [{ role: 'user', text: 'go' }] },
    useTools: true, computerControl: false, skills: [], persona: '',
    emit: ev => { if (ev.type === 'tool_start') all.push(ev.args.command) },
    requestApproval: null, signal: new AbortController().signal
  })
  server2.close()
  // The stub answers every round the same way, so it runs to MAX_ROUNDS — what
  // matters is that the FIRST round ran all three, which is the case Stop cuts short.
  ok('with no Stop, all three tools of a round do run',
     all.slice(0, 3).join('|') === 'sleep 3|echo two|echo three', `first three: ${all.slice(0, 3).join(', ')}`)
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass}/${pass + fail} passed  ·  Stop stops the tools, not just the next model call`)
process.exit(fail ? 1 : 0)
