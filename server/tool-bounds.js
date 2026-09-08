/**
 * Every tool result passes through here, and nothing gets to skip it.
 *
 * ⚠️ TRUNCATION WAS OPT-IN, AND OPT-IN GUARANTEES UNEVEN COVERAGE. Three of
 * Radiant's twelve tools called the truncate helper. `fetch_url` returned a
 * whole web page, `web_search` and `search_sessions` returned unbounded text,
 * and an MCP server's reply went from the socket into the model with nothing in
 * between. Authors who did not know the helper existed rolled their own; authors
 * who never imagined a huge result rolled nothing. One 2 MB page is a blown
 * context window and a real bill.
 *
 * Sending a megabyte to a model may be worth keeping as a capability. It should
 * be an OPT-OUT, at one central implementation — not truncation being an opt-in
 * to good design.
 *
 * ⚠️ AND THE NOTICE IS NOT PART OF THE DATA. A warning glued onto the end of the
 * text leaves the model guessing where the tool's output stops and the harness's
 * commentary starts — and anything that reads the output programmatically has to
 * parse our notices out of it first. The notice goes in its own field.
 *
 * The same argument applies to time. `run_command` had a 120s cap and
 * `fetch_url` had 20s; an MCP call or a desktop-control call had none at all, so
 * one hung server hung the turn with no way out. A blocking budget belongs to
 * the layer that calls tools, not to each tool that happens to run long.
 */

// About 10k tokens of text. Past this a result is costing more than it says.
export const MAX_RESULT_CHARS = 40_000

// How long any single tool may block. run_command keeps its own shorter cap;
// this is the backstop for everything that never had one.
export const MAX_TOOL_MS = 180_000

/** Tools allowed to return more than the cap, because their whole job is bulk. */
const NO_TRUNCATE = new Set()

export function boundResult (name, text, { max = MAX_RESULT_CHARS } = {}) {
  const s = typeof text === 'string' ? text : (text == null ? '' : String(text))
  if (NO_TRUNCATE.has(name) || s.length <= max) return { text: s, truncated: 0 }
  // Keep the head AND the tail. A truncated command result whose exit line was
  // cut off is worse than useless: the model reads a successful-looking prefix
  // and concludes the thing worked.
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return {
    text: s.slice(0, head) + '\n\n…\n\n' + s.slice(s.length - tail),
    truncated: s.length - max
  }
}

/**
 * Run one tool call under a time budget.
 *
 * ⚠️ THE TIMEOUT DOES NOT STOP THE WORK, AND SAYS SO. JavaScript has no way to
 * kill an async call that ignores its signal, so this races the call and reports
 * the timeout — the underlying work may still be burning resources. That is a
 * true statement about the runtime, and pretending otherwise is how a "timeout"
 * becomes a lie. Where a real kill boundary exists (execFile's signal, a child
 * process) the tool uses it; this is the backstop for everything else.
 */
export async function withBudget (name, ms, fn) {
  let timer
  const started = Date.now()
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new ToolTimeout(name, ms)), ms) })
    ])
  } finally { clearTimeout(timer, started) }
}

export class ToolTimeout extends Error {
  constructor (name, ms) {
    super(`${name} did not finish within ${Math.round(ms / 1000)}s and was given up on. It may still be running in the background.`)
    this.name = 'ToolTimeout'
    this.timedOut = true
  }
}
