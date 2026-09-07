import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { RADIANT_DIR } from './config.js'
import { embed, cosine, vectorTag } from './embed.js'

// Persistent, cross-session memory: durable facts the agent remembers about the
// user and their projects. Distilled after turns, injected (a small slice) into
// the system prompt on future turns.
const MEM_PATH = path.join(RADIANT_DIR, 'memory.json')

// ⚠️ RECALL USED TO BE WORD OVERLAP, AND THAT IS THE FAILURE PEOPLE MEAN when
// they say agents forget. "I prefer tabs" shares no word with "what indentation
// should I use", so the fact scored zero and never reached the prompt. When a
// local embedding model is available the same question now matches by meaning.
// When it is not — the common case — the keyword scorer below still runs, and
// nothing about this file requires Ollama to be installed.
const SIM_FLOOR = 0.35

// ⚠️ AND SUPERSESSION MATTERS MORE THAN RECALL. Facts were only ever appended,
// so changing your mind left both the old and new fact in the file, both able to
// surface, with no precedence between them. Semantic search made that WORSE, not
// better: it reliably retrieves the contradictory pair together. Above this
// similarity a new fact replaces the one it contradicts instead of joining it.
const SUPERSEDE = 0.86

const MAX_FACTS = 300
// Facts written before embeddings existed have no vector. Fill them in a few at
// a time on read rather than stalling one turn to embed three hundred.
const BACKFILL_PER_CALL = 12

function load () {
  try { return JSON.parse(fs.readFileSync(MEM_PATH, 'utf8')) } catch { return { facts: [] } }
}
function save (m) {
  try {
    fs.mkdirSync(RADIANT_DIR, { recursive: true })
    // ⚠️ WRITE THEN RENAME. A fact now carries a 768-float vector, so this file
    // went from ~28 KB to megabytes and the window in which a crash leaves
    // truncated JSON went with it. load() answers a parse failure with
    // `{ facts: [] }`, and the next save would then write that empty snapshot
    // over everything the user has ever told Radiant. rename is atomic.
    const tmp = MEM_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(m))
    fs.renameSync(tmp, MEM_PATH)
  } catch {}
}

// ⚠️ ONE WRITER AT A TIME. Both write paths became load → await → save when
// embeddings arrived, and an await between the read and the write is a lost
// update: `relevantFacts` holds a snapshot across up to thirteen 2.5s embed
// calls, so a `POST /api/memory/clear` landing in that window got silently
// written back. Clearing your memory is a privacy control, and it appeared to
// work — the response was built from a read taken before the overwrite. Every
// mutation now queues behind the last one.
let chain = Promise.resolve()
function serialize (fn) {
  const next = chain.then(fn, fn)
  chain = next.then(() => {}, () => {})
  return next
}

// ⚠️ VECTORS ARE NOT THE USER'S BUSINESS, AND THEY ARE ENORMOUS. listFacts feeds
// GET /api/memory, so shipping them sent megabytes of floats to the UI and to a
// phone over Tailscale on every render. The ranking path uses load() directly.
export function listFacts () {
  return load().facts.map(({ vec, vm, ...f }) => f)
}

/** A stored vector is only usable if it came from the model we are asking with. */
export const usableVec = f => Array.isArray(f?.vec) && f.vec.length > 0 && f.vm === vectorTag()

/**
 * Which existing fact does this new one replace, if any? Pure, so the rule is
 * testable without a model. Returns an index or -1.
 */
export function supersedeIndex (facts, vec, cwd) {
  if (!Array.isArray(vec) || !vec.length) return -1
  let best = -1, bestScore = 0
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i]
    if (!usableVec(f)) continue
    // Only supersede within the same scope. A preference stated about one
    // project must not silently overwrite the same preference about another.
    if ((f.cwd || null) !== (cwd || null)) continue
    const s = cosine(vec, f.vec)
    if (s >= SUPERSEDE && s > bestScore) { best = i; bestScore = s }
  }
  return best
}

/** Rank facts against a query vector. Pure. */
export function rankBySimilarity (facts, qvec, cwd, limit) {
  const scored = []
  for (const f of facts) {
    if (!usableVec(f)) continue
    let s = cosine(qvec, f.vec)
    if (s < SIM_FLOOR) continue
    if (f.cwd && cwd && f.cwd === cwd) s += 0.05   // same project, gentle nudge
    scored.push({ f, s })
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.f.text)
}

/** The original word-overlap scorer. Still the fallback, and still exported. */
export function keywordFacts (facts, query, cwd, limit = 15) {
  if (!facts.length) return []
  const words = new Set(String(query || '').toLowerCase().split(/\W+/).filter(w => w.length > 3))
  const scored = facts.map(f => {
    let score = (f.cwd && cwd && f.cwd === cwd) ? 1 : 0
    const ft = f.text.toLowerCase()
    for (const w of words) if (ft.includes(w)) score += 2
    return { f, score }
  })
  const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score)
  // if nothing matched, still surface the most recent facts (memory should show up)
  const chosen = matched.length ? matched : scored.slice(-limit).map(s => ({ f: s.f, score: 0 }))
  return chosen.slice(0, limit).map(s => s.f.text)
}

export async function addFacts (facts, cwd) {
  // Embed first, outside the lock — this is the slow part and it needs no
  // snapshot of the file.
  const candidates = []
  for (const raw of facts || []) {
    const text = String(raw).replace(/^[-*•\d.\s]+/, '').trim()
    if (text.length < 4 || text.length > 300 || /^none\b/i.test(text)) continue
    candidates.push({ text, vec: await embed(text) })
  }
  if (!candidates.length) return { added: 0, superseded: 0 }

  return serialize(() => {
    const m = load()
    const seen = new Set(m.facts.map(f => f.text.toLowerCase().trim()))
    let added = 0, superseded = 0
    for (const { text, vec } of candidates) {
      if (seen.has(text.toLowerCase())) continue
      const at = supersedeIndex(m.facts, vec, cwd)
      if (at >= 0) {
        // ⚠️ THE REPLACED SENTENCE IS KEPT, AND THE ROW MOVES TO THE END. Only
        // the old timestamp used to survive, so one false positive at the 0.86
        // threshold deleted something the user said with no undo — and because
        // the row was rewritten in place while the 300-cap trims by position,
        // the freshly restated fact was the first thing evicted. Position has to
        // keep meaning recency for that trim to be correct.
        const prev = m.facts[at]
        seen.delete(prev.text.toLowerCase().trim())
        m.facts.splice(at, 1)
        const f = { ...prev, text, createdAt: new Date().toISOString(), supersededAt: new Date().toISOString(), prevText: prev.text }
        if (vec) { f.vec = vec; f.vm = vectorTag() } else { delete f.vec; delete f.vm }
        m.facts.push(f)
        superseded++
      } else {
        const f = { id: 'm-' + crypto.randomBytes(3).toString('hex'), text, cwd: cwd || null, createdAt: new Date().toISOString() }
        if (vec) { f.vec = vec; f.vm = vectorTag() }
        m.facts.push(f)
        added++
      }
      seen.add(text.toLowerCase())
    }
    if (m.facts.length > MAX_FACTS) m.facts = m.facts.slice(-MAX_FACTS)
    if (added || superseded) save(m)
    return { added, superseded }
  })
}

export function deleteFact (id) {
  return serialize(() => { const m = load(); m.facts = m.facts.filter(f => f.id !== id); save(m) })
}
export function clearFacts () { return serialize(() => save({ facts: [] })) }
export async function addFactManual (text) { return addFacts([text], null) }

/** A small set of the most relevant facts for a query. */
export async function relevantFacts (query, cwd, limit = 15) {
  const m = load()
  if (!m.facts.length) return []

  const qvec = await embed(query)
  if (!qvec) return keywordFacts(m.facts, query, cwd, limit)   // no local model — unchanged behaviour

  // Warm a few facts that predate embeddings, so recall improves as it is used
  // rather than needing a migration step someone has to remember to run.
  //
  // ⚠️ COUNT ATTEMPTS, NOT SUCCESSES, AND STOP ON THE FIRST FAILURE. The counter
  // only advanced inside `if (v)`, so when embed() returned null — the
  // availability probe is cached OK for a minute while /api/embeddings is
  // failing — the loop walked all three hundred facts at 2.5s each instead of
  // twelve. That is minutes of sequential HTTP inside one chat turn. A null also
  // means the endpoint is unhealthy, so the remaining calls are guaranteed waste.
  const warmed = []
  let tried = 0
  for (const f of m.facts) {
    if (tried >= BACKFILL_PER_CALL) break
    if (usableVec(f)) continue
    tried++
    const v = await embed(f.text)
    if (!v) break
    f.vec = v; f.vm = vectorTag()
    warmed.push({ id: f.id, vec: v })
  }
  // ⚠️ MERGE, DO NOT WRITE THE SNAPSHOT BACK. `m` was read before those awaits,
  // so saving it wholesale is what resurrected deleted facts. Re-read under the
  // lock and apply only the vectors, by id, to rows that are still there.
  if (warmed.length) {
    await serialize(() => {
      const cur = load()
      let touched = 0
      for (const w of warmed) {
        const f = cur.facts.find(x => x.id === w.id)
        if (f && !usableVec(f)) { f.vec = w.vec; f.vm = vectorTag(); touched++ }
      }
      if (touched) save(cur)
    })
  }

  const hits = rankBySimilarity(m.facts, qvec, cwd, limit)
  // Early on, most facts still have no vector — falling back keeps recall from
  // getting WORSE than it was before this feature existed.
  return hits.length ? hits : keywordFacts(m.facts, query, cwd, limit)
}
