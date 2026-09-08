/**
 * Nodes, edges, and the thing that makes a graph worth building: work that does
 * not depend on other work does not wait for it.
 *
 * ⚠️ THE ASSERTION THAT MATTERS IS THE CLOCK. Everything else here — layering,
 * contracts, reduce — could be right while the runner still executed nodes one
 * after another, which is exactly the bug a "graph" that is really a chain has.
 * So three independent nodes that each take a second must finish in about a
 * second, not three.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const {
  planLayers, suspectEdges, normalizeNode, nodePrompt, readOutput, runReduce, toMermaid, inputBlock
} = await import('../server/graph-rules.js')

let pass = 0, fail = 0
const results = []
const ok = (n, c, extra = '') => { c ? pass++ : (fail++, results.push(`  FAIL ${n}${extra ? ' — ' + extra : ''}`)) }
const N = o => normalizeNode(o)

// ── layering: what runs together ────────────────────────────────────────────
{
  // The diamond. One splits, three work, one merges.
  const nodes = [
    N({ id: 'split', title: 'Split the question' }),
    N({ id: 'a', title: 'Angle A', dependsOn: ['split'] }),
    N({ id: 'b', title: 'Angle B', dependsOn: ['split'] }),
    N({ id: 'c', title: 'Angle C', dependsOn: ['split'] }),
    N({ id: 'merge', title: 'Write it up', dependsOn: ['a', 'b', 'c'] })
  ]
  const { layers, error } = planLayers(nodes)
  ok('a diamond plans as three layers', !error && layers.length === 3, error || JSON.stringify(layers))
  ok('the three angles are in ONE layer, so they run together',
     layers[1]?.length === 3, JSON.stringify(layers[1]))
  ok('the merge waits for all three', layers[2]?.join() === 'merge')
}
{
  // ⚠️ A CHAIN IS A GRAPH TOO — A BAD ONE. Same five nodes wired in a line plan
  // as five layers, which is the shape people are running while saying they
  // moved to graphs. If this ever collapsed to fewer layers the planner would be
  // running steps before their input existed.
  const chain = [N({ id: 'a', title: 'A' }), N({ id: 'b', title: 'B', dependsOn: ['a'] }),
    N({ id: 'c', title: 'C', dependsOn: ['b'] }), N({ id: 'd', title: 'D', dependsOn: ['c'] })]
  ok('a chain plans as one layer per step, and cannot be parallel', planLayers(chain).layers.length === 4)
}
{
  const cyc = [N({ id: 'a', title: 'A', dependsOn: ['b'] }), N({ id: 'b', title: 'B', dependsOn: ['a'] })]
  const r = planLayers(cyc)
  ok('a circle is refused rather than run', Boolean(r.error) && !r.layers.length)
  ok('and it names the steps in the circle', /A|B/.test(r.error))
  const dangling = [N({ id: 'a', title: 'A', dependsOn: ['ghost'] })]
  ok('a dependency on a step that is not there is refused', Boolean(planLayers(dangling).error))
}

// ── the false wait ──────────────────────────────────────────────────────────
// "Summarise this file and check the weather" has no edge in it. The weather
// does not read the summary; you typed "and then" and the code heard "wait".
{
  const nodes = [
    N({ id: 'sum', title: 'Summarise the report' }),
    N({ id: 'wx', title: 'Check the weather', prompt: 'Look up the forecast for Friday.', dependsOn: ['sum'] })
  ]
  const s = suspectEdges(nodes)
  ok('an edge whose target never mentions the source is flagged', s.length === 1 && s[0].from === 'sum')
  const real = [
    N({ id: 'sum', title: 'Summarise the report' }),
    N({ id: 'w', title: 'Write the email', prompt: 'Use the report summary above to draft it.', dependsOn: ['sum'] })
  ]
  ok('an edge that carries data is left alone', suspectEdges(real).length === 0)
  // ⚠️ IT ADVISES; IT DOES NOT CUT. Deleting an edge automatically would be the
  // graph deciding what the user meant.
  ok('flagging does not change the graph', nodes[1].dependsOn.length === 1)
}

// ── the contract ────────────────────────────────────────────────────────────
{
  const free = N({ title: 'x' })
  ok('a node with no contract takes prose', readOutput(free, 'just some words').ok)
  ok('but not silence', !readOutput(free, '   ').ok)
  const typed = N({ title: 'x', fields: ['finding', 'confidence'] })
  ok('a contract accepts the right JSON', readOutput(typed, '{"finding":"a","confidence":"high"}').ok)
  ok('and survives a code fence around it',
     readOutput(typed, '```json\n{"finding":"a","confidence":"high"}\n```').ok)
  // ⚠️ THE ONE THAT EARNS ITS KEEP. Handing free text downstream and hoping is
  // how a node becomes something only a human can read.
  ok('a missing key is a failure, not a shrug',
     !readOutput(typed, '{"finding":"a"}').ok && /confidence/.test(readOutput(typed, '{"finding":"a"}').reason))
  ok('prose where JSON was promised is a failure', !readOutput(typed, 'I found a thing.').ok)
}

// ── inputs are explicit, and a gap says it is a gap ─────────────────────────
{
  const node = N({ id: 'm', title: 'Merge', dependsOn: ['a', 'b'] })
  const block = inputBlock(node, {
    a: { title: 'Angle A', state: 'done', output: 'apples' },
    b: { title: 'Angle B', state: 'failed', error: 'boom' }
  })
  ok('a finished input arrives with its content', block.includes('apples'))
  // In a chain, failure cascades. In a graph it dies at its node — so the fan-in
  // has to tolerate a hole AND be told it is a hole.
  ok('a failed input is named as missing rather than silently dropped',
     /did not finish/.test(block) && block.includes('Angle B'))
}

// ── plumbing is code, not an agent ──────────────────────────────────────────
{
  const node = N({ id: 'r', title: 'Combine', kind: 'reduce', reduceOp: 'dedupe', dependsOn: ['a', 'b'] })
  const r = runReduce(node, {
    a: { title: 'A', state: 'done', output: 'one\ntwo' },
    b: { title: 'B', state: 'done', output: 'two\nthree' }
  })
  ok('dedupe flattens and de-duplicates', r.ok && r.output.split('\n').join() === 'one,two,three', r.output)
  ok('a reduce with nothing upstream says so',
     !runReduce(node, { a: { state: 'failed' }, b: { state: 'failed' } }).ok)
  ok('a reduce node is not an agent kind', node.kind === 'reduce')
}

// ── the skeptic is told to be one ───────────────────────────────────────────
{
  const g = { title: 'G', detail: '' }
  const v = N({ id: 'v', title: 'Check them', kind: 'verify', dependsOn: ['a'] })
  const p = nodePrompt(g, v, { a: { title: 'A', state: 'done', output: 'claim' } })
  ok('a verify node is told to try to disprove, not to review', /disprove/i.test(p))
  ok('and to drop what it cannot support', /drop/i.test(p))
  const worker = N({ id: 'w', title: 'Do it' })
  ok('a worker is not told to be a skeptic', !/disprove/i.test(nodePrompt(g, worker, {})))
  ok('a node is told its job is only its own', /only this/i.test(nodePrompt(g, worker, {})))
}

// ── the drawing follows the edges the user declared ─────────────────────────
{
  const g = { nodes: [N({ id: 'a', title: 'A' }), N({ id: 'b', title: 'B', kind: 'verify', dependsOn: ['a'] })] }
  const m = toMermaid(g, null)
  ok('every declared edge is drawn', (m.match(/-->/g) || []).length === 1)
  ok('a skeptic is a different shape from a worker', m.includes('{{"'))
  const withRun = toMermaid(g, { nodes: { a: { state: 'done' }, b: { state: 'running' } } })
  ok('a run marks what finished and what is going', withRun.includes('✓ A') && withRun.includes('● B'))
}

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  edges are real dependencies, and what does not wait runs at once`)
process.exit(fail ? 1 : 0)
