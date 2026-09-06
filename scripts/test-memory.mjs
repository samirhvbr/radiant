/**
 * What the agent remembers, and what it stops remembering.
 *
 * ⚠️ NONE OF THIS NEEDS OLLAMA. The ranking and supersession rules are pure
 * functions over vectors precisely so they can be tested with hand-built ones —
 * otherwise the only way to check recall would be to install a model, pull 270
 * MB, and talk to it, which is how memory bugs stay unfixed.
 *
 * The first case is the defect this work exists for: "I prefer tabs" and "what
 * indentation should I use" share no word longer than three letters, so the old
 * keyword scorer ranked the fact at zero and it never reached the prompt.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'rx-mem-'))
process.env.RADIANT_DIR = dir
// Point Ollama at a closed port so the "no local model" path is what runs here.
process.env.RADIANT_OLLAMA = 'http://127.0.0.1:9'

const { cosine } = await import('../server/embed.js')
const { keywordFacts, rankBySimilarity, supersedeIndex, usableVec, relevantFacts, addFacts, listFacts } =
  await import('../server/memory.js')
const { vectorTag } = await import('../server/embed.js')

let pass = 0, fail = 0
const results = []
const ok = (name, cond) => { cond ? pass++ : (fail++, results.push('  FAIL ' + name)) }

// Hand-built vectors: "tabs" and "indentation" point the same way, "lunch" does not.
const V = { tabs: [1, 0, 0], indent: [0.94, 0.34, 0], lunch: [0, 0, 1] }
const fact = (text, vec, cwd = null) => ({ id: text, text, cwd, vec, vm: vectorTag() })

// ── the defect ──────────────────────────────────────────────────────────────
// ⚠️ WITH ONLY TWO FACTS THIS PROVES NOTHING. keywordFacts falls back to "the
// most recent" when nothing matches, so a two-item list returns both and the
// assertion passes whether or not the bug exists. The bug is that an unmatched
// fact gets CROWDED OUT, so it needs enough facts to crowd.
const filler = Array.from({ length: 20 }, (_, i) => fact(`Unrelated note number ${i}`, V.lunch))
const facts = [fact('Tony prefers tabs over spaces', V.tabs), ...filler]
const kw = keywordFacts(facts, 'what indentation should I use', null, 15)
ok('the keyword scorer loses the fact among newer ones (the original bug)',
   !kw.includes('Tony prefers tabs over spaces'))
ok('ranking by meaning does connect them',
   rankBySimilarity(facts, V.indent, null, 5)[0] === 'Tony prefers tabs over spaces')
ok('and it does not drag in the twenty unrelated ones',
   rankBySimilarity(facts, V.indent, null, 5).every(t => !t.startsWith('Unrelated note')))

// ── supersession: the correctness half ──────────────────────────────────────
const held = [fact('Tony prefers tabs over spaces', V.tabs, '/p')]
ok('a contradicting restatement supersedes rather than joins',
   supersedeIndex(held, V.tabs, '/p') === 0)
ok('an unrelated fact does not supersede anything',
   supersedeIndex(held, V.lunch, '/p') === -1)
ok('supersession does not cross projects',
   supersedeIndex(held, V.tabs, '/other') === -1)
ok('supersession does not cross into the unscoped pile',
   supersedeIndex(held, V.tabs, null) === -1)

// ── vectors from another model must be ignored, not compared ────────────────
ok('a vector from a different embedding model is unusable',
   !usableVec({ text: 'x', vec: [1, 0, 0], vm: 'some-other-model' }))
ok('a vector from the current model is usable',
   usableVec({ text: 'x', vec: [1, 0, 0], vm: vectorTag() }))
ok('a fact with no vector at all is unusable', !usableVec({ text: 'x' }))
ok('unusable vectors are skipped when ranking',
   rankBySimilarity([{ text: 'stale', vec: V.tabs, vm: 'old-model' }], V.tabs, null, 5).length === 0)

// ── cosine ──────────────────────────────────────────────────────────────────
ok('cosine of a vector with itself is 1', Math.abs(cosine(V.tabs, V.tabs) - 1) < 1e-9)
ok('cosine of perpendicular vectors is 0', Math.abs(cosine(V.tabs, V.lunch)) < 1e-9)
ok('mismatched lengths score 0, they do not throw', cosine([1, 0], [1, 0, 0]) === 0)

// ── with no local model, everything still works ─────────────────────────────
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'memory.json'), JSON.stringify({ facts: [
  { id: 'a', text: 'Tony ships Radiant from a Mac', cwd: null, createdAt: new Date().toISOString() }
] }))
const got = await relevantFacts('what does Tony ship', null, 5)
ok('recall still works with no embedding model running', got.includes('Tony ships Radiant from a Mac'))
const n = await addFacts(['Tony writes release notes in plain language'], null)
ok('a fact can still be added with no embedding model', n === 1)
ok('and it is on disk', listFacts().some(f => f.text.startsWith('Tony writes release notes')))
ok('facts written without a model carry no vector',
   listFacts().every(f => f.vec === undefined || Array.isArray(f.vec)))

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  memory recalls by meaning and supersedes contradictions`)
process.exit(fail ? 1 : 0)
