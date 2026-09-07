import fs from 'fs'
import path from 'path'

/**
 * Point Radiant at a folder and get a picture of it.
 *
 * ⚠️ THIS OBSERVES, IT DOES NOT ASK A MODEL. Every node is a directory that
 * exists and every edge is an import statement someone actually wrote. A
 * language model drawing an architecture diagram produces something that looks
 * right and cites files that were never opened — and a diagram you have to
 * verify by hand is worse than no diagram, because it is believed. The model
 * gets to explain this graph afterwards; it never gets to draw it.
 *
 * The unit is the FOLDER, not the file. A three-hundred-file flowchart is a
 * hairball nobody reads; the same repo at folder level is six boxes and the
 * shape of the thing is obvious. File level is available for a folder small
 * enough to survive it.
 */

// Directories that are somebody else's code or a build output. Walking these is
// how a scan turns into a minute of I/O and a graph of npm.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'release',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', 'coverage',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  'vendor', 'Pods', 'Carthage', 'DerivedData', '.build', 'target',
  '.gradle', '.idea', '.vscode', '.terraform', 'bower_components', '.pnpm-store'
])

// One extension list, because the walker and the parser must agree about what a
// source file is. They disagreed once and files were counted but never parsed.
const LANGS = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.vue': 'js', '.svelte': 'js',
  '.py': 'py',
  '.swift': 'swift',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java', '.kt': 'kotlin',
  '.php': 'php',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.hpp': 'c', '.m': 'c', '.mm': 'c'
}

// ⚠️ A CAP, NOT A HOPE. A scan runs inside an HTTP request on the same process
// that streams chat, so an unbounded walk of a home directory would stall a
// turn. These are generous for a repo and fatal for a mistake.
const MAX_FILES = 6000
const MAX_DEPTH = 12
const MAX_BYTES = 400_000       // per file; a bundle is not source
const MAX_NODES = 40            // in the drawing — the rest are counted, not drawn

// A package name, as npm, pip and cargo agree on it.
const PKG_NAME = /^@?[A-Za-z_][\w.-]*(?:\/[\w.-]+)?$/

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte']

/** Every source file under root, relative-pathed, bounded. */
function walk (root) {
  const files = []
  let truncated = false
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length) {
    const { dir, depth } = stack.pop()
    if (depth > MAX_DEPTH) continue
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push({ dir: full, depth: depth + 1 })
      } else if (e.isFile()) {
        const lang = LANGS[path.extname(e.name).toLowerCase()]
        if (!lang) continue
        if (files.length >= MAX_FILES) { truncated = true; continue }
        files.push({ rel: path.relative(root, full), lang })
      }
    }
  }
  return { files, truncated }
}

// ⚠️ REGEX, AND IT KNOWS IT. This is not a parser: it will read an import out of
// a comment or a string literal. That is an acceptable trade for a picture — a
// false edge between two folders that mention each other is a small lie, and
// pulling in a real parser for six languages is not a small cost. What it must
// never do is INVENT a path that is not on disk, and it cannot: every edge below
// is kept only when the target resolves to a file that exists.
const PATTERNS = {
  // ⚠️ THE STATEMENT FORMS ARE ANCHORED TO THE START OF A LINE. `\bimport\s*'…'`
  // matched the WORD import inside an ordinary string — `json('POST',
  // '/api/import', payload)` in api.js produced a dependency named `.` whose
  // "name" was the next forty characters of source. import/export statements
  // always begin a line; require() and import() are expressions and do not, so
  // only those two stay unanchored.
  js: [
    /^[ \t]*import\s+[^'"()]*?from\s*['"]([^'"]+)['"]/gm,
    /^[ \t]*import\s*['"]([^'"]+)['"]/gm,
    /^[ \t]*export\s+[^'"]*?from\s*['"]([^'"]+)['"]/gm,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ],
  py: [
    /^\s*from\s+([.\w]+)\s+import\b/gm,
    /^\s*import\s+([.\w]+)/gm
  ],
  go: [/^\s*(?:import\s+)?"([^"]+)"/gm],
  rust: [/^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/gm],
  ruby: [/\brequire(?:_relative)?\s+['"]([^'"]+)['"]/g],
  php: [/\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g],
  swift: [], java: [], kotlin: [], c: []
}

/** Resolve a JS-ish relative specifier against the file that wrote it. */
function resolveJs (root, fromRel, spec, known) {
  if (!spec.startsWith('.')) return null              // a package, not a file
  const base = path.normalize(path.join(path.dirname(fromRel), spec))
  if (base.startsWith('..')) return null              // outside the scan
  if (known.has(base)) return base
  for (const ext of JS_EXTS) if (known.has(base + ext)) return base + ext
  for (const ext of JS_EXTS) if (known.has(path.join(base, 'index' + ext))) return path.join(base, 'index' + ext)
  return null
}

/** Resolve a Python dotted or relative module against the scanned tree. */
function resolvePy (root, fromRel, spec, known) {
  let target
  if (spec.startsWith('.')) {
    const up = spec.match(/^\.+/)[0].length - 1
    const rest = spec.slice(up + 1).replace(/\./g, path.sep)
    let dir = path.dirname(fromRel)
    for (let i = 0; i < up; i++) dir = path.dirname(dir)
    target = path.normalize(path.join(dir, rest))
  } else {
    target = spec.replace(/\./g, path.sep)
  }
  if (target.startsWith('..')) return null
  for (const c of [target + '.py', path.join(target, '__init__.py')]) if (known.has(c)) return c
  return null
}

// ⚠️ A BUILT COPY OF THE APP IS NOT PART OF THE APP. Radiant's own repo carries
// `apps/ios/.../public/assets`: sixty-two Vite bundles, the largest folder in the
// tree, and a duplicate of `src` with none of its structure. Drawn, it was the
// biggest box on the page and told you nothing. Name patterns miss the next
// bundler's convention, so this asks the file: source is written in lines, and a
// bundle is not.
const MINIFIED_LINE = 2000
function looksBundled (src) {
  for (const line of src.split('\n', 40)) if (line.length > MINIFIED_LINE) return true
  return false
}

/**
 * Everything one file imports: resolved internal targets, plus bare packages.
 * `skip` means this is not source at all and should leave no trace in the graph.
 */
function importsOf (root, file, known) {
  let src
  try {
    const st = fs.statSync(path.join(root, file.rel))
    if (st.size > MAX_BYTES) return { internal: [], external: [], skip: true }
    src = fs.readFileSync(path.join(root, file.rel), 'utf8')
  } catch { return { internal: [], external: [], skip: true } }
  if (looksBundled(src)) return { internal: [], external: [], skip: true }

  const internal = new Set()
  const external = new Set()
  for (const re of PATTERNS[file.lang] || []) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(src))) {
      const spec = m[1]
      if (!spec) continue
      let hit = null
      if (file.lang === 'js') hit = resolveJs(root, file.rel, spec, known)
      else if (file.lang === 'py') hit = resolvePy(root, file.rel, spec, known)
      else if (spec.startsWith('.')) hit = resolveJs(root, file.rel, spec, known)
      if (hit) internal.add(hit)
      // A bare specifier is a dependency. Relative ones that did not resolve are
      // dropped rather than guessed at — a broken import is not a package.
      else if (!spec.startsWith('.') && !spec.startsWith('/')) {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        // ⚠️ AND IT HAS TO LOOK LIKE A PACKAGE. A regex over six languages will
        // eventually capture something that is not an import; this is the last
        // gate before it is presented to the user as a dependency of their
        // project, which is a claim, not a guess.
        if (PKG_NAME.test(pkg)) external.add(pkg)
      }
    }
  }
  return { internal: [...internal], external: [...external] }
}

/** The folder a file belongs to, as the graph sees it. '' means the root. */
const folderOf = rel => {
  const d = path.dirname(rel)
  return d === '.' ? '' : d
}

/**
 * Scan a folder and return a graph of it.
 * @param {string} root absolute path to an existing directory
 * @param {{level?: 'folder'|'file'}} opts
 */
export function scanRepo (root, opts = {}) {
  const level = opts.level === 'file' ? 'file' : 'folder'
  const { files, truncated } = walk(root)
  const known = new Set(files.map(f => f.rel))

  const externals = new Map()
  const langCount = new Map()
  // unit -> Map(unit -> weight)
  const out = new Map()
  const size = new Map()          // unit -> file count
  const unitOf = rel => (level === 'file' ? rel : folderOf(rel))

  // ⚠️ ONE PASS, AND A SKIPPED FILE IS SKIPPED EVERYWHERE. Counting files first
  // and reading them second meant a bundle was excluded from the edges but still
  // sized its folder — which is how the biggest node on the page came to be a
  // build output with no arrows on it.
  let edgeCount = 0
  let skipped = 0
  const parsed = []
  for (const f of files) {
    const r = importsOf(root, f, known)
    if (r.skip) { skipped++; continue }
    parsed.push({ f, r })
    langCount.set(f.lang, (langCount.get(f.lang) || 0) + 1)
    const u = unitOf(f.rel)
    size.set(u, (size.get(u) || 0) + 1)
    if (!out.has(u)) out.set(u, new Map())
  }
  const live = new Set(parsed.map(p => p.f.rel))
  for (const { f, r } of parsed) {
    for (const p of r.external) externals.set(p, (externals.get(p) || 0) + 1)
    const from = unitOf(f.rel)
    for (const t of r.internal) {
      if (!live.has(t)) continue
      const to = unitOf(t)
      if (to === from) continue        // a folder importing itself is not an edge
      const m = out.get(from)
      m.set(to, (m.get(to) || 0) + 1)
      edgeCount++
    }
  }

  // ⚠️ DEGREE, NOT SIZE, DECIDES WHAT GETS DRAWN. Ranking by file count puts the
  // biggest folder on the page and drops the one everything depends on, which is
  // exactly backwards: the interesting node is the connected one.
  const degree = new Map()
  const bump = (k, n) => degree.set(k, (degree.get(k) || 0) + n)
  for (const [from, m] of out) for (const [to, w] of m) { bump(from, w); bump(to, w) }

  const allUnits = [...size.keys()]
  const ranked = allUnits.slice().sort((a, b) =>
    (degree.get(b) || 0) - (degree.get(a) || 0) || (size.get(b) || 0) - (size.get(a) || 0) || a.localeCompare(b))
  const shown = new Set(ranked.slice(0, MAX_NODES))

  const nodes = ranked.filter(u => shown.has(u)).map(u => ({
    id: u,
    label: u === '' ? path.basename(root) + '/' : u,
    // A box captioned apps/ios/ios/App/CapApp-SPM/Sources/CapApp-SPM is wider
    // than the diagram and says the same thing as its last two segments.
    short: shortLabel(u, root),
    files: size.get(u) || 0,
    degree: degree.get(u) || 0
  }))
  const edges = []
  for (const [from, m] of out) {
    if (!shown.has(from)) continue
    for (const [to, w] of m) {
      if (!shown.has(to)) continue
      edges.push({ from, to, weight: w })
    }
  }
  edges.sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from))

  return {
    root,
    name: path.basename(root),
    level,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    stats: {
      files: parsed.length,
      skipped,
      units: allUnits.length,
      drawn: nodes.length,
      imports: edgeCount,
      truncated,
      languages: [...langCount.entries()].sort((a, b) => b[1] - a[1]).map(([lang, count]) => ({ lang, count })),
      externals: [...externals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count }))
    },
    mermaid: toMermaid({ root, nodes, edges, level })
  }
}

/** The tail of a path, enough to identify it, short enough to draw. */
function shortLabel (unit, root) {
  if (unit === '') return path.basename(root) + '/'
  const parts = unit.split(path.sep)
  if (parts.length <= 3) return unit
  // ⚠️ KEEP THE FIRST SEGMENT. Trimming to the last two turned three folders under
  // skills/architecture-map into "…/assets/core", "…/assets/stores" and
  // "…/assets/components" — unique strings that all look like they came from the
  // app itself. Which tree a box belongs to is the thing you read first.
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`
}

// Mermaid ids must be word characters. Collisions are the failure that matters:
// two folders reduced to the same id silently merge into one box, so the map is
// by original name and the counter guarantees uniqueness.
function idMap (nodes) {
  const map = new Map()
  const used = new Set()
  let n = 0
  for (const node of nodes) {
    let base = 'n' + (node.id.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root')
    if (base.length > 40) base = base.slice(0, 40)
    let id = base
    while (used.has(id)) id = base + '_' + (++n)
    used.add(id)
    map.set(node.id, id)
  }
  return map
}

// Mermaid takes the label between quotes, so a quote in a path would end it
// early and break the whole diagram. Paths can contain them.
const esc = s => String(s).replace(/"/g, '&quot;').replace(/[<>]/g, '')

export function toMermaid ({ root, nodes, edges, level }) {
  if (!nodes.length) return 'flowchart LR\n  empty["Nothing to draw — no source files found here"]'
  // ⚠️ A FOLDER WITH NO ARROWS HAS NOTHING TO SAY IN A DIAGRAM OF ARROWS. Radiant's
  // own repo drew twenty-two boxes of which thirteen were unconnected, and the
  // shape of the app — src, server, mobile, electron — was lost inside the noise.
  // They are still in `nodes`, so the view lists them beside the drawing; they are
  // just not competing with it. When NOTHING resolved (a Swift-only repo, where
  // imports name modules rather than files) every box is drawn, because then the
  // list of folders is the honest answer.
  const connected = new Set()
  for (const e of edges) { connected.add(e.from); connected.add(e.to) }
  const drawn = edges.length ? nodes.filter(n => connected.has(n.id)) : nodes
  if (!drawn.length) return 'flowchart LR\n  empty["Nothing to draw — no source files found here"]'

  const ids = idMap(drawn)
  const lines = ['flowchart LR']
  for (const node of drawn) {
    const label = level === 'file'
      ? esc(path.basename(node.id))
      : `${esc(node.short || node.label)}<br/><small>${node.files} file${node.files === 1 ? '' : 's'}</small>`
    lines.push(`  ${ids.get(node.id)}["${label}"]`)
  }
  for (const e of edges) {
    // A thick arrow for a heavily used dependency reads at a glance; a number on
    // every edge does not.
    lines.push(`  ${ids.get(e.from)} ${e.weight >= 5 ? '==>' : '-->'} ${ids.get(e.to)}`)
  }
  return lines.join('\n')
}
