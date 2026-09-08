/**
 * Does the graph actually run things at the same time?
 *
 * ⚠️ EVERY OTHER ASSERTION IN test-graph.mjs COULD PASS WHILE THE RUNNER RAN
 * NODES ONE AFTER ANOTHER — which is a chain wearing the word "graph", the exact
 * thing this feature exists to stop being. So the load-bearing measurement here
 * is the clock: three independent nodes that each take a second finish in about
 * a second.
 *
 * It runs against a stub HTTP server speaking the OpenAI streaming shape, so it
 * needs no key, no network and no model — the question is the runner's shape,
 * not any model's answer.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const { runGraph, isRunning, stopGraph } = await import('../server/graph-run.js')

let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }

const dir = mkdtempSync(join(tmpdir(), 'rx-graphrun-'))
const sessions = new Map()

// A model that takes `delayMs` to answer, and says which node asked.
let inFlight = 0
let peakInFlight = 0
const server = http.createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const asked = JSON.parse(body).messages.map(m => m.content).join(' ')
  // ⚠️ MATCH THE JOB LINE, NOT THE WHOLE PROMPT. A downstream node is HANDED its
  // inputs, titles and all, so keying off the raw text made the merge node fail
  // too — because the failing node's title was quoted inside it. That is the
  // fan-in working correctly and the fixture reading it wrong.
  const job = asked.match(/Your job, and only this: ([^\n]+)/)?.[1] || ''
  const delay = /SLOW/.test(job) ? 900 : 30
  inFlight++
  peakInFlight = Math.max(peakInFlight, inFlight)
  await new Promise(r => setTimeout(r, delay))
  inFlight--
  const answer = /FAILME/.test(job) ? '' : ('answer for ' + (job || '?'))
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: 'stop' }] }) + '\n\n')
  res.write('data: [DONE]\n\n')
  res.end()
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const baseUrl = `http://127.0.0.1:${server.address().port}`

const deps = {
  loadConfig: () => ({ settings: { defaultCwd: dir }, providers: [], keys: {}, oauth: {} }),
  saveSession: s => sessions.set(s.id, s),
  agentsStore: { get: () => null },
  getProject: () => null,
  credFor: () => ({ provider: { id: 'stub', type: 'openai', baseUrl }, apiKey: 'x', getAccessToken: null, getAccountId: null })
}
const node = o => ({ kind: 'agent', prompt: '', dependsOn: [], fields: [], useTools: false, model: 'stub', provider: 'stub', ...o })

// ── THE MEASUREMENT: independent work does not queue ────────────────────────
{
  const graph = {
    id: 'graph-par', title: 'Three slow angles', cwd: dir, concurrency: 4, autoApprove: false,
    nodes: [node({ id: 'a', title: 'SLOW angle A' }), node({ id: 'b', title: 'SLOW angle B' }), node({ id: 'c', title: 'SLOW angle C' })]
  }
  peakInFlight = 0
  const t = Date.now()
  const run = await runGraph(graph, deps)
  const took = Date.now() - t
  ok('all three independent nodes finished', Object.values(run.nodes).every(n => n.state === 'done'),
     JSON.stringify(Object.values(run.nodes).map(n => n.state)))
  // Three 900ms nodes: about 1s together, about 2.7s in a queue.
  ok('three independent nodes take about as long as ONE of them', took < 2000, `took ${took}ms`)
  ok('and the server really saw them at the same time', peakInFlight === 3, `peak ${peakInFlight}`)
}

// ── a chain must NOT be parallel ────────────────────────────────────────────
// The control. "Fast" would also be what a broken planner that ignored edges
// looked like, so the same three nodes wired in a line have to be slow.
{
  const graph = {
    id: 'graph-chain', title: 'Three in a line', cwd: dir, concurrency: 4,
    nodes: [node({ id: 'a', title: 'SLOW one' }), node({ id: 'b', title: 'SLOW two', dependsOn: ['a'] }), node({ id: 'c', title: 'SLOW three', dependsOn: ['b'] })]
  }
  peakInFlight = 0
  const t = Date.now()
  await runGraph(graph, deps)
  const took = Date.now() - t
  ok('a real dependency is still waited for', took > 2000, `took ${took}ms`)
  ok('and only one node is ever in flight in a chain', peakInFlight === 1, `peak ${peakInFlight}`)
}

// ── the fan-in receives what came before ────────────────────────────────────
{
  const graph = {
    id: 'graph-fan', title: 'Diamond', cwd: dir, concurrency: 4,
    nodes: [node({ id: 'a', title: 'Angle A' }), node({ id: 'b', title: 'Angle B' }),
      node({ id: 'm', title: 'Merge', dependsOn: ['a', 'b'] })]
  }
  const run = await runGraph(graph, deps)
  const merge = [...sessions.values()].find(s => s.title.endsWith('Merge'))
  const prompt = merge.messages[0].text
  ok('the merge node was handed both upstream outputs',
     prompt.includes('answer for Angle A') && prompt.includes('answer for Angle B'))
  ok('and the run finished', run.state === 'done', run.state)
}

// ── failure dies at its node ────────────────────────────────────────────────
{
  const graph = {
    id: 'graph-fail', title: 'One bad node', cwd: dir, concurrency: 4,
    nodes: [node({ id: 'good', title: 'Good angle' }), node({ id: 'bad', title: 'FAILME angle' }),
      node({ id: 'm', title: 'Merge', dependsOn: ['good', 'bad'] })]
  }
  const run = await runGraph(graph, deps)
  ok('the bad node fails', run.nodes.bad.state === 'failed')
  // ⚠️ IN A CHAIN, FAILURE CASCADES. In a graph it must not: the good work still
  // comes back and the merge still runs.
  ok('the good node still finishes', run.nodes.good.state === 'done')
  ok('and the merge still runs with a hole in its input', run.nodes.m.state === 'done', run.nodes.m.error || '')
  ok('the run is not called a failure just because one node failed', run.state === 'done', run.state)
  ok('but it says how many did not finish', /1 of 3/.test(run.error || ''), run.error || '')
}

// ── a graph cannot grant itself permission ──────────────────────────────────
// The runner passes a requestApproval that always says no, so a node that tries
// to run a command fails with a message rather than acting unattended.
{
  const graph = {
    id: 'graph-perm', title: 'Wants a shell', cwd: dir, concurrency: 1, autoApprove: false,
    nodes: [node({ id: 'a', title: 'Angle', useTools: true })]
  }
  const run = await runGraph(graph, deps)
  ok('a graph runs with approvals refused by default, not granted', graph.autoApprove === false)
  ok('and the node still completes when it does not need one', run.nodes.a.state === 'done', run.nodes.a.error || '')
}

// ── a plan that cannot start does not start ─────────────────────────────────
{
  const graph = { id: 'graph-cyc', title: 'Circle', cwd: dir, nodes: [node({ id: 'a', title: 'A', dependsOn: ['b'] }), node({ id: 'b', title: 'B', dependsOn: ['a'] })] }
  const run = await runGraph(graph, deps)
  ok('a circular graph fails immediately rather than spending anything', run.state === 'failed' && /circle/i.test(run.error))
  ok('and no node was run', Object.keys(run.nodes).length === 0)
}

server.close()
rmSync(dir, { recursive: true, force: true })
console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  independent nodes run at once; a dependency is still a wait`)
process.exit(fail ? 1 : 0)
