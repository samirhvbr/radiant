const sleep = ms => new Promise(r => setTimeout(r, ms))

// fetch that retries transient upstream errors (Cloudflare 502/503/504, network
// blips) with backoff. Safe for streaming calls: it decides on the response
// STATUS before the body is consumed.
export async function fetchRetry (url, opts = {}, { tries = 3, delayMs = 600 } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts)
      if ([502, 503, 504].includes(res.status) && i < tries - 1) { last = res; await sleep(delayMs * (i + 1)); continue }
      return res
    } catch (e) {
      last = e
      if (opts.signal?.aborted) throw e
      if (i < tries - 1) { await sleep(delayMs * (i + 1)); continue }
      throw e
    }
  }
  return last
}

// friendly one-liner for a transient upstream error
export function isTransient (status) { return status === 502 || status === 503 || status === 504 }

// Risk grade for a shell command, for the "Auto" approval mode. 'low' runs
// silently; everything else still asks.
//
// ⚠️ THIS IS AN ALLOWLIST, AND IT HAS TO BE. It was a denylist of destructive
// shapes — rm, sudo, curl|sh — and it caught all of those and none of the
// language runtimes sitting on every Mac. Measured against the old list, every
// one of these graded 'low' and therefore ran with no prompt at all:
//
//   node -e "require('child_process').exec('id')"
//   perl -e system("id")            ruby -e "system(%q{id})"
//   php -r "system('id');"          osascript -e x
//   echo hi >> ~/.zshrc             git config --global core.pager "sh -c id"
//
// A denylist over a Turing-complete shell cannot be finished — every entry you
// add leaves the next interpreter. So 'low' now means "every segment of this
// line is a command I recognise as read-only", and anything else asks. Being
// asked about an unfamiliar command is the correct cost.
const READ_ONLY_CMDS = new Set([
  'ls', 'pwd', 'cd', 'echo', 'printf', 'cat', 'bat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'date', 'whoami', 'hostname', 'uname', 'sw_vers', 'which', 'type', 'basename', 'dirname',
  'realpath', 'readlink', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'fd', 'sort', 'uniq', 'cut', 'tr',
  'column', 'diff', 'jq', 'yq', 'tree', 'ps', 'true', 'false', 'wait', 'sleep'
])
// Commands that are only read-only in some of their moods. `git config` writes
// (it was one of the bypasses above) and `git stash`/`tag`/`checkout` mutate, so
// none of them are here.
const READ_ONLY_SUB = {
  git: new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'ls-files', 'blame',
    'rev-parse', 'describe', 'shortlog', 'merge-base', 'name-rev', 'cat-file', 'count-objects']),
  npm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'ping', 'root', 'prefix', 'why']),
  brew: new Set(['list', 'info', 'outdated', 'config']),
  docker: new Set(['ps', 'images', 'logs', 'inspect', 'version'])
}
// Redirection, command substitution and process substitution turn any allowlisted
// head into an arbitrary write or an arbitrary execution, so a segment carrying
// one is never low. (`echo` is read-only; `echo … >> ~/.zshrc` is not.)
const ESCAPES = /[`><]|\$\(/

function segmentIsReadOnly (seg) {
  const s = seg.trim()
  if (!s) return true
  if (ESCAPES.test(s)) return false
  const parts = s.split(/\s+/)
  const head = parts[0]
  if (!head || head.includes('=')) return false          // FOO=bar … is an assignment, not a command
  if (READ_ONLY_SUB[head]) {
    const sub = parts.slice(1).find(p => !p.startsWith('-'))
    return sub ? READ_ONLY_SUB[head].has(sub) : true     // bare `git` / `npm` just prints help
  }
  return READ_ONLY_CMDS.has(head)
}

// Kept as a second veto. If something slips onto the allowlist that should not
// have, these still catch the classic shapes.
const HIGH_RISK = [
  /\brm\b|-rf\b|\brmdir\b/, /\bsudo\b|\bsu\b/, /\bdd\b/, /\bmkfs|\bfdisk|\bformat\b/,
  /\bshutdown\b|\breboot\b|\bhalt\b/, /\bkill(all)?\b|\bpkill\b/, /\bchmod\b|\bchown\b/,
  /\bcurl\b|\bwget\b|\bnc\b|\bncat\b|\bftp\b/, /\|\s*(sudo\s+)?(sh|bash|zsh)\b/, /\bssh\b|\bscp\b|\brsync\b.*::/,
  /\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\b|\bgit\s+checkout\s+--\s/, /\bnpm\s+publish\b|\byarn\s+publish\b/,
  /\beval\b/, /:\(\)\s*\{/, />\s*\/(dev|etc|usr|bin|sys)\b/, /\brm\b.*\*|\bfind\b.*-delete\b/,
  /\bbrew\s+(uninstall|remove)\b|\bapt(-get)?\s+(remove|purge)\b/, /\bdocker\s+(rm|rmi|system\s+prune)\b/,
  /\bdefaults\s+delete\b|\blaunchctl\b/, /\bhistory\s+-c\b/, /\bcrontab\b/
]
export function commandRisk (command) {
  const c = String(command || '')
  if (!c.trim()) return 'low'
  if (HIGH_RISK.some(re => re.test(c))) return 'high'
  // Every segment has to clear the allowlist on its own, so `cat notes | grep x`
  // stays low while `cat notes | sh` does not.
  const segments = c.split(/\|\||&&|[;|&\n]/)
  return segments.every(segmentIsReadOnly) ? 'low' : 'high'
}
