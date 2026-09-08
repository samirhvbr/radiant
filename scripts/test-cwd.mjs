/**
 * The folder a turn runs in — the bug that made whole chats useless.
 *
 * Sessions sync between Macs; a folder path does not. Every chat started on
 * Tony's other Mac arrived here pointing at /Users/opensource, which is not a
 * directory on this machine, and `spawn` fails before the shell starts. The
 * agent saw "[exit code ENOENT]" — no folder named, no reason — for `pwd`, for
 * `ls`, for everything, and spent all thirty of its tool rounds theorising.
 *
 * None of that needed a model, a key or a network. It needed this file.
 *
 *   node scripts/test-cwd.mjs
 */
import os from 'os'
import fs from 'fs'
import path from 'path'
import { usableCwd } from '../server/config.js'
import { runTool } from '../server/tools.js'

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok && detail !== undefined) console.log(`    got ${JSON.stringify(detail)}`)
}

// A path that cannot exist here, standing in for the other Mac's home folder.
const STRAY = path.join('/Users', 'radiant-test-no-such-user')
const HERE = process.cwd()

// ── usableCwd ───────────────────────────────────────────────────────────────
const stray = usableCwd(STRAY)
check('a folder from another Mac is replaced with one that is here', stray.dir !== STRAY && fs.existsSync(stray.dir), stray)
check('…and it says which folder was missing, so the chat can tell the user', stray.missing === STRAY, stray)

const real = usableCwd(HERE)
check('a folder that is here is left exactly alone', real.dir === HERE && real.missing === null, real)

const none = usableCwd(null)
check('no folder set falls back to home, and that is not a failure', none.dir === os.homedir() && none.missing === null, none)

// ⚠️ THE SUBSTITUTION MUST NOT BE WRITTEN BACK. The path is correct on the Mac
// that set it; rewriting it here would break the chat there instead, forever
// ping-ponging between the two.
check('substituting does not rewrite the session', usableCwd(STRAY).missing === STRAY)

// ── the tools ───────────────────────────────────────────────────────────────
// This is the exact call that produced "[exit code ENOENT]" in Tony's chat.
const out = await runTool('run_command', { command: 'pwd' }, STRAY)
check('run_command in a missing folder names the folder', out.includes(STRAY), out)
check('…and says nothing was run, rather than an exit code', /nothing was run/i.test(out) && !/exit code/i.test(out), out)
check('…and tells the model not to keep trying', /same way|does not exist/i.test(out), out)

const good = await runTool('run_command', { command: 'pwd' }, HERE)
check('run_command in a real folder still runs there', good.trim() === HERE, good)

// A command that fails on its own terms is a different thing and must still
// report its exit code — that is the shell's answer, not a broken folder.
const failing = await runTool('run_command', { command: 'exit 3' }, HERE)
check('a real failure still reports its exit code', failing.includes('[exit code 3]'), failing)

console.log(failed ? `\n${failed} failed` : '\nall working-folder cases pass')
process.exit(failed ? 1 : 0)
