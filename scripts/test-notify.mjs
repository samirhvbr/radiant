/**
 * The two decisions behind every notification: whether to send one, and what it
 * says. Both used to be nothing at all — Radiant had no Notification anywhere,
 * so a turn could fail, or sit on an approval prompt forever, in total silence.
 *
 * Each case below is a way that can go wrong without anyone noticing until it is
 * in front of Tony. Add one BEFORE fixing the next thing that does.
 *
 *   node scripts/test-notify.mjs
 */
import { shouldNotify, trimBody, turnBody } from '../src/notify.js'

let failed = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) console.log(`    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`)
}

// ── when ────────────────────────────────────────────────────────────────────
// The one that makes this feature obnoxious instead of useful: a notification
// about the window you are already reading.
eq('watching the window: silent', shouldNotify({ hidden: false, focused: true }), false)
eq('another app in front: notify', shouldNotify({ hidden: false, focused: false }), true)
// Radiant minimized or on another Space. Hidden and focused disagree here, and
// the visible-but-unfocused case above is why both are asked.
eq('hidden: notify', shouldNotify({ hidden: true, focused: false }), true)
eq('hidden while still nominally focused: notify', shouldNotify({ hidden: true, focused: true }), true)

// ── what ────────────────────────────────────────────────────────────────────
eq('a finished turn says what the model said last',
  turnBody({ sawEnd: true, parts: [{ type: 'text', text: 'Looking into it' }, { type: 'tool' }, { type: 'text', text: 'Fixed and pushed.' }] }),
  'Fixed and pushed.')

// A turn that was all tools — a build, a deploy — still finished, and that IS
// the news. Returning an empty body would post a notification with no text.
eq('a turn with no prose still says it finished',
  turnBody({ sawEnd: true, parts: [{ type: 'tool' }, { type: 'tool' }] }),
  'Finished.')
eq('whitespace-only text does not count as the answer',
  turnBody({ sawEnd: true, parts: [{ type: 'text', text: '   \n' }] }),
  'Finished.')
eq('no parts at all', turnBody({ sawEnd: true, parts: [] }), 'Finished.')
eq('undefined parts', turnBody({ sawEnd: true }), 'Finished.')

// The dropped-connection turn: the client shows a banner for this, and the
// notification is how you learn about it from the next room.
eq('a dropped turn says so, not what it managed to say first',
  turnBody({ sawEnd: false, parts: [{ type: 'text', text: 'On it' }] }),
  'That turn stopped before it finished.')

// A turn that ran out of tool rounds ends with `done` like any other, so this is
// the only thing that keeps it from being announced as a finished answer.
eq('a halted turn is labelled as one, and still carries the wrap-up',
  turnBody({ sawEnd: true, parts: [{ type: 'text', text: 'Two packs are in, Scrollcraft is not.' }, { type: 'halt', reason: 'rounds', text: 'Used its limit of 30 rounds.' }] }),
  'Stopped early — Two packs are in, Scrollcraft is not.')
eq('a halt with no wrap-up still says something',
  turnBody({ sawEnd: true, parts: [{ type: 'halt', reason: 'rounds', text: 'Used its limit of 30 rounds.' }] }),
  'Stopped early — Used its limit of 30 rounds.')

// ── the body itself ─────────────────────────────────────────────────────────
eq('newlines collapse — the OS renders one line whatever we send',
  trimBody('Done.\n\n- one\n- two'), 'Done. - one - two')
eq('trimmed to a headline', trimBody('x'.repeat(300)).length, 160)
eq('nothing is empty, not "undefined"', trimBody(undefined), '')
eq('a long answer is cut, not padded',
  turnBody({ sawEnd: true, parts: [{ type: 'text', text: 'y'.repeat(400) }] }).length, 160)

console.log(failed ? `\n${failed} failed` : '\nall notification cases pass')
process.exit(failed ? 1 : 0)
