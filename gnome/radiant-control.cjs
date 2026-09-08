#!/usr/bin/env node
/**
 * Radiant desktop control helper for Linux — the X11 counterpart to
 * native/RadiantControl.swift, speaking the same command language so
 * server/computer.js does not have to care which one it is talking to.
 *
 * `screensize`, `move`, `click`, `doubleclick`, `rightclick`, `drag`, `scroll`,
 * `type`, `key` and `permissions` behave exactly as the Swift helper's do. The
 * iCloud commands (`ubiquity`, `icloud`, `fetch`) are absent on purpose: they
 * ask Foundation about a service this platform does not have, and answering
 * them with a guess would be worse than not answering.
 *
 * ⚠️ THIS IS A SCRIPT, NOT A COMPILED BINARY, AND THAT IS THE POINT. The macOS
 * helper has to be Mach-O because CGEvent and Speech are Apple frameworks. Here
 * the whole job is driving xdotool and ImageMagick, so a compiled artefact would
 * buy nothing and cost a toolchain, a build step in `dist`, and one more thing
 * that can ship for the wrong architecture — which is exactly how a Mach-O
 * binary ended up inside a Linux AppImage.
 *
 * ⚠️ X11 ONLY, AND IT SAYS SO RATHER THAN FAILING QUIETLY. XTest — what xdotool
 * uses to synthesise input — is refused by Wayland by design: no client may
 * type into another client's window. There is no flag that fixes it, so on a
 * Wayland session `permissions` reports false with a reason, and the app can
 * tell the user the true thing instead of letting every click land nowhere.
 */
'use strict'
const { execFileSync } = require('child_process')

const args = process.argv.slice(2)
const cmd = args[0]

const run = (bin, argv, timeout = 15000) => execFileSync(bin, argv.map(String), { encoding: 'utf8', timeout }).trim()
const has = bin => { try { execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true } catch { return false } }
const isWayland = () => (process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY)

/** ImageMagick 7 renamed the tools; accept either, prefer whichever is present. */
const captureTool = () => (has('import') ? 'import' : has('magick') ? 'magick' : null)
// ⚠️ THERE IS DELIBERATELY NO RESIZE HERE. macOS downscales the capture with
// `sips` because screencapture yields Retina pixels while CGEvent takes points,
// and the two have to be made to agree. On X11 the root window we capture and
// the space xdotool clicks in are the same pixels already, so scaling would
// create the mismatch rather than remove it.

/**
 * ⚠️ cmd MEANS "THE COPY MODIFIER", NOT "THE SUPER KEY". A model that has been
 * told it is driving a desktop emits "cmd+c" for copy, and mapping cmd to Super
 * literally would send Super+C — which on GNOME does nothing, or opens the
 * overview. Ctrl is what the user's own hands would press for the same intent,
 * so that is the honest translation. computer-tools.js also names the local
 * modifier in the tool description, so a model that reads it gets it right the
 * first time and never relies on this.
 */
const MODIFIERS = {
  cmd: 'ctrl', command: 'ctrl', meta: 'ctrl',
  ctrl: 'ctrl', control: 'ctrl',
  shift: 'shift',
  alt: 'alt', option: 'alt', opt: 'alt',
  super: 'super', win: 'super'
}

/** Names the Swift helper accepts, in the spelling xdotool wants. */
const KEYS = {
  return: 'Return', enter: 'Return', tab: 'Tab', space: 'space',
  delete: 'BackSpace', backspace: 'BackSpace', forwarddelete: 'Delete',
  escape: 'Escape', esc: 'Escape',
  left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next'
}

/**
 * ⚠️ A MODIFIER WE DO NOT KNOW IS A REFUSAL, NOT A SHRUG. This mapped the parts
 * it recognised and dropped the rest, so "fn+left" pressed Left and "hyper+c"
 * pressed c — the wrong keystroke, exit 0, and the model told it worked. That is
 * the only thing in this file that can be wrong in silence, which is exactly why
 * it must not be. Same for a spec with no key in it: "ctrl+" popped "ctrl" as
 * the key and pressed Ctrl on its own.
 *
 * scripts/test-desktop-keys.mjs pins both, and the intent-preserving cmd→ctrl
 * translation above.
 */
function xdotoolKey (spec) {
  const parts = String(spec == null ? '' : spec).split('+').map(s => s.trim())
  if (parts.length === 0 || parts.some(p => !p)) {
    throw new Error(`"${spec}" is not a key combination Radiant can press.`)
  }
  const key = parts.pop()
  const mods = parts.map(m => {
    const mapped = MODIFIERS[m.toLowerCase()]
    if (!mapped) throw new Error(`"${m}" is not a modifier Radiant knows how to press on this desktop.`)
    return mapped
  })
  const low = key.toLowerCase()
  const named = KEYS[low] || (/^f([1-9]|1[0-9]|2[0-4])$/.test(low) ? key.toUpperCase() : key)
  return [...mods, named].join('+')
}

function fail (message) {
  process.stderr.write(message + '\n')
  process.exit(1)
}

function requireInput () {
  if (isWayland()) fail('This is a Wayland session. X11 input synthesis (XTest) is refused there by design, so Radiant cannot drive the desktop.')
  if (!has('xdotool')) fail('xdotool is not installed. Install it (apt install xdotool) to let Radiant drive the desktop.')
}

// ⚠️ THE KEY MAPPER IS THE ONLY PART THAT CAN BE WRONG IN SILENCE, so it is the
// part that gets a gate. Everything else here either moves a real mouse or
// fails loudly; a bad translation presses the wrong keys, exits 0, and reports
// success to the model. scripts/test-desktop-keys.mjs pins it.
module.exports = { xdotoolKey }
if (require.main !== module) return

switch (cmd) {
  /**
   * ⚠️ ASK THE SYSTEM, DO NOT ASSUME — the same rule the Swift helper carries.
   * There it is TCC; here it is whether the session can be driven at all and
   * whether the two tools exist. Reporting "ready" because a file is on disk is
   * the bug that cost a session on macOS, and it is available to repeat here.
   */
  case 'permissions': {
    const wayland = isWayland()
    const out = {
      screenRecording: !wayland && Boolean(captureTool()),
      accessibility: !wayland && has('xdotool')
    }
    // Extra, and ignored by callers that only read the two booleans above: the
    // reason, so the UI can say what to do instead of only that it cannot.
    if (wayland) out.reason = 'wayland'
    else if (!out.accessibility && !out.screenRecording) out.reason = 'missing:xdotool,imagemagick'
    else if (!out.accessibility) out.reason = 'missing:xdotool'
    else if (!out.screenRecording) out.reason = 'missing:imagemagick'
    process.stdout.write(JSON.stringify(out))
    break
  }

  /**
   * ⚠️ THE WHOLE X SCREEN, NOT THE PRIMARY MONITOR. `xdotool getdisplaygeometry`
   * is the obvious call and it is the wrong one. Measured on a two-monitor
   * desktop (HDMI-0 at +0+0, DP-4 at +2560+0): it answers 2560x1440, while the
   * root window we capture is 5120x1440 and `xdotool mousemove 4000 700` lands
   * happily on the second screen. So the screenshot the model sees and the space
   * its clicks are interpreted in would have disagreed by exactly one monitor —
   * every click on the right-hand screen silently landing on the left one, and
   * nothing anywhere reporting an error.
   *
   * The root window is the thing we screenshot, so its geometry is the one
   * answer that cannot drift from the image. xdpyinfo and xrandr are asked in
   * turn because neither is guaranteed installed; getdisplaygeometry is kept as
   * a last resort, where being right about one monitor beats returning nothing.
   */
  case 'screensize': {
    const fromXdpyinfo = () => {
      const m = run('xdpyinfo', []).match(/dimensions:\s+(\d+)x(\d+)/)
      return m && `${m[1]} ${m[2]}`
    }
    const fromXrandr = () => {
      const m = run('xrandr', ['--query']).match(/current\s+(\d+)\s*x\s*(\d+)/)
      return m && `${m[1]} ${m[2]}`
    }
    const fromXdotool = () => run('xdotool', ['getdisplaygeometry']).split(/\s+/).slice(0, 2).join(' ')

    let size = null
    for (const [bin, fn] of [['xdpyinfo', fromXdpyinfo], ['xrandr', fromXrandr], ['xdotool', fromXdotool]]) {
      if (!has(bin)) continue
      try { size = fn() } catch { /* try the next one */ }
      if (size) break
    }
    if (!size) fail('Could not determine the screen size — none of xdpyinfo, xrandr or xdotool answered.')
    process.stdout.write(size)
    break
  }

  case 'screenshot': {
    const dest = args[1]
    if (!dest) fail('screenshot needs an output path.')
    if (isWayland()) fail('This is a Wayland session; the screen cannot be captured this way.')
    const tool = captureTool()
    if (!tool) fail('ImageMagick is not installed. Install it (apt install imagemagick) to let Radiant see the screen.')
    if (tool === 'magick') run('magick', ['import', '-window', 'root', dest])
    else run('import', ['-window', 'root', dest])
    break
  }

  case 'move':
    requireInput()
    run('xdotool', ['mousemove', args[1], args[2]])
    break

  case 'click':
  case 'rightclick':
  case 'doubleclick': {
    requireInput()
    const button = cmd === 'rightclick' ? '3' : '1'
    const repeat = cmd === 'doubleclick' ? ['--repeat', '2', '--delay', '80'] : []
    run('xdotool', ['mousemove', args[1], args[2], 'click', ...repeat, button])
    break
  }

  case 'drag':
    requireInput()
    // Press, travel, release. --sync on the moves so the window manager sees a
    // drag rather than a teleport, which is what a one-shot mousemove looks like.
    run('xdotool', ['mousemove', args[1], args[2], 'mousedown', '1'])
    run('xdotool', ['mousemove', '--sync', args[3], args[4]])
    run('xdotool', ['mouseup', '1'])
    break

  case 'scroll': {
    requireInput()
    // ⚠️ NOT `Number(x) || 0`. That turned a dy of 0 — and any value that is not a
    // number — into one scroll-wheel click DOWNWARD, because the sign test below
    // reads 0 as "not positive". Asking to scroll by nothing must move nothing.
    const dy = Number(args[3])
    if (!Number.isFinite(dy) || dy === 0) break
    // Button 4 is up, 5 is down; the Swift helper takes positive dy as up.
    const button = dy > 0 ? '4' : '5'
    const clicks = Math.min(50, Math.max(1, Math.round(Math.abs(dy) / 40)))
    run('xdotool', ['mousemove', args[1], args[2], 'click', '--repeat', clicks, button])
    break
  }

  case 'type': {
    requireInput()
    // ⚠️ NOT THROUGH A SHELL, AND NOT SPLIT ON SPACES. The text is whatever the
    // model produced — quotes, backticks, newlines, a semicolon. execFile passes
    // it as one argv entry, which is the only reason this is safe to hand a
    // string that came out of a language model.
    //
    // ⚠️ AND `--` BEFORE IT, because that same model produces text beginning with
    // a dash all the time — a diff line, a markdown bullet, a flag it is quoting.
    // Without the terminator xdotool reads it as an option and refuses.
    const text = args.slice(1).join(' ')
    // ⚠️ A TIMEOUT THAT DOES NOT SCALE CUTS THE TEXT IN HALF. At --delay 12 a
    // fixed 15s ceiling stops around 1250 characters — and the half already typed
    // is in the user's document, where nothing can take it back. Give it the time
    // the length actually needs, with headroom.
    const budget = 5000 + text.length * 20
    run('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--', text], budget)
    break
  }

  case 'key':
    requireInput()
    // xdotoolKey throws on something it will not guess at; that is a refusal the
    // user should read, not a stack trace they have to interpret.
    try {
      run('xdotool', ['key', '--clearmodifiers', xdotoolKey(args[1])])
    } catch (e) {
      fail(e.message)
    }
    break

  default:
    fail(`usage: radiant-control <permissions|screensize|screenshot|move|click|rightclick|doubleclick|drag|scroll|type|key> ...`)
}
