/**
 * A graph is nodes and edges, and nothing else.
 *
 * A NODE is one unit of work: one agent, one bounded job, one input in, one
 * output out. An EDGE is a real data dependency — B depends on A only when B
 * actually reads what A produced.
 *
 * ⚠️ THAT SECOND SENTENCE IS THE WHOLE FEATURE. Write "do A, then B, then C" and
 * you have drawn a graph already: a single chain, one edge in and one out all the
 * way down, which runs at the speed of its slowest step and stops dead if any
 * step stalls. Most of those arrows are not real. "Summarise this file and check
 * the weather" has no edge in it — the weather does not read the summary. You
 * typed "and then"; the code heard "wait".
 *
 * So the only question this file answers is which nodes are genuinely waiting on
 * which, and everything that is not waiting runs at the same time.
 *
 * Pure on purpose: layering, cycle detection, prompt assembly and output parsing
 * are all decided here, with no model, no network and no clock, because they are
 * exactly the parts that get shipped untested when they live inside a runner.
 */

const NODE_ID = () => 'n-' + Math.random().toString(36).slice(2, 8)

// What a node can be. Only two of these cost a model.
//
// ⚠️ `reduce` IS CODE, AND THAT IS THE POINT. Spawning an agent to "combine the
// results" is paying rent on your own wiring: if combining means flatten and
// dedupe, that is a Set, and it is instant, deterministic and free. Agents are
// for judgement. Never for plumbing.
export const NODE_KINDS = ['agent', 'verify', 'reduce']
export const REDUCE_OPS = ['concat', 'dedupe']

export const DEFAULT_CONCURRENCY = 4
export const MAX_CONCURRENCY = 12

export function normalizeNode (raw, existing) {
  const kind = NODE_KINDS.includes(raw.kind) ? raw.kind : 'agent'
  return {
    id: existing?.id || raw.id || NODE_ID(),
    title: String(raw.title || '').trim(),
    kind,
    prompt: String(raw.prompt || '').trim(),
    // Which nodes this one READS. Not the order you typed them in.
    dependsOn: Array.isArray(raw.dependsOn) ? [...new Set(raw.dependsOn.filter(Boolean))] : [],
    agentId: raw.agentId || null,
    model: raw.model || null,
    provider: raw.provider || null,
    reduceOp: REDUCE_OPS.includes(raw.reduceOp) ? raw.reduceOp : 'concat',
    // A contract: the fields this node must return. Empty means free text.
    // Validated after the turn, so the next node consumes it without guessing.
    fields: Array.isArray(raw.fields) ? raw.fields.map(f => String(f).trim()).filter(Boolean).slice(0, 12) : [],
    useTools: raw.useTools !== false
  }
}

/**
 * Order the nodes into layers. Everything in one layer has no dependency on
 * anything else in that layer, so a layer runs all at once — that is the entire
 * speed-up, and it falls out of the edges rather than being configured.
 *
 * Returns { layers, error }. A cycle is an error, not a layer: a graph that
 * feeds itself has no place to start.
 */
export function planLayers (nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const missing = []
  for (const n of nodes) for (const d of n.dependsOn) if (!byId.has(d)) missing.push({ node: n.id, dep: d })
  if (missing.length) {
    return { layers: [], error: `A step depends on something that is not in this graph (${missing.map(m => m.dep).join(', ')}).` }
  }
  const remaining = new Set(nodes.map(n => n.id))
  const done = new Set()
  const layers = []
  while (remaining.size) {
    const ready = [...remaining].filter(id => byId.get(id).dependsOn.every(d => done.has(d)))
    if (!ready.length) {
      // ⚠️ CYCLES ARE REFUSED, NOT RUN. A cycle that converges is a real pattern
      // — keep going until a round turns up nothing new — but one that does not
      // is an agent spawning agents until the money is gone. Until the stopping
      // rule is built, the honest answer is that this graph cannot start.
      return { layers: [], error: `These steps depend on each other in a circle: ${[...remaining].map(id => byId.get(id).title || id).join(' → ')}.` }
    }
    layers.push(ready)
    for (const id of ready) { remaining.delete(id); done.add(id) }
  }
  return { layers, error: null }
}

/**
 * Which edges look like they carry no data.
 *
 * ⚠️ THIS ADVISES, IT DOES NOT CUT. "Most chains have two or three fake arrows
 * hiding in them" — and deleting one automatically would be the graph deciding
 * what the user meant. A dependency whose output the dependent never mentions is
 * worth a second look and nothing more; the user cuts it.
 */
export function suspectEdges (nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]))
  const out = []
  for (const n of nodes) {
    if (n.kind !== 'agent') continue          // verify and reduce read every input by definition
    const text = (n.prompt + ' ' + n.title).toLowerCase()
    for (const d of n.dependsOn) {
      const dep = byId.get(d)
      if (!dep) continue
      const words = (dep.title || '').toLowerCase().split(/\W+/).filter(w => w.length > 3)
      const mentioned = words.length ? words.some(w => text.includes(w)) : true
      if (!mentioned) out.push({ from: d, to: n.id, why: `"${n.title}" never mentions "${dep.title}". If it does not read that result, the wait is not real.` })
    }
  }
  return out
}

/** The inputs a node receives, as text. Explicit — never assumed from context. */
export function inputBlock (node, results) {
  const parts = []
  for (const d of node.dependsOn) {
    const r = results[d]
    // ⚠️ A MISSING INPUT IS NORMAL AND MUST BE SAID. A node that failed resolves
    // to nothing rather than killing the run, so a fan-in has to tolerate gaps —
    // and the node needs to know a gap is a gap, not an empty answer.
    if (!r || r.state !== 'done') parts.push(`### ${r?.title || d}\n(this step did not finish, so there is nothing from it)`)
    else parts.push(`### ${r.title}\n${r.output}`)
  }
  return parts.join('\n\n')
}

/** What to say to one node. */
export function nodePrompt (graph, node, results) {
  const parts = [`Goal of this graph: ${graph.title}${graph.detail ? '\n' + graph.detail : ''}`]
  parts.push(`Your job, and only this: ${node.title}`)
  if (node.prompt) parts.push(node.prompt)
  if (node.dependsOn.length) {
    parts.push(`Here is what the steps you depend on produced. Work from this; do not redo their work.\n\n${inputBlock(node, results)}`)
  }
  if (node.kind === 'verify') {
    // ⚠️ THE CHECKER MUST NOT BE THE AUTHOR. An agent asked to check its own work
    // will pass it. A verify node reads someone else's findings and its only job
    // is to try to kill them — what survives is what goes downstream.
    parts.push([
      'You are a skeptic. Do not add findings, do not improve them, do not be polite.',
      'Take each claim above and try to disprove it. Check anything checkable — read the file, run the command, look at the actual output.',
      'Drop every claim you cannot support. Return only the survivors, each with one line saying what you did to confirm it.',
      'If nothing survives, say exactly: NOTHING SURVIVED.'
    ].join(' '))
  }
  if (node.fields.length) {
    parts.push(`Reply with JSON only — no prose, no code fence — an object with exactly these keys: ${node.fields.join(', ')}.`)
  }
  return parts.join('\n\n')
}

/**
 * Read a node's answer. With a contract, that means JSON with the right keys.
 *
 * ⚠️ VALIDATE, THEN RETRY — do not hand free text to the next node and hope. A
 * node whose output shape is a guess is a node you cannot wire into anything.
 */
export function readOutput (node, text) {
  const s = String(text || '').trim()
  if (!s) return { ok: false, reason: 'That step returned nothing at all.' }
  if (!node.fields.length) return { ok: true, output: s }
  // Models fence JSON even when told not to. Take the first {...} block.
  const m = s.match(/\{[\s\S]*\}/)
  if (!m) return { ok: false, reason: `Expected JSON with the keys ${node.fields.join(', ')}, got prose.` }
  let obj
  try { obj = JSON.parse(m[0]) } catch (e) { return { ok: false, reason: `That JSON could not be read: ${e.message}` } }
  const missing = node.fields.filter(f => obj[f] === undefined)
  if (missing.length) return { ok: false, reason: `Missing from the answer: ${missing.join(', ')}.` }
  return { ok: true, output: JSON.stringify(obj, null, 2), data: obj }
}

/**
 * The plumbing nodes. Deterministic, instant, free — and the reason this is not
 * an agent is that an agent asked to flatten a list is a bill for a Set.
 */
export function runReduce (node, results) {
  const chunks = node.dependsOn
    .map(d => results[d])
    .filter(r => r && r.state === 'done')
    .map(r => ({ title: r.title, output: r.output }))
  if (!chunks.length) return { ok: false, reason: 'Nothing upstream finished, so there was nothing to combine.' }
  if (node.reduceOp === 'dedupe') {
    const seen = new Set()
    const lines = []
    for (const c of chunks) {
      for (const line of c.output.split('\n')) {
        const key = line.trim().toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        lines.push(line.trim())
      }
    }
    return { ok: true, output: lines.join('\n') }
  }
  return { ok: true, output: chunks.map(c => `### ${c.title}\n${c.output}`).join('\n\n') }
}

/** The topology, as a picture. Drawn from the edges the user actually declared. */
export function toMermaid (graph, run) {
  const ids = new Map()
  graph.nodes.forEach((n, i) => ids.set(n.id, 'g' + i))
  const esc = s => String(s || '').replace(/"/g, '&quot;').replace(/[<>]/g, '')
  const lines = ['flowchart LR']
  for (const n of graph.nodes) {
    const st = run?.nodes?.[n.id]?.state
    const mark = st === 'done' ? '✓ ' : st === 'failed' ? '✕ ' : st === 'running' ? '● ' : ''
    const label = `${mark}${esc(n.title || n.id)}`
    // A skeptic and a plumbing step are not the same shape as a worker, and the
    // shape is how you read the graph at a glance.
    lines.push(n.kind === 'verify'
      ? `  ${ids.get(n.id)}{{"${label}"}}`
      : n.kind === 'reduce'
        ? `  ${ids.get(n.id)}[["${label}"]]`
        : `  ${ids.get(n.id)}["${label}"]`)
  }
  for (const n of graph.nodes) {
    for (const d of n.dependsOn) {
      if (ids.has(d)) lines.push(`  ${ids.get(d)} --> ${ids.get(n.id)}`)
    }
  }
  return lines.join('\n')
}
