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

// ── drafting a graph from a sentence ────────────────────────────────────────
//
// ⚠️ THE MANUAL BUILDER PUTS THE WIRING COST BACK ON THE USER, WHICH IS THE ONE
// COST THIS WHOLE IDEA IS SUPPOSED TO HAVE REMOVED. What changed recently is not
// that graphs became possible — LangGraph and friends predate the name — it is
// that you can describe an objective and have a model write the orchestration.
// A form with a dependency checklist per node is the old price, charged again.
// So: describe it and get a draft; the node editor is the fallback, not the door.
//
// ⚠️ AND A DRAFT IS NOT A RUN. Drafting costs one cheap turn and touches nothing;
// running spends money and writes files. The draft lands in the editor, where it
// can be read and changed, and nothing happens until Run. That is where the last
// yes belongs — between finished work and an irreversible action.

export function draftPrompt (goal, detail, cwd) {
  return [
    `Design a small agent graph for this job:\n${goal}${detail ? '\n\n' + detail : ''}`,
    cwd ? `It will run in ${cwd}.` : '',
    `A graph is steps and the real dependencies between them.

RULES, and the second one is the whole point:
1. A step is ONE bounded job an agent could do alone.
2. A step depends on another ONLY IF it reads what that one produced. "Summarise this file and check the weather" has NO dependency — the weather never opens the summary. Steps you do not connect run AT THE SAME TIME, which is the entire reason to draw a graph. Do not chain things out of habit.
3. Include one "verify" step that reads the findings and tries to DISPROVE them. It must not be the same step that produced them.
4. If a step only joins or de-duplicates what came before, make it "reduce" — that runs as code, costs nothing, and takes no time. Never spend an agent on plumbing.
5. Usually finish with one step that merges what survived into the answer.
6. If the same kind of work applies to MANY things — files, sources, angles, modules — write several steps that each take a slice and run at the same time, not one step that loops over all of them. One agent per route file beats one agent reading every route file.
7. Prefer 3-7 steps. Before you answer, count how many run in the first stage: if the answer is one, you have drawn a chain, and a chain is the shape this is meant to replace. Go back and split the widest step.`,
    `Reply with JSON only, no prose and no code fence:
{
  "nodes": [
    {"id": "a", "title": "short name", "kind": "agent|verify|reduce", "prompt": "what this step should do", "dependsOn": ["id", ...], "tier": "cheap|smart"}
  ],
  "assumptions": ["things you had to guess, one short line each"]
}
"tier" is a hint: "cheap" for broad, repetitive collection; "smart" for the steps that carry judgement, usually the verify and the final merge.`
  ].filter(Boolean).join('\n\n')
}

/**
 * Read a drafted graph. Charitable about the shape, strict about the contract:
 * a draft that cannot be planned is not a draft, it is an error to retry.
 */
export function readDraft (text) {
  const s = String(text || '').trim()
  const m = s.match(/\{[\s\S]*\}/)
  if (!m) return { ok: false, reason: 'The model replied with prose instead of a graph.' }
  let obj
  try { obj = JSON.parse(m[0]) } catch (e) { return { ok: false, reason: `That draft was not readable JSON: ${e.message}` } }
  const raw = Array.isArray(obj.nodes) ? obj.nodes : []
  if (!raw.length) return { ok: false, reason: 'The draft had no steps in it.' }

  // ⚠️ IDS ARE THE MODEL'S, AND EDGES POINT AT THEM. Renaming them before the
  // dependencies are resolved silently disconnects the graph — every edge would
  // point at an id that no longer exists, planLayers would refuse it, and the
  // user would see "depends on something that is not in this graph" for a draft
  // that was fine.
  const known = new Set(raw.map(n => String(n.id || '')).filter(Boolean))
  const nodes = raw.map(n => normalizeNode({
    id: String(n.id || ''),
    title: String(n.title || '').slice(0, 80),
    kind: n.kind,
    prompt: String(n.prompt || ''),
    // Drop edges to steps that are not in the draft rather than failing the
    // whole thing: a model that invents one id has still drawn a usable graph.
    dependsOn: (Array.isArray(n.dependsOn) ? n.dependsOn : []).map(String).filter(d => known.has(d) && d !== String(n.id)),
    reduceOp: n.kind === 'reduce' ? 'dedupe' : undefined,
    useTools: n.kind !== 'reduce'
  })).filter(n => n.title)

  if (!nodes.length) return { ok: false, reason: 'None of the drafted steps had a name.' }
  const { error } = planLayers(nodes)
  if (error) return { ok: false, reason: error, nodes }
  const tiers = Object.fromEntries(raw.map(n => [String(n.id), n.tier === 'smart' ? 'smart' : 'cheap']))
  return {
    ok: true,
    nodes,
    tiers,
    assumptions: (Array.isArray(obj.assumptions) ? obj.assumptions : []).map(a => String(a).slice(0, 200)).slice(0, 6)
  }
}
