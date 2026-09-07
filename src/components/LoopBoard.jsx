import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { ModelPicker } from './Chat.jsx'

/**
 * A loop: one goal, several steps, and a check on each.
 *
 * ⚠️ WITHOUT THE CHECK THIS IS THE BOARD WITH A DIFFERENT ICON. A task is done
 * when the model stops talking, which is not the same as done. A loop step is
 * done when a condition you wrote in plain English is met — judged in a separate
 * turn, by a second agent if you name one — and a step that fails goes round
 * again carrying the reason it failed. That retry is the whole idea.
 *
 * ⚠️ AND IT RUNS THROUGH THE ORDINARY CHAT. The server never runs a turn for a
 * loop; it answers "here is the next turn" and this hands it to the chat view,
 * which streams it exactly as it streams anything else. Approvals, steering,
 * tools and the transcript all keep working because none of them are reimplemented
 * here. It also means you can watch it, which is most of why you would trust it.
 */

const STEP_LOOK = {
  pending: { label: 'Waiting', cls: 'is-pending' },
  working: { label: 'Working', cls: 'is-working' },
  checking: { label: 'Checking', cls: 'is-checking' },
  passed: { label: 'Passed', cls: 'is-passed' },
  failed: { label: 'Failed', cls: 'is-failed' },
  skipped: { label: 'Skipped', cls: 'is-skipped' }
}

const LOOP_LOOK = {
  idle: 'Not running',
  running: 'Running',
  blocked: 'Stuck',
  failed: 'Stopped — a step could not pass its check',
  done: 'Finished'
}

const blankStep = () => ({ title: '', prompt: '', check: '', agentId: null, model: null, provider: null, checkAgentId: null, maxAttempts: 3 })

function whoLabel (step, agents) {
  if (step.agentId) {
    const a = agents.find(x => x.id === step.agentId)
    return a ? a.name : 'Missing agent'
  }
  return step.model || 'Default model'
}

/** One row of the run: what it is, who does it, and what "done" means. */
function StepRow ({ step, index, agents, running, onOpen }) {
  const look = STEP_LOOK[step.state] || STEP_LOOK.pending
  const attemptsShown = step.attempts > 1 || step.state === 'failed'
  return (
    <li className={'lp-step ' + look.cls + (running ? ' is-current' : '')}>
      <div className='lp-step-n'>{index + 1}</div>
      <div className='lp-step-main'>
        <div className='lp-step-head'>
          <h4 className='lp-step-title'>{step.title}</h4>
          <span className='lp-step-state'>{look.label}</span>
        </div>
        <div className='lp-step-who'>
          {whoLabel(step, agents)}
          {step.checkAgentId && (
            <span className='lp-step-checker'>
              · checked by {agents.find(a => a.id === step.checkAgentId)?.name || 'a missing agent'}
            </span>
          )}
          {attemptsShown && <span className='lp-step-tries'>· attempt {step.attempts} of {step.maxAttempts}</span>}
        </div>
        {step.check
          ? <div className='lp-step-check'><span className='lp-check-lead'>Passes when</span> {step.check}</div>
          /* ⚠️ SAY IT OUT LOUD. A step with no condition is finished the moment
             the model stops, which is exactly the weakness a loop exists to fix.
             Silently treating that as success is how the layer becomes theatre. */
          : <div className='lp-step-check lp-step-nocheck'>No check — this step is done when the agent stops. Nothing verifies it.</div>}
        {step.lastFail && step.state !== 'passed' && (
          <div className='lp-step-fail'>Last check said: {step.lastFail}</div>
        )}
        {step.sessionId && (
          <button className='lp-mini' onClick={() => onOpen?.(step.sessionId)}>Open its chat</button>
        )}
      </div>
    </li>
  )
}

/** The editor for one step, used both when building a loop and when changing it. */
function StepEditor ({ step, index, agents, pickable, onChange, onRemove, onRefreshModels, canRemove }) {
  const set = patch => onChange({ ...step, ...patch })
  const who = { model: step.agentId ? (agents.find(a => a.id === step.agentId)?.name || null) : step.model, provider: step.agentId ? 'agent' : step.provider }
  const checker = { model: step.checkAgentId ? (agents.find(a => a.id === step.checkAgentId)?.name || null) : null, provider: step.checkAgentId ? 'agent' : null }
  return (
    <div className='lp-edit'>
      <div className='lp-edit-head'>
        <span className='lp-edit-n'>Step {index + 1}</span>
        {canRemove && <button className='lp-mini lp-mini-quiet' onClick={() => onRemove()} aria-label={`Remove step ${index + 1}`}>Remove</button>}
      </div>
      <input
        className='lp-input'
        placeholder='What this step does'
        value={step.title}
        onChange={e => set({ title: e.target.value })}
        aria-label={`Step ${index + 1} title`}
      />
      <textarea
        className='lp-input lp-area'
        placeholder='Anything else the agent should know (optional)'
        value={step.prompt}
        onChange={e => set({ prompt: e.target.value })}
        aria-label={`Step ${index + 1} detail`}
        rows={2}
      />
      <input
        className='lp-input lp-check-input'
        placeholder='This step passes when… (e.g. npm test exits 0 and the new file is committed)'
        value={step.check}
        onChange={e => set({ check: e.target.value })}
        aria-label={`Step ${index + 1} check`}
      />
      <div className='lp-edit-foot'>
        <label className='lp-pick'>
          <span>Does it</span>
          <ModelPicker
            session={who}
            models={pickable}
            onPick={m => (m.provider === 'agent'
              ? set({ agentId: agents.find(a => a.name === m.id)?.id || null, model: null, provider: null })
              : set({ agentId: null, model: m.id, provider: m.provider }))}
            onRefresh={() => onRefreshModels?.()}
          />
        </label>
        {/* ⚠️ THE SAME AGENT GRADING ITSELF IS THE WEAK VERSION, and it is the
            default because a second agent costs another run. Naming one here is
            the difference between a check and marking your own homework. */}
        <label className='lp-pick'>
          <span>Checks it</span>
          <ModelPicker
            session={checker}
            models={[{ id: 'The same agent', provider: 'agent', providerName: 'Agents' }, ...pickable.filter(p => p.provider === 'agent')]}
            onPick={m => set({ checkAgentId: m.id === 'The same agent' ? null : (agents.find(a => a.name === m.id)?.id || null) })}
            onRefresh={() => onRefreshModels?.()}
          />
        </label>
        <label className='lp-tries'>
          <span>Try up to</span>
          <input
            type='number' min='1' max='10'
            value={step.maxAttempts}
            onChange={e => set({ maxAttempts: Number(e.target.value) })}
            aria-label={`Step ${index + 1} maximum attempts`}
          />
        </label>
      </div>
    </div>
  )
}

export default function LoopBoard ({
  agents = [], models = [], projects = [], defaultCwd = '',
  runningLoopId = null, runningStepId = null,
  onRun, onStop, onOpenSession, onError, onRefreshModels
}) {
  const [loops, setLoops] = useState([])
  const [loading, setLoading] = useState(true)
  const [composing, setComposing] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState({ title: '', detail: '', cwd: '', steps: [blankStep()] })
  const titleRef = useRef(null)

  const refresh = useCallback(async () => {
    try { setLoops(await api.listLoops()) } catch (e) { onError?.(e.message) } finally { setLoading(false) }
  }, [onError])

  useEffect(() => { refresh() }, [refresh])
  // A loop's steps move while turns run in the chat view, so this has to look
  // again — the same reason the board polls.
  useEffect(() => {
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [refresh])
  useEffect(() => { if (composing) titleRef.current?.focus() }, [composing])

  const pickable = useMemo(() => [
    ...agents.map(a => ({ id: a.name, provider: 'agent', providerName: 'Agents', agentId: a.id })),
    ...models
  ], [agents, models])

  const startDraft = () => {
    setDraft({ title: '', detail: '', cwd: defaultCwd || '', steps: [blankStep()] })
    setEditingId(null)
    setComposing(true)
  }

  const editLoop = loop => {
    setDraft({ title: loop.title, detail: loop.detail || '', cwd: loop.cwd || '', steps: loop.steps.map(s => ({ ...s })) })
    setEditingId(loop.id)
    setComposing(true)
  }

  const saveDraft = async e => {
    e?.preventDefault?.()
    const steps = draft.steps.filter(s => s.title.trim())
    if (!draft.title.trim() || !steps.length) return
    const body = { title: draft.title.trim(), detail: draft.detail.trim(), cwd: draft.cwd.trim() || null, steps }
    try {
      if (editingId) await api.patchLoop(editingId, body)
      else await api.createLoop(body)
      setComposing(false); setEditingId(null)
      refresh()
    } catch (err) { onError?.(err.message) }
  }

  const remove = async loop => {
    try { await api.deleteLoop(loop.id); refresh() } catch (err) { onError?.(err.message) }
  }

  const setStep = (i, next) => setDraft(d => ({ ...d, steps: d.steps.map((s, j) => (j === i ? next : s)) }))
  const addStep = () => setDraft(d => ({ ...d, steps: [...d.steps, blankStep()] }))
  const removeStep = i => setDraft(d => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))

  const uncheckedSteps = draft.steps.filter(s => s.title.trim() && !s.check.trim()).length

  return (
    <section className='lp' aria-label='Loops'>
      <header className='lp-head'>
        <div>
          <h2 className='lp-title'>Loops</h2>
          <p className='lp-sub'>
            A run of steps with a check on each. A step that fails its check goes
            round again with the reason attached.
          </p>
        </div>
        <button className='lp-new' onClick={() => (composing ? setComposing(false) : startDraft())}>
          {composing ? 'Cancel' : 'New loop'}
        </button>
      </header>

      {composing && (
        <form className='lp-compose' onSubmit={saveDraft}>
          <input
            ref={titleRef}
            className='lp-input lp-input-lead'
            placeholder='What are you building?'
            value={draft.title}
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
            aria-label='Loop goal'
          />
          <textarea
            className='lp-input lp-area'
            placeholder='Context every step should have (optional)'
            value={draft.detail}
            onChange={e => setDraft(d => ({ ...d, detail: e.target.value }))}
            aria-label='Loop detail'
            rows={2}
          />
          <input
            className='lp-input'
            placeholder='Folder to work in'
            value={draft.cwd}
            onChange={e => setDraft(d => ({ ...d, cwd: e.target.value }))}
            aria-label='Working folder'
            spellCheck={false}
          />

          {draft.steps.map((s, i) => (
            <StepEditor
              key={s.id || i}
              step={s}
              index={i}
              agents={agents}
              pickable={pickable}
              canRemove={draft.steps.length > 1}
              onChange={next => setStep(i, next)}
              onRemove={() => removeStep(i)}
              onRefreshModels={onRefreshModels}
            />
          ))}

          <div className='lp-compose-foot'>
            <button type='button' className='lp-mini' onClick={addStep}>+ Add step</button>
            {uncheckedSteps > 0 && (
              <span className='lp-warn'>
                {uncheckedSteps} step{uncheckedSteps === 1 ? '' : 's'} with no check — {uncheckedSteps === 1 ? 'it' : 'they'} will
                be treated as done the moment the agent stops.
              </span>
            )}
            <button className='lp-save' type='submit' disabled={!draft.title.trim() || !draft.steps.some(s => s.title.trim())}>
              {editingId ? 'Save changes' : 'Create loop'}
            </button>
          </div>
        </form>
      )}

      {!loading && loops.length === 0 && !composing && (
        <div className='lp-blank'>
          <p className='lp-blank-lead'>Nothing running yet.</p>
          <p className='lp-blank-sub'>
            A task is one job. A loop is several, in order, each with a condition
            it has to meet before the next one starts — write the build step, then
            "passes when npm test exits 0", and it will keep going until it does
            or until it runs out of attempts.
          </p>
        </div>
      )}

      <div className='lp-list stagger'>
        {loops.map(loop => {
          const done = loop.steps.filter(s => s.state === 'passed').length
          const isRunning = loop.state === 'running'
          const mine = runningLoopId === loop.id
          return (
            <article key={loop.id} className={'lp-card is-' + loop.state}>
              <header className='lp-card-head'>
                <div>
                  <h3 className='lp-card-title'>{loop.title}</h3>
                  <div className='lp-card-state'>
                    {LOOP_LOOK[loop.state]} · {done} of {loop.steps.length} passed
                    {loop.cwd && <span className='lp-card-cwd'> · {loop.cwd}</span>}
                  </div>
                </div>
                <div className='lp-card-acts'>
                  {isRunning
                    ? <button className='lp-mini' onClick={() => onStop?.(loop)}>Stop</button>
                    : <button className='lp-mini lp-mini-go' onClick={() => onRun?.(loop)}>
                        {loop.state === 'done' || loop.state === 'failed' ? 'Run again' : 'Run'}
                      </button>}
                  <button className='lp-mini' onClick={() => editLoop(loop)} disabled={isRunning}>Edit</button>
                  <button className='lp-mini lp-mini-quiet' onClick={() => remove(loop)} aria-label={`Delete ${loop.title}`}>Delete</button>
                </div>
              </header>

              <div className='lp-bar'><i style={{ width: `${(done / loop.steps.length) * 100}%` }} /></div>

              {/* ⚠️ A LOOP ONLY MOVES WHILE RADIANT IS RUNNING IT. The turns go
                  through the chat view, so a loop marked Running in a window you
                  have closed is not going anywhere. Say so rather than letting it
                  sit there looking busy. */}
              {isRunning && !mine && (
                <p className='lp-note'>Marked running, but not by this window. Press Run to pick it up.</p>
              )}

              <ol className='lp-steps'>
                {loop.steps.map((s, i) => (
                  <StepRow
                    key={s.id}
                    step={s}
                    index={i}
                    agents={agents}
                    running={mine && runningStepId === s.id}
                    onOpen={onOpenSession}
                  />
                ))}
              </ol>
            </article>
          )
        })}
      </div>
    </section>
  )
}
