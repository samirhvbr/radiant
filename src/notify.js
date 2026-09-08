/**
 * Notifications — the one way Radiant can reach you when it is not the window
 * you are looking at.
 *
 * ⚠️ IT COULD NOT, AT ALL. There was no `Notification` anywhere in this app:
 * not in the renderer, not in the main process. A turn that failed, a turn that
 * finished after ten minutes of tool use, and a turn sitting on an approval
 * prompt were all equally silent — the only way to find out was to go and look.
 * Tony: "still having lots of failures within chats and no notification at all."
 *
 * Two rules keep this from becoming the other kind of problem:
 *
 *   1. NOTHING WHILE YOU ARE WATCHING. A notification about the window you are
 *      already reading is noise, and macOS will happily show it anyway — the
 *      check is ours to make. Focus, not just visibility: a Radiant window
 *      behind Xcode is still a window you are not reading.
 *   2. ONE PER CHAT. The tag is the session id, so a finish replaces the
 *      approval prompt that preceded it instead of stacking under it.
 *
 * ⚠️ THE TWO DECISIONS ARE PURE FUNCTIONS, AND ON PURPOSE. "Do we notify?" and
 * "what does it say?" are the only parts that can be wrong in a way you would
 * notice, and both of them sit behind an OS call that cannot run in a test.
 * Same lesson as the phone's download math: keep the arithmetic out of the
 * thing that needs a device. scripts/test-notify.mjs runs them.
 */

/** Are we looking at Radiant right now? Both halves matter — see rule 1. */
export function shouldNotify ({ hidden, focused }) {
  return Boolean(hidden) || !focused
}

/**
 * A notification is a headline. The OS truncates mid-word, which reads worse
 * than a clean stop, and a body with newlines in it renders as one run-on line
 * anyway.
 */
export function trimBody (text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
}

/**
 * What to say about a turn that just ended.
 *
 * ⚠️ THE LAST TEXT, NOT THE FIRST. Parts arrive in order and the useful one is
 * whatever the model said last — with tools in between there can be several,
 * and the opening "I'll take a look" is the least informative line in the turn.
 * A turn that was all tools and no prose has no line at all, which is not an
 * error: it still finished, and saying so is the point.
 */
export function turnBody ({ sawEnd, parts }) {
  if (!sawEnd) return 'That turn stopped before it finished.'
  const tail = [...(parts || [])].reverse().find(p => p?.type === 'text' && String(p.text || '').trim())
  return trimBody(tail ? tail.text : 'Finished.')
}

let asked = false

/**
 * ⚠️ ASK ONCE, AND NEVER EXPECT THE FIRST ONE TO LAND. A browser that has not
 * been asked yet cannot show this notification, and the prompt takes as long as
 * the person takes — requesting here means the NEXT one gets through. Electron
 * answers 'granted' without any of this, and never reaches here anyway.
 */
function webAllowed () {
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'default' && !asked) {
    asked = true
    try { Notification.requestPermission() } catch { /* older browsers */ }
  }
  return false
}

/**
 * Tell the user something happened in a chat they are not watching.
 * `sessionId` both tags the notification and is what a click opens.
 *
 * The native path goes through the main process, which owns the app identity
 * and can actually bring Radiant forward on a click. The web path is for a
 * phone or another Mac on the Tailscale address, where there is no main process
 * to ask.
 */
export function notifyAway ({ title, body, sessionId }) {
  let here = { hidden: false, focused: true }
  try { here = { hidden: document.hidden, focused: document.hasFocus() } } catch { /* no document */ }
  if (!shouldNotify(here)) return
  const payload = { title: title || 'Radiant', body: trimBody(body), sessionId: sessionId || null }
  if (window.radiantNative?.notify) { try { window.radiantNative.notify(payload); return } catch { /* fall through */ } }
  if (!webAllowed()) return
  try {
    const n = new Notification(payload.title, { body: payload.body, tag: payload.sessionId || 'radiant' })
    n.onclick = () => {
      try { n.close() } catch {}
      try { window.focus() } catch {}
    }
  } catch { /* a browser that says granted and then refuses */ }
}
