import crypto from 'crypto'
import os from 'os'
import { runTurn } from './providers.js'
import { planLayers, nodePrompt, readOutput, runReduce, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from './graph-rules.js'

/**
 * The runner. This is the part Radiant could not do before.
 *
 * ⚠️ EVERY OTHER RUN IN THIS APP IS DRIVEN BY THE CHAT WINDOW — the server says
 * "here is the next turn" and the client streams it, one at a time. That is
 * right for a chat and right for a loop, and it is exactly wrong for a graph,
 * whose entire value is that independent work does not queue. So this drives
 * turns itself, several at once, with nobody watching.
 *
 * It is NOT a second run engine. It calls the same runTurn(); what is new is
 * that more than one of them is in flight. Everything that follows is the
 * consequence of that:
 *
 * ⚠️ NOBODY CAN ANSWER AN APPROVAL PROMPT HERE. Five agents cannot each stop and
 * wait for a click. So requestApproval is not "approve everything" — it FAILS
 * the node, with a message naming what it wanted. A graph that silently granted
 * itself permission to run shell commands, in parallel, unattended, would be the
 * worst thing in this codebase. Turning that off is a deliberate per-graph
 * choice the user makes on screen.
 *
 * ⚠️ A FAILED NODE MUST NOT KILL THE RUN. In a chain, failure cascades: C dies
 * and D never happens. In a graph, failure dies at its node — eight good results
 * still come back while the ninth drops out, and the fan-in downstream is told
 * there is a gap.
 */

const MAX_NODE_MS = 10 * 60 * 1000

// Live runs, so a second Run press does not start a second copy of the same graph.
const running = new Map()   // graphId -> { controller, run }

export const isRunning = id => running.has(id)
export const liveRun = id => running.get(id)?.run || null
export function stopGraph (id) {
  const r = running.get(id)
  if (!r) return false
  r.controller.abort()
  return true
}

/** One node's turn, in its own session, with nothing else in its context. */
async function runNode ({ graph, node, results, deps, signal }) {
  const { loadConfig, saveSession, agentsStore, getProject, credFor } = deps
  const config = loadConfig()
  const project = graph.projectId ? getProject(graph.projectId) : null
  const agent = node.agentId ? agentsStore.get(node.agentId) : null

  const session = {
    id: crypto.randomUUID(),
    title: `${graph.title} — ${node.title}`,
    autoTitle: false,
    agentId: agent ? agent.id : null,
    projectId: project ? project.id : null,
    // ⚠️ MODEL TIERING IS THE WHOLE ECONOMICS OF THIS. A wide fan-out inherits
    // the session model by default, so twenty cheap lookups bill at the top
    // tier — people find that out on the invoice. Each node names its own.
    provider: node.provider || (agent && agent.provider) || (project && project.provider) || config.settings.defaultProvider || null,
    model: node.model || (agent && agent.model) || (project && project.model) || config.settings.defaultModel,
    cwd: graph.cwd || (project && project.cwd) || config.settings.defaultCwd || os.homedir(),
    useTools: node.useTools !== false,
    computerControl: false,
    graphId: graph.id,
    graphNodeId: node.id,
    createdAt: new Date().toISOString(),
    messages: []
  }
  if (!session.model) return { state: 'failed', error: 'No model is set for this step, and there is no default to fall back on.' }

  const prompt = nodePrompt(graph, node, results)
  session.messages.push({ role: 'user', text: prompt })
  saveSession(session)

  const cred = await credFor(session.provider)
  if (!cred) return { state: 'failed', error: `Not signed in to ${session.provider}.`, sessionId: session.id }

  let text = ''
  let refused = null
  const timeout = setTimeout(() => { try { signal.__nodeAbort?.() } catch {} }, MAX_NODE_MS)
  try {
    await runTurn({
      provider: cred.provider,
      model: session.model,
      apiKey: cred.apiKey,
      getAccessToken: cred.getAccessToken,
      getAccountId: cred.getAccountId,
      session,
      useTools: session.useTools,
      computerControl: false,
      persona: agent?.persona || '',
      skills: [],
      emit: ev => { if (ev.type === 'text_delta') text += ev.text },
      // See the header: a graph cannot ask. It refuses and says what it wanted.
      requestApproval: graph.autoApprove
        ? null
        : call => { refused = call.name; return Promise.resolve(false) },
      signal
    })
  } catch (e) {
    clearTimeout(timeout)
    if (signal.aborted) return { state: 'failed', error: 'Stopped.', sessionId: session.id }
    return { state: 'failed', error: e.message, sessionId: session.id }
  }
  clearTimeout(timeout)

  // ⚠️ SAVE THE TRANSCRIPT WHATEVER HAPPENED. A node you cannot open is a node
  // you cannot debug, and "it failed" with no conversation behind it is the
  // thing that makes a parallel run feel like a black box.
  try { saveSession(session) } catch {}

  if (refused && !text.trim()) {
    return {
      state: 'failed',
      sessionId: session.id,
      error: `This step tried to use ${refused}, and a graph cannot stop to ask you. Either give it work that only reads, or turn on "let this graph act without asking".`
    }
  }

  const parsed = readOutput(node, text)
  if (!parsed.ok) return { state: 'failed', error: parsed.reason, sessionId: session.id, output: text.slice(0, 2000) }
  return { state: 'done', output: parsed.output, data: parsed.data, sessionId: session.id }
}

/** Run at most `limit` of these at once. */
async function pool (items, limit, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const at = i++
      out[at] = await fn(items[at], at)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Run a whole graph. Resolves with the finished run; never throws for a node's
 * sake.
 * @param {(run) => void} onProgress called after every node so the UI can watch
 */
export async function runGraph (graph, deps, onProgress = () => {}) {
  const { layers, error } = planLayers(graph.nodes)
  if (error) return { state: 'failed', error, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), nodes: {} }

  const controller = new AbortController()
  const run = {
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    nodes: Object.fromEntries(graph.nodes.map(n => [n.id, { title: n.title, kind: n.kind, state: 'waiting' }]))
  }
  running.set(graph.id, { controller, run })
  const limit = Math.min(MAX_CONCURRENCY, Math.max(1, graph.concurrency || DEFAULT_CONCURRENCY))
  const byId = new Map(graph.nodes.map(n => [n.id, n]))

  try {
    for (const layer of layers) {
      if (controller.signal.aborted) break
      // Everything in a layer starts together. This is the fan-out.
      await pool(layer, limit, async id => {
        if (controller.signal.aborted) return
        const node = byId.get(id)
        const started = Date.now()
        run.nodes[id] = { ...run.nodes[id], state: 'running', startedAt: new Date().toISOString() }
        onProgress(run)

        let r
        if (node.kind === 'reduce') {
          // No model, no session, no wait.
          const red = runReduce(node, run.nodes)
          r = red.ok ? { state: 'done', output: red.output } : { state: 'failed', error: red.reason }
        } else {
          r = await runNode({ graph, node, results: run.nodes, deps, signal: controller.signal })
        }
        run.nodes[id] = { ...run.nodes[id], ...r, ms: Date.now() - started, finishedAt: new Date().toISOString() }
        onProgress(run)
      })
    }
    if (controller.signal.aborted) { run.state = 'stopped' } else {
      const failed = Object.values(run.nodes).filter(n => n.state === 'failed')
      // ⚠️ SOME FAILURES ARE FINE. The run is only a failure when NOTHING
      // finished; otherwise it is a result with holes in it, which is what
      // containing failure at the node is for.
      run.state = failed.length === graph.nodes.length ? 'failed' : 'done'
      if (failed.length) run.error = `${failed.length} of ${graph.nodes.length} steps did not finish.`
    }
  } finally {
    run.finishedAt = new Date().toISOString()
    running.delete(graph.id)
    onProgress(run)
  }
  return run
}
