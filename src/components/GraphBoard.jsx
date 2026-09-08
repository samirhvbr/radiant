import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { ModelPicker } from './Chat.jsx'
import { renderMermaid } from './Markdown.jsx'
import PathPicker from './PathPicker.jsx'

/**
 * A graph: several jobs that do not wait for each other.
 *
 * ⚠️ THE WHOLE SCREEN IS ABOUT ONE QUESTION — which steps actually wait for
 * which. A step depends on another only when it READS what that one produced.
 * "Summarise this file and check the weather" has no dependency in it: the
 * weather does not read the summary. You typed "and then"; the code heard
 * "wait". So dependencies are a checklist on each step rather than an order you
 * drag things into, and the picture above shows what that bought you.
 *
 * A loop is one job that keeps going until it verifies. A graph is the layer
 * above: independent work runs at the same time, a skeptic tries to kill the
 * findings before they reach the answer, and the merge is the only step that
 * waits for everything.
 */

const KINDS = [
  { id: 'agent', label: 'Work', hint: 'An agent does one bounded job.' },
  { id: 'verify', label: 'Check', hint: 'A skeptic that tries to disprove what came in, and drops what it cannot support.' },
  { id: 'reduce', label: 'Combine', hint: 'Plain code — joins or de-duplicates what came in. No model, no cost.' }
]

const STATE_LOOK = {
  waiting: 'Waiting', running: 'Running', done: 'Done', failed: 'Failed'
}

const blankNode = () => ({ title: '', kind: 'agent', prompt: '', dependsOn: [], model: null, provider: null, agentId: null, fields: [], reduceOp: 'concat', useTools: true })

// ⚠️ THE DIAMOND IS THE ONLY TOPOLOGY WORTH MEMORISING, so it is the one the
// New button starts you with: independent work fans out, a skeptic sits on the
// edge, and one step merges the survivors. Swap the prompts and it is a market
// scan, a dependency audit, a code review or a research report.
const DIAMOND = () => ([
  { ...blankNode(), id: 'd1', title: 'Angle one', prompt: 'Research this angle and list what you find, one finding per line.' },
  { ...blankNode(), id: 'd2', title: 'Angle two', prompt: 'Research this angle and list what you find, one finding per line.' },
  { ...blankNode(), id: 'd3', title: 'Angle three', prompt: 'Research this angle and list what you find, one finding per line.' },
  { ...blankNode(), id: 'd4', title: 'Drop the duplicates', kind: 'reduce', reduceOp: 'dedupe', dependsOn: ['d1', 'd2', 'd3'] },
  { ...blankNode(), id: 'd5', title: 'Try to break the findings', kind: 'verify', dependsOn: ['d4'] },
  { ...blankNode(), id: 'd6', title: 'Write the answer', prompt: 'Write the final answer from the findings that survived.', dependsOn: ['d5'] }
])

function NodeEditor ({ node, index, all, agents, pickable, onChange, onRemove, canRemove, onRefreshModels }) {
  const set = p => onChange({ ...node, ...p })
  const who = { model: node.agentId ? (agents.find(a => a.id === node.agentId)?.name || null) : node.model, provider: node.agentId ? 'agent' : node.provider }
  const others = all.filter(n => n.id !== node.id && n.title.trim())
  return (
    <div className='gb-node'>
      <div className='gb-node-head'>
        <span className='gb-node-n'>Step {index + 1}</span>
        <div className='gb-kinds' role='group' aria-label={`What step ${index + 1} is`}>
          {KINDS.map(k => (
            <button key={k.id} type='button' title={k.hint}
              className={'rx-btn rx-btn-seg' + (node.kind === k.id ? ' on' : '')}
              onClick={() => set({ kind: k.id })}>{k.label}</button>
          ))}
        </div>
        {canRemove && <button type='button' className='lp-mini lp-mini-quiet' onClick={onRemove}>Remove</button>}
      </div>

      <input className='lp-input' placeholder='What this step does' value={node.title}
        onChange={e => set({ title: e.target.value })} aria-label={`Step ${index + 1} title`} />

      {node.kind === 'agent' && (
        <textarea className='lp-input lp-area' rows={2} placeholder='What should it do? (optional)'
          value={node.prompt} onChange={e => set({ prompt: e.target.value })} aria-label={`Step ${index + 1} detail`} />
      )}
      {node.kind === 'verify' && (
        <p className='lp-field-hint'>
          It reads what the steps below feed it and tries to disprove each claim, keeping only what it can
          support. Give it a different model from the step that produced the work — an agent asked to check
          its own answer will pass it.
        </p>
      )}
      {node.kind === 'reduce' && (
        <div className='gb-reduce'>
          {['concat', 'dedupe'].map(op => (
            <button key={op} type='button'
              className={'rx-btn rx-btn-seg' + (node.reduceOp === op ? ' on' : '')}
              onClick={() => set({ reduceOp: op })}>{op === 'concat' ? 'Join them' : 'Drop duplicates'}</button>
          ))}
          <span className='lp-field-hint'>Done in code. No model is called, so this costs nothing and takes no time.</span>
        </div>
      )}

      {/* ⚠️ THE ONLY QUESTION THAT MATTERS ON THIS SCREEN. Not "what order", but
          "what does this one read". Everything left unticked runs at the same
          time as this step. */}
      <div className='gb-deps'>
        <span className='lp-field-label'>Which steps does it read?</span>
        {others.length === 0
          ? <span className='lp-field-hint'>Nothing yet — add another step first.</span>
          : (
            <div className='gb-dep-list'>
              {others.map(o => (
                <label key={o.id} className='gb-dep'>
                  <input
                    type='checkbox'
                    checked={node.dependsOn.includes(o.id)}
                    onChange={e => set({ dependsOn: e.target.checked ? [...node.dependsOn, o.id] : node.dependsOn.filter(x => x !== o.id) })}
                  />
                  <span>{o.title}</span>
                </label>
              ))}
            </div>
          )}
        <span className='lp-field-hint'>
          Tick only what it genuinely reads. Anything you leave unticked runs at the same time as this step —
          that is the whole speed-up.
        </span>
      </div>

      {node.kind !== 'reduce' && (
        <div className='gb-node-foot'>
          <label className='lp-pick'>
            <span>Runs on</span>
            <ModelPicker
              session={who}
              models={pickable}
              onPick={m => (m.provider === 'agent'
                ? set({ agentId: agents.find(a => a.name === m.id)?.id || null, model: null, provider: null })
                : set({ agentId: null, model: m.id, provider: m.provider }))}
              onRefresh={() => onRefreshModels?.()}
            />
          </label>
          {/* Run the broad, boring steps cheaply; keep the expensive model for the
              step that carries the judgement. A fan-out that inherits your top
              model bills entirely at that tier. */}
          <span className='lp-field-hint'>Cheap model for breadth, your best one for the merge.</span>
        </div>
      )}
    </div>
  )
}

export default function GraphBoard ({
  agents = [], models = [], projects = [], defaultCwd = '',
  mode = 'dark', onOpenSession, onError, onRefreshModels
}) {
  const [graphs, setGraphs] = useState([])
  const [loading, setLoading] = useState(true)
  const [composing, setComposing] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState(null)
  const [openId, setOpenId] = useState(null)
  const [plan, setPlan] = useState(null)
  const host = useRef(null)

  const refresh = useCallback(async () => {
    try { setGraphs(await api.listGraphs()) } catch (e) { onError?.(e.message) } finally { setLoading(false) }
  }, [onError])

  useEffect(() => { refresh() }, [refresh])
  // ⚠️ A GRAPH RUNS ON THE SERVER WITH NOBODY WATCHING — that is the point — so
  // the view polls rather than streams. Closing the window does not stop it.
  useEffect(() => {
    const t = setInterval(refresh, 2500)
    return () => clearInterval(t)
  }, [refresh])

  const open = graphs.find(g => g.id === openId) || null

  useEffect(() => {
    if (!openId) { setPlan(null); return }
    let stale = false
    api.graphPlan(openId).then(p => { if (!stale) setPlan(p) }).catch(() => {})
    return () => { stale = true }
  }, [openId, graphs])

  useEffect(() => {
    if (!plan?.mermaid || !host.current) return
    let stale = false
    const el = host.current
    renderMermaid(plan.mermaid, el, document.documentElement.dataset.mode !== 'light')
      .catch(() => { if (!stale) el.innerHTML = '' })
    return () => { stale = true }
  }, [plan, mode])

  const pickable = useMemo(() => [
    ...agents.map(a => ({ id: a.name, provider: 'agent', providerName: 'Agents', agentId: a.id })),
    ...models
  ], [agents, models])

  const startDraft = () => {
    setDraft({ title: '', detail: '', cwd: defaultCwd || '', concurrency: 4, autoApprove: false, nodes: DIAMOND() })
    setEditingId(null); setComposing(true)
  }
  const editGraph = g => {
    setDraft({ title: g.title, detail: g.detail || '', cwd: g.cwd || '', concurrency: g.concurrency || 4, autoApprove: Boolean(g.autoApprove), nodes: g.nodes.map(n => ({ ...n })) })
    setEditingId(g.id); setComposing(true)
  }

  const save = async () => {
    const nodes = draft.nodes.filter(n => n.title.trim())
    if (!draft.title.trim() || !nodes.length) return
    const body = { title: draft.title.trim(), detail: draft.detail.trim(), cwd: draft.cwd.trim() || null, concurrency: draft.concurrency, autoApprove: draft.autoApprove, nodes }
    try {
      const g = editingId ? await api.patchGraph(editingId, body) : await api.createGraph(body)
      setComposing(false); setEditingId(null); setOpenId(g.id); refresh()
    } catch (e) { onError?.(e.message) }
  }

  const run = async g => { try { await api.runGraph(g.id); setOpenId(g.id); refresh() } catch (e) { onError?.(e.message) } }
  const stop = async g => { try { await api.stopGraph(g.id); refresh() } catch (e) { onError?.(e.message) } }
  const remove = async g => { try { await api.deleteGraph(g.id); if (openId === g.id) setOpenId(null); refresh() } catch (e) { onError?.(e.message) } }

  const setNode = (i, n) => setDraft(d => ({ ...d, nodes: d.nodes.map((x, j) => (j === i ? n : x)) }))
  const addNode = () => setDraft(d => ({ ...d, nodes: [...d.nodes, { ...blankNode(), id: 'new-' + Date.now() }] }))
  const removeNode = i => setDraft(d => {
    const gone = d.nodes[i].id
    return { ...d, nodes: d.nodes.filter((_, j) => j !== i).map(n => ({ ...n, dependsOn: n.dependsOn.filter(x => x !== gone) })) }
  })

  return (
    <section className='gb' aria-label='Graphs'>
      <header className='gb-head'>
        <div>
          <h2 className='gb-title'>Graphs</h2>
          <p className='gb-sub'>
            Several jobs, and only the waits that are real. A step waits for another only when it reads what
            that one produced — everything else runs at the same time. A skeptic tries to break the findings
            before they reach the answer.
          </p>
        </div>
        <button className='rx-btn rx-btn-go' onClick={() => (composing ? setComposing(false) : startDraft())}>
          {composing ? 'Cancel' : 'New graph'}
        </button>
      </header>

      {composing && draft && (
        <div className='gb-compose'>
          <input className='lp-input lp-input-lead' placeholder='What is this graph for?'
            value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} aria-label='Graph goal' />
          <textarea className='lp-input lp-area' rows={2} placeholder='Context every step should have (optional)'
            value={draft.detail} onChange={e => setDraft(d => ({ ...d, detail: e.target.value }))} aria-label='Graph detail' />
          <label className='lp-field'>
            <span className='lp-field-label'>Which folder should it work in?</span>
            <PathPicker value={draft.cwd} onChange={cwd => setDraft(d => ({ ...d, cwd }))} projects={projects} label='Working folder' />
          </label>

          {draft.nodes.map((n, i) => (
            <NodeEditor key={n.id || i} node={n} index={i} all={draft.nodes} agents={agents} pickable={pickable}
              canRemove={draft.nodes.length > 1}
              onChange={next => setNode(i, next)} onRemove={() => removeNode(i)} onRefreshModels={onRefreshModels} />
          ))}

          <div className='gb-compose-foot'>
            <button type='button' className='rx-btn rx-btn-sm' onClick={addNode}>+ Add step</button>
            <label className='gb-auto'>
              <input type='checkbox' checked={draft.autoApprove}
                onChange={e => setDraft(d => ({ ...d, autoApprove: e.target.checked }))} />
              {/* ⚠️ SAY WHAT IT MEANS, NOT WHAT IT IS CALLED. Several agents,
                  running shell commands, at once, with nobody watching. */}
              <span>Let this graph act without asking <i>— several agents may run commands at the same time, with nobody watching. Off means a step that needs permission fails instead.</i></span>
            </label>
            <button className='rx-btn rx-btn-go' onClick={save} disabled={!draft.title.trim() || !draft.nodes.some(n => n.title.trim())}>
              {editingId ? 'Save changes' : 'Create graph'}
            </button>
          </div>
        </div>
      )}

      {!loading && !graphs.length && !composing && (
        <div className='lp-blank'>
          <p className='lp-blank-lead'>No graphs yet.</p>
          <p className='lp-blank-sub'>
            A task is one job. A loop is one job that keeps going until it passes a check. A graph is
            several jobs at once — three research angles, or one agent per file — with a skeptic on the
            way out and one step that merges what survived. New graph starts you with that shape.
          </p>
        </div>
      )}

      <div className='gb-list'>
        {graphs.map(g => {
          const r = g.run
          const nodes = r?.nodes ? Object.values(r.nodes) : []
          const done = nodes.filter(n => n.state === 'done').length
          const isOpen = openId === g.id
          return (
            <article key={g.id} className={'gb-card' + (g.running ? ' is-running' : '')}>
              <header className='gb-card-head' onClick={() => setOpenId(isOpen ? null : g.id)}>
                <div>
                  <h3 className='gb-card-title'>{g.title}</h3>
                  <div className='gb-card-state'>
                    {g.running ? 'Running' : r?.state === 'done' ? 'Finished' : r?.state === 'failed' ? 'Failed' : r?.state === 'stopped' ? 'Stopped' : 'Not run yet'}
                    {' · '}{g.nodes.length} step{g.nodes.length === 1 ? '' : 's'}
                    {nodes.length ? ` · ${done} of ${nodes.length} done` : ''}
                    {g.cwd && <span className='lp-card-cwd'> · {g.cwd}</span>}
                  </div>
                </div>
                <div className='gb-card-acts' onClick={e => e.stopPropagation()}>
                  {g.running
                    ? <button className='rx-btn rx-btn-sm' onClick={() => stop(g)}>Stop</button>
                    : <button className='rx-btn rx-btn-sm rx-btn-go' onClick={() => run(g)}>{r ? 'Run again' : 'Run'}</button>}
                  <button className='rx-btn rx-btn-sm' onClick={() => editGraph(g)} disabled={g.running}>Edit</button>
                  <button className='rx-btn rx-btn-sm' onClick={() => remove(g)} aria-label={`Delete ${g.title}`}>Delete</button>
                </div>
              </header>

              {r?.error && <p className='lp-note'>{r.error}</p>}

              {isOpen && (
                <div className='gb-open'>
                  {plan?.error && <p className='lp-note'>{plan.error}</p>}
                  {/* What the shape actually bought. */}
                  {plan?.layers?.length > 0 && (
                    <p className='gb-layers'>
                      {plan.layers.length} stage{plan.layers.length === 1 ? '' : 's'} ·{' '}
                      {plan.layers.map(l => l.length).join(' then ')} at a time
                      {plan.layers.some(l => l.length > 1) ? '' : ' — nothing here runs in parallel, so every step is waiting on the one before it'}
                    </p>
                  )}
                  {/* ⚠️ ADVICE, NOT AN EDIT. Most chains hide two or three waits
                      that carry no data; cutting one automatically would be the
                      app deciding what the user meant. */}
                  {plan?.suspect?.map(s => (
                    <p key={s.from + s.to} className='gb-suspect'>Possible false wait — {s.why}</p>
                  ))}
                  <div className='gb-canvas'><div ref={host} className='gv-mermaid' /></div>

                  <ol className='gb-nodes'>
                    {g.nodes.map(n => {
                      const st = r?.nodes?.[n.id]
                      return (
                        <li key={n.id} className={'gb-run-node is-' + (st?.state || 'waiting')}>
                          <span className='gb-run-state'>{STATE_LOOK[st?.state] || 'Waiting'}</span>
                          <div className='gb-run-main'>
                            <b>{n.title}</b>
                            <span className='gb-run-kind'>
                              {KINDS.find(k => k.id === n.kind)?.label}
                              {n.dependsOn.length ? ` · reads ${n.dependsOn.length}` : ' · reads nothing, so it starts immediately'}
                              {st?.ms ? ` · ${(st.ms / 1000).toFixed(1)}s` : ''}
                            </span>
                            {st?.error && <span className='gb-run-error'>{st.error}</span>}
                            {st?.output && <pre className='gb-run-out'>{st.output.slice(0, 600)}</pre>}
                            {st?.sessionId && <button className='lp-mini' onClick={() => onOpenSession?.(st.sessionId)}>Open its chat</button>}
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
