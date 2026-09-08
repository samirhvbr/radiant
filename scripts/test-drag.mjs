/**
 * Can the window still be moved?
 *
 * ⚠️ 0.6.234 SHIPPED A WINDOW THAT COULD NOT BE DRAGGED. titleBarStyle
 * 'hiddenInset' deletes the title bar and hands its space to the page, and HTML
 * is not draggable unless it says -webkit-app-region: drag. The app said it
 * exactly once, on the floating HUD; the main window said it nowhere. The
 * change was "verified" with a screenshot — which shows you a title bar and
 * tells you nothing about whether it behaves like one. Tony: "how the fuck
 * could you ship a redesign of the top bar with no dragging."
 *
 * This asserts the COMPUTED value on the REAL rendered DOM, not the source, and
 * it checks both halves. The second half is the one that bites: a drag region
 * swallows clicks, so a button inside one that is not exempted does not merely
 * fail to drag — it stops working altogether. Adding a control to any of these
 * bars without a no-drag rule breaks it, and this is what says so.
 *
 * ⚠️ AND IT VISITS EVERY TAB, WHICH IS THE HOLE THAT LET IT HAPPEN AGAIN. This
 * only ever loaded the default screen — Chat — so it green-lit a build where
 * Tasks, Loops and Graphs had no draggable surface at all. Tony, on the Graph
 * tab: "and now i cant grab the top bar again. what the fuck!!!" A gate that
 * checks one of four screens is a gate that reports on one of four screens.
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'

const PORT = 5877
let pass = 0, fail = 0
const results = []
const ok = (name, cond) => { cond ? pass++ : (fail++, results.push(`  FAIL ${name}`)) }

const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, RADIANT_PORT: String(PORT), NODE_ENV: 'production' },
  stdio: 'ignore'
})
const die = async code => { server.kill(); process.exit(code) }
process.on('exit', () => server.kill())

const base = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(base)).ok) break } catch {}
  await new Promise(r => setTimeout(r, 250))
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
// ⚠️ ELECTRON-ONLY CONTROLS DO NOT EXIST IN A BROWSER, AND THAT IS HOW THE HUD
// BUTTON GOT THROUGH. .hud-open renders only when window.radiantNative.toggleHud
// is present, so this gate ran green while the real app had an unclickable
// button. Stub the native bridge so those controls render and get checked.
await page.addInitScript(() => {
  window.radiantNative = window.radiantNative || {
    toggleHud: () => {}, pickFolder: async () => null, openExternal: () => {}
  }
})
await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForSelector('.app', { timeout: 15000 }).catch(() => {})

const region = sel => page.evaluate(s => {
  const el = document.querySelector(s)
  return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : null
}, sel)

// ── the handles: every strip that touches the window's top edge ──────────────
// .topbar appears only with a session open, .main-drag only without one, so at
// least one of the two must always be present and draggable.
const main = await Promise.all(['.topbar', '.main-drag', '.app-drag'].map(region))
ok('the main pane offers a drag handle', main.includes('drag'))
ok('the sidebar brand is a drag handle', await region('.brand') === 'drag')

// ── every tab, not just the one that loads first ────────────────────────────
const TABS = ['Chat', 'Task', 'Loop', 'Graph']
// ⚠️ WHERE, NOT WHETHER. The first version of this asked "is anything on the
// page draggable" — and the sidebar's .brand always is, on every tab, so it
// answered yes for screens with nothing grabbable in the main pane at all. It
// also counted an element that was in the DOM, computed drag, and rendered ZERO
// PIXELS WIDE. What the user reaches for is the top of the window to the right
// of the sidebar; that is what has to be measured.
async function grabbable () {
  return page.evaluate(() => {
    const side = document.querySelector('.sidebar')
    const left = side ? side.getBoundingClientRect().right : 0
    return [...document.querySelectorAll('*')].some(el => {
      if (getComputedStyle(el).getPropertyValue('-webkit-app-region') !== 'drag') return false
      const r = el.getBoundingClientRect()
      if (r.height < 8) return false
      return r.right > left + 40 && r.top < 40      // reaches the main pane's top strip
    })
  })
}
// ⚠️ THE SWALLOW CHECK RUNS PER TAB TOO. It used to run once, on whichever
// screen happened to be loaded — so a button swallowed on the Graph tab was
// invisible to it for exactly the same reason the missing handle was.
async function swallowedControls () {
  return page.evaluate(() => {
  const bars = ['.topbar', '.brand', '.right-tabs', '.main-drag', '.app-drag']
  const region = el => getComputedStyle(el).getPropertyValue('-webkit-app-region')
  const rect = el => el.getBoundingClientRect()
  const hits = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top)
  const dragRects = bars
    .map(b => document.querySelector(b))
    .filter(el => el && region(el) === 'drag')
    .map(el => ({ sel: el.className || el.tagName, r: rect(el) }))
  if (!dragRects.length) return []
  const bad = []
  for (const el of document.querySelectorAll('button, a, input, select, textarea, [role="button"], [data-tip]')) {
    const r = rect(el)
    if (!r.width || !r.height) continue                       // hidden
    if (region(el) === 'no-drag') continue
    const over = dragRects.find(d => hits(r, d.r))
    if (over) bad.push(`${el.tagName.toLowerCase()}.${el.className || '(no class)'} overlaps the drag region .${over.sel}`)
  }
  return bad
  })
}

for (const tab of TABS) {
  const btn = page.locator(`.sidebar-switch button:text-is("${tab}")`).first()
  if (!(await btn.count())) { ok(`the ${tab} tab exists to be checked`, false); continue }
  await btn.click()
  await page.waitForTimeout(250)
  ok(`the window can be dragged on the ${tab} tab`, await grabbable())
  const bad = await swallowedControls()
  ok(`no control is swallowed on the ${tab} tab${bad.length ? ' — ' + bad.slice(0, 3).join(', ') : ''}`, bad.length === 0)
}

// ── the exemptions: nothing clickable may sit inside a drag region ───────────
// ⚠️ A DRAG REGION IS A RECTANGLE, NOT A SUBTREE. The first version of this
// check only walked descendants of each drag bar, so it missed .hud-open —
// position:absolute at the top-right of the sidebar, landing inside .brand's
// rect without being inside .brand. Anything INTERSECTING a drag rect is
// swallowed, child or not, so intersection is what gets tested.

// ── and the HUD, which has no title bar of any kind ──────────────────────────
// ⚠️ A FRESH PAGE, not page.goto with a different hash — same-document hash
// navigation does not re-run the SPA's route pick, so the first attempt at this
// was still looking at the main window and reported a false failure.
const hud = await browser.newPage({ viewport: { width: 320, height: 420 } })
await hud.goto(`${base}/#hud`, { waitUntil: 'networkidle' })
await hud.waitForSelector('.hud-head', { timeout: 10000 }).catch(() => {})
const hudRegion = await hud.evaluate(() => {
  const el = document.querySelector('.hud-head')
  return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region') : null
})
ok('the HUD header is still a drag handle', hudRegion === 'drag')

await browser.close()
console.log(results.join('\n'))
console.log(`\n${pass}/${pass + fail} passed  ·  the window can still be moved`)
await die(fail ? 1 : 0)
