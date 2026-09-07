/**
 * What makes a loop a loop: the check, and what happens when it fails.
 *
 * ⚠️ THE VERDICT READER IS THE WHOLE FEATURE. Without it a "loop" is a numbered
 * list of tasks that all report success, which is what an agent already does. So
 * every way a model can answer badly — restating the format it was given,
 * bolding it, answering twice, answering not at all — is a case here.
 *
 * ⚠️ AND THE GRAPH MUST NOT INVENT. Every edge it draws has to be an import that
 * resolves to a file on disk; a diagram you have to verify by hand is worse than
 * no diagram, because it gets believed.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { readVerdict, workPrompt, checkPrompt, normalizeStep, DEFAULT_ATTEMPTS, MAX_ATTEMPTS } =
  await import('../server/loop-rules.js')
const { scanRepo, toMermaid } = await import('../server/graph.js')

let pass = 0, fail = 0
const results = []
const ok = (name, cond) => { cond ? pass++ : (fail++, results.push('  FAIL ' + name)) }

// ── the verdict ─────────────────────────────────────────────────────────────
ok('a clean PASS passes', readVerdict('Looks right.\nVERDICT: PASS').pass === true)
ok('a clean FAIL fails', readVerdict('VERDICT: FAIL — the tests were never run').pass === false)
ok('and the reason survives',
   readVerdict('VERDICT: FAIL — the tests were never run').reason === 'the tests were never run')
ok('markdown bolding does not hide the verdict', readVerdict('**VERDICT: PASS**').pass === true)
ok('a hyphen works as well as an em dash',
   readVerdict('VERDICT: FAIL - no file was written').reason === 'no file was written')

// ⚠️ THIS IS THE CASE THAT MATTERS. A model that quotes its instructions back
// ("reply with VERDICT: PASS or VERDICT: FAIL") before answering would otherwise
// have the format description read as the answer — and the first word is PASS.
ok('the LAST verdict wins, not the first',
   readVerdict('I was asked to reply VERDICT: PASS or VERDICT: FAIL.\n\nVERDICT: FAIL — nothing compiled').pass === false)

// ⚠️ NO VERDICT IS A FAIL. Treating an unparseable answer as success is the one
// failure that makes the whole layer worthless.
ok('silence is not a pass', readVerdict('I think that went well.').pass === false)
ok('and it says why', /did not answer/i.test(readVerdict('I think that went well.').reason))
ok('an empty message is not a pass', readVerdict('').pass === false)
ok('the word pass in prose is not a verdict', readVerdict('All of the tests pass now.').pass === false)
ok('a bare FAIL still carries a reason', readVerdict('VERDICT: FAIL').reason.length > 0)
ok('a bullet in front of it is still a verdict', readVerdict('- VERDICT: PASS').pass === true)
ok('and a quote marker', readVerdict('> **VERDICT: FAIL** — nothing ran').reason === 'nothing ran')
ok('a trailing full stop does not become the reason', readVerdict('VERDICT: PASS.').pass === true)
// ⚠️ MID-SENTENCE IS NOT A VERDICT. "I would not say VERDICT: PASS here" must
// not pass a step; the anchor to the start of a line is what prevents it.
ok('a verdict buried in a sentence does not count',
   readVerdict('I would not say VERDICT: PASS about this.').pass === false)

// ── the retry has to differ from the first attempt ───────────────────────────
const loop = { title: 'Ship the parser', detail: '', currentStep: 0, steps: [{}, {}] }
const step = { title: 'Write it', prompt: 'Write the parser.', check: 'npm test passes', lastFail: null }
const first = workPrompt(loop, step)
const retry = workPrompt(loop, { ...step, lastFail: 'the tests were never run' })
ok('the first attempt states the finish condition', first.includes('npm test passes'))
ok('the first attempt says which step it is', first.includes('Step 1 of 2'))
ok('a retry is not the same prompt as the first attempt', retry !== first)
ok('a retry carries the reason the last one failed', retry.includes('the tests were never run'))

// ── the checker must be told not to keep working ─────────────────────────────
const cp = checkPrompt(loop, step, true)
ok('the check forbids doing more work', /do no new work/i.test(cp))
ok('the check states the condition', cp.includes('npm test passes'))
ok('the check demands the format it will be parsed for', readVerdict(cp).pass === false)
ok('a second-agent check is told the work is elsewhere',
   /another agent/i.test(checkPrompt({ ...loop, cwd: '/tmp/x' }, step, false)))
ok('and a same-session check is not', !/another agent/i.test(cp))

// ── attempt bounds ──────────────────────────────────────────────────────────
ok('a step defaults to a bounded number of attempts', normalizeStep({ title: 'x' }).maxAttempts === DEFAULT_ATTEMPTS)
ok('zero attempts is not allowed', normalizeStep({ title: 'x', maxAttempts: 0 }).maxAttempts === 1)
ok('an unbounded retry is capped', normalizeStep({ title: 'x', maxAttempts: 9999 }).maxAttempts === MAX_ATTEMPTS)
ok('garbage falls back to the default', normalizeStep({ title: 'x', maxAttempts: 'lots' }).maxAttempts === DEFAULT_ATTEMPTS)
// Editing a loop must not reset the run it is in the middle of.
const kept = normalizeStep({ title: 'renamed' }, { id: 'step-abc', state: 'passed', attempts: 2, sessionId: 's1' })
ok('editing a step keeps its id', kept.id === 'step-abc')
ok('editing a step keeps what the run already did', kept.state === 'passed' && kept.attempts === 2)
ok('and takes the new title', kept.title === 'renamed')

// ── the graph observes; it does not guess ───────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'rx-graph-'))
mkdirSync(join(dir, 'app'), { recursive: true })
mkdirSync(join(dir, 'lib'), { recursive: true })
mkdirSync(join(dir, 'node_modules', 'react'), { recursive: true })
mkdirSync(join(dir, 'public', 'assets'), { recursive: true })
writeFileSync(join(dir, 'app', 'main.js'), "import { helper } from '../lib/helper.js'\nimport React from 'react'\nimport { gone } from '../lib/never-written.js'\n")
writeFileSync(join(dir, 'lib', 'helper.js'), "export const helper = 1\n")
writeFileSync(join(dir, 'node_modules', 'react', 'index.js'), "module.exports = {}\n")
// A built copy of the app, in a folder no skip list knows about — the shape
// Radiant's own repo has under apps/ios/.../public/assets.
writeFileSync(join(dir, 'public', 'assets', 'index-Bm7srADV.js'), 'var a=1;'.repeat(1200) + '\n')
const g = scanRepo(dir)

ok('an import that resolves becomes an edge',
   g.edges.some(e => e.from === 'app' && e.to === 'lib'))

// ⚠️ "THE GRAPH CANNOT INVENT A FILE" IS STRUCTURAL, NOT TESTED, AND SAYING SO
// IS THE POINT. Nodes are built from the directory walk and edges are then
// filtered to nodes that got drawn, so a bad resolver would have to defeat three
// independent layers to put a made-up path on the page. An assertion here passed
// with the resolver deliberately guessing — it was measuring nothing. What CAN
// regress is the resolver getting looser or noisier, so that is what is tested.

// main.js imports ../lib/never-written.js, which is not there. A relative import
// that does not resolve is dropped; it must never be filed as a dependency.
ok('a broken relative import is not reported as a package',
   g.stats.externals.every(x => !/never-written/.test(x.name)))
// ⚠️ AND NOT AS "..". The path is split on "/" to get the package name, so a
// relative specifier that slipped through this branch would be filed under its
// first segment — a dependency called ".." in the list of what the repo uses.
ok('and no dependency is named after a path segment',
   g.stats.externals.every(x => !x.name.startsWith('.') && !x.name.startsWith('/')))

// ⚠️ THE WORD "import" INSIDE A STRING IS NOT AN IMPORT. `\bimport\s*'…'` matched
// json('POST', '/api/import', payload) in Radiant's own api.js and reported a
// dependency called "." whose name was the next forty characters of source. It
// was on screen in the Leans on list before anyone looked at where it came from.
const dir3 = mkdtempSync(join(tmpdir(), 'rx-graph3-'))
// The exact shape from Radiant's own Settings.jsx: the word import inside one
// string literal, followed by another string on the same line. The old pattern
// captured everything between them — ", " — and listed it as a dependency.
writeFileSync(join(dir3, 'client.js'),
  "import fetchy from 'undici'\nexport const go = b => post('/api/skills/import', 'body')\n")
const g3 = scanRepo(dir3)
ok('a real import is still found', g3.stats.externals.some(x => x.name === 'undici'))
ok('the word import inside a string is not one',
   g3.stats.externals.length === 1, JSON.stringify(g3.stats.externals))
ok('a package is counted as a dependency, not drawn as a folder',
   g.stats.externals.some(x => x.name === 'react') && !g.nodes.some(n => n.id === 'node_modules/react'))

// Nobody writes the extension in TypeScript, and a folder import means its index.
// Both are how real repos are written; missing either draws a disconnected graph.
const dir2 = mkdtempSync(join(tmpdir(), 'rx-graph2-'))
mkdirSync(join(dir2, 'ui'), { recursive: true })
mkdirSync(join(dir2, 'core'), { recursive: true })
writeFileSync(join(dir2, 'ui', 'view.tsx'), "import { a } from '../core/thing'\nimport { b } from '../core'\n")
writeFileSync(join(dir2, 'core', 'thing.ts'), 'export const a = 1\n')
writeFileSync(join(dir2, 'core', 'index.ts'), 'export const b = 2\n')
const g2 = scanRepo(dir2, { level: 'file' })
ok('an import written without its extension still resolves',
   g2.edges.some(e => e.from === 'ui/view.tsx' && e.to === 'core/thing.ts'))
ok('an import of a folder resolves to its index',
   g2.edges.some(e => e.from === 'ui/view.tsx' && e.to === 'core/index.ts'))
ok('and nothing else was drawn between them', g2.edges.length === 2)
ok('node_modules is not walked', g.stats.files === 2)
ok('a minified bundle is not source, wherever it sits',
   g.stats.skipped === 1 && !g.nodes.some(n => n.id === 'public/assets'))
ok('the drawing names the folders it found', g.mermaid.includes('app') && g.mermaid.includes('lib'))
ok('every drawn arrow joins two drawn boxes', (() => {
  const ids = new Set(g.mermaid.split('\n').filter(l => l.includes('["')).map(l => l.trim().split('[')[0]))
  return g.mermaid.split('\n').filter(l => /-->|==>/.test(l))
    .every(l => { const [a, , b] = l.trim().split(/\s+/); return ids.has(a) && ids.has(b) })
})())

// A quote in a folder name would end a mermaid label early and break the whole
// diagram — every node after it included.
const quoted = toMermaid({ root: dir, level: 'folder', nodes: [{ id: 'say "hi"', label: 'say "hi"', short: 'say "hi"', files: 1 }], edges: [] })
ok('a quote in a path cannot break the diagram', !/[^&]"hi"/.test(quoted) && quoted.includes('&quot;'))
// Two folders reduced to the same mermaid id would silently merge into one box.
const collide = toMermaid({
  root: dir, level: 'folder', edges: [],
  nodes: [{ id: 'a/b', label: 'a/b', short: 'a/b', files: 1 }, { id: 'a-b', label: 'a-b', short: 'a-b', files: 1 }]
})
ok('two folders never collapse into one box',
   new Set(collide.split('\n').filter(l => l.includes('["')).map(l => l.trim().split('[')[0])).size === 2)

console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  a step is done when a check says so, and the graph draws only what is there`)
process.exit(fail ? 1 : 0)
