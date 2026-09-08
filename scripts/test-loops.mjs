/**
 * What makes a loop a loop: the check, and what happens when it fails.
 *
 * ⚠️ THE VERDICT READER IS THE WHOLE FEATURE. Without it a "loop" is a numbered
 * list of tasks that all report success, which is what an agent already does. So
 * every way a model can answer badly — restating the format it was given,
 * bolding it, answering twice, answering not at all — is a case here.

 */
const { readVerdict, workPrompt, checkPrompt, normalizeStep, DEFAULT_ATTEMPTS, MAX_ATTEMPTS } =
  await import('../server/loop-rules.js')

let pass = 0, fail = 0
const results = []
const ok = (name, cond) => { cond ? pass++ : (fail++, results.push('  FAIL ' + name)) }

// ── the verdict ─────────────────────────────────────────────────────────────
ok('a clean PASS passes', readVerdict('Looks right.\nVERDICT: PASS').pass === true)
ok('a clean FAIL fails', readVerdict('VERDICT: FAIL — the tests were never run').pass === false)
ok('and the reason survives',
   readVerdict('VERDICT: FAIL — the tests were never run').reason === 'the tests were never run')
ok('markdown bolding does not hide the verdict', readVerdict('**VERDICT: PASS**').pass === true)
ok('a hyphen works as well as an em dash',
   readVerdict('VERDICT: FAIL - no file was written').reason === 'no file was written')

// ⚠️ THIS IS THE CASE THAT MATTERS. A model that quotes its instructions back
// ("reply with VERDICT: PASS or VERDICT: FAIL") before answering would otherwise
// have the format description read as the answer — and the first word is PASS.
ok('the LAST verdict wins, not the first',
   readVerdict('I was asked to reply VERDICT: PASS or VERDICT: FAIL.\n\nVERDICT: FAIL — nothing compiled').pass === false)

// ⚠️ NO VERDICT IS A FAIL. Treating an unparseable answer as success is the one
// failure that makes the whole layer worthless.
ok('silence is not a pass', readVerdict('I think that went well.').pass === false)
ok('and it says why', /did not answer/i.test(readVerdict('I think that went well.').reason))
ok('an empty message is not a pass', readVerdict('').pass === false)
// ⚠️ AND IT SAYS SOMETHING DIFFERENT. Seen live with a misconfigured model:
// every turn returned no text, so every check "did not answer PASS or FAIL" and
// the loop stopped pointing at a check condition that was never the problem.
ok('nothing at all is reported as nothing, not as a bad answer',
   /returned nothing/i.test(readVerdict('').reason) && readVerdict('').empty === true)
ok('whitespace counts as nothing', readVerdict('   \n  ').empty === true)
ok('and a real non-verdict answer is still reported as one',
   /did not answer/i.test(readVerdict('Looks fine to me.').reason) && !readVerdict('Looks fine to me.').empty)
ok('the word pass in prose is not a verdict', readVerdict('All of the tests pass now.').pass === false)
ok('a bare FAIL still carries a reason', readVerdict('VERDICT: FAIL').reason.length > 0)
ok('a bullet in front of it is still a verdict', readVerdict('- VERDICT: PASS').pass === true)
ok('and a quote marker', readVerdict('> **VERDICT: FAIL** — nothing ran').reason === 'nothing ran')
ok('a trailing full stop does not become the reason', readVerdict('VERDICT: PASS.').pass === true)
// ⚠️ MID-SENTENCE IS NOT A VERDICT. "I would not say VERDICT: PASS here" must
// not pass a step; the anchor to the start of a line is what prevents it.
ok('a verdict buried in a sentence does not count',
   readVerdict('I would not say VERDICT: PASS about this.').pass === false)

// ── the retry has to differ from the first attempt ───────────────────────────
const loop = { title: 'Ship the parser', detail: '', currentStep: 0, steps: [{}, {}] }
const step = { title: 'Write it', prompt: 'Write the parser.', check: 'npm test passes', lastFail: null }
const first = workPrompt(loop, step)
const retry = workPrompt(loop, { ...step, lastFail: 'the tests were never run' })
ok('the first attempt states the finish condition', first.includes('npm test passes'))
ok('the first attempt says which step it is', first.includes('Step 1 of 2'))
ok('a retry is not the same prompt as the first attempt', retry !== first)
ok('a retry carries the reason the last one failed', retry.includes('the tests were never run'))

// ── the checker must be told not to keep working ─────────────────────────────
const cp = checkPrompt(loop, step, true)
ok('the check forbids doing more work', /do no new work/i.test(cp))
ok('the check states the condition', cp.includes('npm test passes'))
ok('the check demands the format it will be parsed for', readVerdict(cp).pass === false)
ok('a second-agent check is told the work is elsewhere',
   /another agent/i.test(checkPrompt({ ...loop, cwd: '/tmp/x' }, step, false)))
ok('and a same-session check is not', !/another agent/i.test(cp))

// ── attempt bounds ──────────────────────────────────────────────────────────
ok('a step defaults to a bounded number of attempts', normalizeStep({ title: 'x' }).maxAttempts === DEFAULT_ATTEMPTS)
ok('zero attempts is not allowed', normalizeStep({ title: 'x', maxAttempts: 0 }).maxAttempts === 1)
ok('an unbounded retry is capped', normalizeStep({ title: 'x', maxAttempts: 9999 }).maxAttempts === MAX_ATTEMPTS)
ok('garbage falls back to the default', normalizeStep({ title: 'x', maxAttempts: 'lots' }).maxAttempts === DEFAULT_ATTEMPTS)
// Editing a loop must not reset the run it is in the middle of.
const kept = normalizeStep({ title: 'renamed' }, { id: 'step-abc', state: 'passed', attempts: 2, sessionId: 's1' })
ok('editing a step keeps its id', kept.id === 'step-abc')
ok('editing a step keeps what the run already did', kept.state === 'passed' && kept.attempts === 2)
ok('and takes the new title', kept.title === 'renamed')

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  a step is done when a check says so`)
process.exit(fail ? 1 : 0)
