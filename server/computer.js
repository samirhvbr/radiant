import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const execFileP = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * The desktop helper for THIS platform. In the packaged app it is unpacked
 * beside server/.
 *
 * ⚠️ TWO HELPERS, ONE COMMAND LANGUAGE. native/radiant-control is Mach-O because
 * CGEvent and Speech are Apple frameworks; gnome/radiant-control.cjs is a script
 * because its whole job is driving xdotool and ImageMagick, and compiling that
 * would buy nothing but a toolchain. They answer the same commands, so
 * everything below this function is platform-blind.
 */
const HELPERS = {
  darwin: ['native', 'radiant-control'],
  linux: ['gnome', 'radiant-control.cjs']
}

export function helperPath () {
  const rel = HELPERS[process.platform]
  if (!rel) return null
  const candidates = [
    path.join(__dirname, '..', ...rel),
    path.join(process.resourcesPath || '', ...rel)
  ]
  return candidates.find(p => { try { return fs.existsSync(p) } catch { return false } }) || candidates[0]
}

/**
 * What macOS actually allows, asked of macOS.
 *
 * ⚠️ THE STATUS USED TO BE `helperAvailable()` — a check that this binary exists on
 * disk — presented in Settings as "Screen Recording and Accessibility are granted
 * — ready to use". It never asked about permissions at all. So the screen said
 * everything was fine while screencapture returned a wallpaper-only image (exit 0,
 * no error) and CGEvents went nowhere, and an agent handed the same lie invented
 * tccutil commands for a bundle id that does not exist.
 *
 * Both underlying calls are read-only and never prompt, so this is safe to poll.
 */
export async function permissions () {
  if (!helperAvailable()) return { helper: false, screenRecording: false, accessibility: false }
  try {
    const out = await runHelper(['permissions'], 5000)
    const j = JSON.parse(out.stdout.trim())
    // `reason` is optional and only the Linux helper sets it. macOS has a
    // Settings pane to send people to; Linux has a missing package or a Wayland
    // session, which are different problems with different answers, and "not
    // granted" is not either of them.
    return {
      helper: true,
      screenRecording: Boolean(j.screenRecording),
      accessibility: Boolean(j.accessibility),
      ...(j.reason ? { reason: String(j.reason) } : {})
    }
  } catch {
    // An older helper has no `permissions` command. Say we do not know rather than
    // claiming either answer.
    return { helper: true, screenRecording: null, accessibility: null }
  }
}

/**
 * ⚠️ THE RIGHT HELPER FOR THIS PLATFORM, NOT ANY FILE OF THAT NAME. extraResources
 * used to copy native/radiant-control into every packaged target, and the file
 * being there was the whole test — so off a Mac this said the helper was
 * present, execFile then failed with ENOEXEC, and permissions() answered
 * `{ helper: true, screenRecording: null }` from its catch: the right reply for
 * an OLD helper and a lie about one that cannot run here at all.
 *
 * helperPath() now returns null on a platform we ship nothing for, which is the
 * honest answer and the one that keeps that bug from coming back by another
 * route — a stale build, a hand-copied file, a helper for the wrong arch.
 */
export function helperAvailable () {
  const p = helperPath()
  if (!p) return false
  try { return fs.existsSync(p) } catch { return false }
}

let ensuredExec = false
function ensureExecutable () {
  if (ensuredExec) return
  try { fs.chmodSync(helperPath(), 0o755) } catch {}
  ensuredExec = true
}

/**
 * ⚠️ A SCRIPT HELPER RUNS ON OUR OWN RUNTIME, NEVER ON `env node`. The Linux
 * helper starts `#!/usr/bin/env node`, and the AppImage bundles Electron — not
 * node. On a machine without node installed the shebang fails with ENOENT, so
 * desktop control would work on every developer's box and on nobody else's:
 * exactly the class of bug you cannot see from where you built it.
 *
 * process.execPath is node when the server runs under node and Electron when it
 * runs inside the app, and ELECTRON_RUN_AS_NODE turns the second into the first.
 * One line, no new dependency, and the helper never has to be found on a PATH.
 */
async function runHelper (args, timeout) {
  const helper = helperPath()
  // ⚠️ SAY WHICH PLATFORM, NOT "cannot read properties of null". helperPath()
  // returns null where we ship no helper, and every desktop.* method reaches
  // here without asking helperAvailable() first — so this is the message a
  // Windows user would otherwise never get instead of a TypeError.
  if (!helper) throw new Error(`Radiant has no desktop helper for ${process.platform}.`)
  const argv = args.map(String)
  // Read the environment now rather than at import: a snapshot taken at module
  // load cannot see anything set afterwards.
  return helper.endsWith('.cjs')
    ? execFileP(process.execPath, [helper, ...argv], { timeout, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    : execFileP(helper, argv, { timeout })
}

async function ctl (...args) {
  // ⚠️ THE chmod BELONGS HERE AND ONLY HERE, exactly where it was. Moving it
  // into runHelper() put it in permissions() too — a status poll that used to
  // read the helper and now writes to it. Small, defensible, and not what the
  // Mac did before, which is the only thing that matters for a claim that
  // nothing about a Mac changes.
  ensureExecutable() // packaging can strip the exec bit off the bundled helper
  const { stdout } = await runHelper(args, 15000)
  return stdout.trim()
}

// logical screen size in points — the coordinate space for clicks/screenshots
let cachedSize = null
export async function screenSize () {
  if (cachedSize) return cachedSize
  const out = await ctl('screensize')
  const [w, h] = out.split(/\s+/).map(Number)
  cachedSize = { width: w, height: h }
  return cachedSize
}

// capture the main display, normalized to point size, returned as base64 png.
// screencapture yields Retina pixels; we downscale to points so the model's
// click coordinates map 1:1 onto CGEvent points.
export async function screenshot () {
  const tmp = path.join(os.tmpdir(), `radiant-shot-${process.pid}.png`)
  if (process.platform === 'darwin') {
    const { width } = await screenSize()
    await execFileP('screencapture', ['-x', '-t', 'png', tmp], { timeout: 15000 })
    // downscale to logical width with sips (built in), keeping aspect
    await execFileP('sips', ['-Z', String(width), tmp], { timeout: 15000 }).catch(() => {})
  } else {
    // ⚠️ THE HELPER CAPTURES, NOT US. screencapture and sips are macOS binaries;
    // asking the helper keeps the one rule that makes clicks land — the image and
    // the coordinate space come from the same place. It captures the X root
    // window, which is what screensize measures, so the mapping is 1:1 and there
    // is nothing to downscale.
    await ctl('screenshot', tmp)
  }
  const data = fs.readFileSync(tmp)
  fs.unlink(tmp, () => {})
  return { dataB64: data.toString('base64'), mime: 'image/png' }
}

export const desktop = {
  screenshot,
  screenSize,
  move: (x, y) => ctl('move', x, y),
  click: (x, y, button = 'left') => ctl(button === 'right' ? 'rightclick' : 'click', x, y),
  doubleClick: (x, y) => ctl('doubleclick', x, y),
  drag: (x1, y1, x2, y2) => ctl('drag', x1, y1, x2, y2),
  scroll: (x, y, dy) => ctl('scroll', x, y, dy),
  type: text => ctl('type', text),
  key: spec => ctl('key', spec)
}
