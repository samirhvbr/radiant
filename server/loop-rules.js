/**
 * What a loop decides, separated from where it stores things.
 *
 * ⚠️ THESE ARE PURE ON PURPOSE. The verdict reader is the only thing standing
 * between "the model said some words" and "this step is finished", and the retry
 * prompt is the only thing that makes a second attempt different from the first.
 * Both are exactly the kind of logic that gets shipped untested because testing
 * it seems to need a model, a session and a running server. It needs a string.
 */

const STEP_ID = () => 'step-' + Math.random().toString(36).slice(2, 8)

// ⚠️ AN UNBOUNDED RETRY IS AN UNBOUNDED BILL. Three attempts is enough for the
// ordinary case (missed a file, forgot a test) and stops a step that cannot pass
// from spending the night proving it.
export const DEFAULT_ATTEMPTS = 3
export const MAX_ATTEMPTS = 10

export function normalizeStep (raw, existing) {
  const max = Number(raw.maxAttempts)
  return {
    id: existing?.id || STEP_ID(),
    title: String(raw.title || '').trim(),
    prompt: String(raw.prompt || '').trim(),
    check: String(raw.check || '').trim(),
    agentId: raw.agentId || null,
    model: raw.model || null,
    provider: raw.provider || null,
    // A second agent grading the first is the difference between a check and a
    // model marking its own homework. Optional, because it costs another run.
    checkAgentId: raw.checkAgentId || null,
    maxAttempts: Number.isFinite(max) ? Math.min(MAX_ATTEMPTS, Math.max(1, Math.round(max))) : DEFAULT_ATTEMPTS,
    state: existing?.state || 'pending',
    attempts: existing?.attempts || 0,
    sessionId: existing?.sessionId || null,
    checkSessionId: existing?.checkSessionId || null,
    lastFail: existing?.lastFail || null,
    startedAt: existing?.startedAt || null,
    finishedAt: existing?.finishedAt || null
  }
}

/** What to say to the agent doing the work, including why the last try failed. */
export function workPrompt (loop, step) {
  const parts = [loop.detail ? `Goal of this loop: ${loop.title}\n${loop.detail}` : `Goal of this loop: ${loop.title}`]
  parts.push(`Step ${loop.currentStep + 1} of ${loop.steps.length}: ${step.title}`)
  if (step.prompt) parts.push(step.prompt)
  if (step.check) parts.push(`This step is finished when: ${step.check}`)
  if (step.lastFail) {
    // ⚠️ THE REASON TRAVELS WITH THE RETRY. A loop that silently reruns the same
    // prompt gets the same answer; the only thing that makes the second attempt
    // different from the first is knowing what was wrong with the first.
    parts.push(`A previous attempt did not pass the check. What was wrong: ${step.lastFail}\nFix that specifically.`)
  }
  return parts.join('\n\n')
}

/** What to say to whoever is grading it. */
export function checkPrompt (loop, step, sameSession) {
  return [
    'You are checking one step of a loop, not continuing it. Do no new work: inspect what is there and judge it.',
    sameSession
      ? 'Judge the work in this conversation.'
      : `Judge work that was just done in ${loop.cwd || 'the working folder'} by another agent. Read whatever you need to.`,
    `Step: ${step.title}`,
    `It passes only if: ${step.check}`,
    'Reply with one final line, exactly one of:\nVERDICT: PASS\nVERDICT: FAIL — <one sentence naming what is missing or wrong>'
  ].join('\n\n')
}

// ⚠️ READ THE VERDICT FROM THE TRANSCRIPT, NOT FROM THE CLIENT. If the browser
// reported pass/fail, a loop could be made to pass by a client that lied or that
// simply lost the stream. The server reads the assistant's own last message.
//
// ⚠️ AND THE LAST VERDICT WINS. A model that restates the format it was given
// ("reply with VERDICT: PASS or VERDICT: FAIL") before answering would otherwise
// have its own instructions read back as its answer — a step that passes because
// the word PASS appeared first in the message.
// ⚠️ SPACES AND TABS, NEVER \s. `\s` matches a newline, so `\s*` after the word
// PASS ran on into the NEXT line and swallowed it: the two-line block
// "VERDICT: PASS\nVERDICT: FAIL — …" matched ONCE, as a pass, with the failing
// verdict eaten as its reason. That block is the exact thing this file tells the
// checker to choose between, so a model that quoted its instructions back would
// have passed every step it was asked to judge.
// The verdict must START a line. Allowing it mid-sentence would make "I would
// not say VERDICT: PASS here" a pass, and the whole layer rests on this one
// match. A model that buries it in a paragraph gets "did not answer", which
// costs an attempt and never costs a false pass — the prompt asks for one final
// line, and being strict is the safe direction to be wrong in. List and quote
// markers are allowed because models add them unbidden.
const VERDICT_RE = /^[ \t]*(?:[-*>][ \t]*)*(?:\*\*)?VERDICT(?:\*\*)?[ \t]*[::][ \t]*(?:\*\*)?(PASS|FAIL)\b(?:\*\*)?[ \t]*[—\-–:.]*[ \t]*(.*)$/gim

export function readVerdict (text) {
  const s = String(text || '')
  let last = null, m
  VERDICT_RE.lastIndex = 0
  while ((m = VERDICT_RE.exec(s))) last = m
  // ⚠️ NO VERDICT IS A FAIL, NOT A PASS. Treating an unparseable answer as
  // success is the failure that makes the whole layer worthless: the one case
  // where the check did not actually happen is the one where it must not say
  // the step is done. It costs an attempt, which is bounded.
  if (!last) return { pass: false, reason: 'The check did not answer PASS or FAIL.' }
  if (last[1].toUpperCase() === 'PASS') return { pass: true, reason: '' }
  return { pass: false, reason: (last[2] || '').trim() || 'The check said this step is not done.' }
}
