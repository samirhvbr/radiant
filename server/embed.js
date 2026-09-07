/**
 * Local embeddings for memory recall — or nothing at all.
 *
 * ⚠️ THE FACTS IN memory.json ARE THE MOST PERSONAL THING RADIANT STORES. They are
 * distilled from what Tony actually said: preferences, decisions, names, what he
 * is building. Sending those to a hosted embedding API to make search better
 * would quietly undo the promise the rest of the app keeps — so this speaks only
 * to a model already running on this Mac. Ollama is registered in the provider
 * list at 127.0.0.1:11434 with auth 'none' and needs no key.
 *
 * ⚠️ AND IT IS OPTIONAL. Most people will not have Ollama running — it was not
 * running on Tony's own Mac when this was written. Every function here returns
 * null rather than throwing, the probe is cached so a missing Ollama is not
 * re-dialled on every turn, and memory.js keeps its keyword scorer as the path
 * that always works. Better recall is an upgrade, never a dependency.
 */

const OLLAMA = process.env.RADIANT_OLLAMA || 'http://127.0.0.1:11434'

// nomic-embed-text is ~270 MB and the usual default; override for a bigger one.
export const EMBED_MODEL = process.env.RADIANT_EMBED_MODEL || 'nomic-embed-text'

// ⚠️ VECTORS FROM DIFFERENT MODELS ARE NOT COMPARABLE. Cosine between a
// nomic-embed-text vector and an embeddinggemma one is a number, and it is
// meaningless — it would silently rank memory by noise. Every stored vector
// carries the model that produced it and is ignored when that no longer matches.
export const vectorTag = () => EMBED_MODEL

// A missing Ollama is the common case, so failing must be cheap. One probe per
// minute, a short timeout, and never a thrown error into a turn.
const PROBE_MS = 60_000
const PROBE_TIMEOUT = 700
const EMBED_TIMEOUT = 2500
let probe = { at: 0, ok: false }

// AbortSignal.timeout is the stdlib version of this, and server/index.js:397
// already uses it for the identical Ollama probe. Kept as a one-line alias so
// the two call sites below read the same as they did.
const withTimeout = (url, opts, ms) => fetch(url, { ...opts, signal: AbortSignal.timeout(ms) })

/** Is a local embedding model actually there? Cached, cheap, never throws. */
export async function embeddingsAvailable () {
  const now = Date.now()
  if (now - probe.at < PROBE_MS) return probe.ok
  probe = { at: now, ok: false }
  try {
    const res = await withTimeout(`${OLLAMA}/api/tags`, {}, PROBE_TIMEOUT)
    if (!res.ok) return false
    const { models } = await res.json()
    // Ollama reports "nomic-embed-text:latest" for a plain pull.
    probe.ok = (models || []).some(m => String(m.name || '').split(':')[0] === EMBED_MODEL.split(':')[0])
  } catch { probe.ok = false }
  return probe.ok
}

// ⚠️ TEST SEAM, AND IT EARNS ITS KEEP. Supersession (which overwrites a fact the
// user gave us) and the backfill loop (which rewrites the file on a read path)
// are the most destructive code in memory.js, and both were unreachable in the
// suite: with no Ollama, embed() returns null, so supersedeIndex never fires and
// the backfill never runs. Every assertion ran against the one branch that does
// nothing. A setter is cheaper than asking anyone to pull 270 MB to test division.
let override = null
export function __setEmbedder (fn) { override = fn }

/** A vector for one string, or null if local embeddings are not available. */
export async function embed (text) {
  const s = String(text || '').trim()
  if (!s) return null
  if (override) return override(s)
  if (!(await embeddingsAvailable())) return null
  try {
    const res = await withTimeout(`${OLLAMA}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: s })
    }, EMBED_TIMEOUT)
    if (!res.ok) return null
    const { embedding } = await res.json()
    return Array.isArray(embedding) && embedding.length ? embedding : null
  } catch { return null }
}

/**
 * Cosine similarity. Pure, so the ranking and supersession rules can be tested
 * without Ollama, a network, or a model download — which is the whole reason
 * they live as separate functions instead of inline in memory.js.
 */
export function cosine (a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
