/**
 * Does the Linux helper press the keys it was asked for?
 *
 * ⚠️ THIS IS THE ONE PART OF THE HELPER THAT CAN BE WRONG IN SILENCE. Everything
 * else there moves a real mouse or fails loudly. A bad translation presses the
 * wrong keys, exits 0, and tells the model it worked — and the model believes
 * it, because there is nothing to believe otherwise.
 *
 * Two rules it has to keep:
 *   · cmd MEANS THE COPY MODIFIER. A model told it is driving a desktop emits
 *     "cmd+c"; mapping cmd to Super literally would open the GNOME overview.
 *     Ctrl is what the user's own hands would press for the same intent.
 *   · A MODIFIER WE DO NOT KNOW IS A REFUSAL, NOT A SHRUG. Dropping it and
 *     pressing the bare key turns "fn+left" into "Left" and reports success.
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { xdotoolKey } = require('../gnome/radiant-control.cjs')

let pass = 0, fail = 0
const results = []
const ok = (what, cond) => { cond ? pass++ : fail++; results.push(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`) }
const is = (what, got, want) => ok(`${what} → ${JSON.stringify(want)}${got === want ? '' : `, got ${JSON.stringify(got)}`}`, got === want)
const refuses = (what, spec) => {
  let threw = false
  try { xdotoolKey(spec) } catch { threw = true }
  ok(`${what} is refused rather than guessed`, threw)
}

// the intent-preserving translation
is('cmd+c', xdotoolKey('cmd+c'), 'ctrl+c')
is('command+a', xdotoolKey('command+a'), 'ctrl+a')
is('meta+v', xdotoolKey('meta+v'), 'ctrl+v')
is('ctrl+c stays itself', xdotoolKey('ctrl+c'), 'ctrl+c')
is('super+l', xdotoolKey('super+l'), 'super+l')
is('cmd+shift+z keeps both', xdotoolKey('cmd+shift+z'), 'ctrl+shift+z')
is('opt maps to alt', xdotoolKey('opt+tab'), 'alt+Tab')

// names the Swift helper accepts, spelled the way xdotool wants
is('return', xdotoolKey('return'), 'Return')
is('enter is the same key', xdotoolKey('enter'), 'Return')
is('escape', xdotoolKey('escape'), 'Escape')
is('esc', xdotoolKey('esc'), 'Escape')
is('delete is backspace', xdotoolKey('delete'), 'BackSpace')
is('forwarddelete is not', xdotoolKey('forwarddelete'), 'Delete')
is('pagedown', xdotoolKey('pagedown'), 'Next')
is('space', xdotoolKey('space'), 'space')
is('f5 is uppercased', xdotoolKey('f5'), 'F5')
is('a plain letter is left alone', xdotoolKey('a'), 'a')

// ⚠️ the cases that used to lie
refuses('an unknown modifier (fn)', 'fn+left')
refuses('a typo for a modifier', 'ctrlx+c')
refuses('a combo with no key at all', 'ctrl+')
refuses('a bare plus', '+')
refuses('an empty spec', '')

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  the desktop helper presses what it was asked for`)
process.exit(fail ? 1 : 0)
