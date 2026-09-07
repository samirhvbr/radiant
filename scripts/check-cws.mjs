#!/usr/bin/env node
/**
 * Is the Chrome extension published yet?
 *
 * ⚠️ THERE IS NO UNAUTHENTICATED WAY TO ASK THIS. The Web Store is entirely
 * client-rendered: chromewebstore.google.com returns the same generic shell,
 * the same <title>, and HTTP 200 for a published extension, for an unpublished
 * draft, and for an item id that does not exist at all. That was measured, not
 * assumed — uBlock Origin, this item, and thirty-two random characters were
 * indistinguishable. So scraping cannot work, and neither can Claude's browser
 * tools: Chrome forbids every extension from scripting chrome.google.com, which
 * includes the developer dashboard.
 *
 * The only real check is the Chrome Web Store API, which needs OAuth
 * credentials. Set these and this script answers for itself:
 *
 *   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN
 *
 * Getting them, once, in Google Cloud Console:
 *   1. Create (or pick) a project, enable the "Chrome Web Store API"
 *   2. OAuth consent screen -> External -> add yourself as a test user
 *   3. Credentials -> Create OAuth client ID -> Desktop app
 *   4. Authorise scope https://www.googleapis.com/auth/chromewebstore.readonly
 *      and exchange the code for a refresh token
 *
 * Until then this exits 2 and says what it needs, rather than guessing.
 */

const ITEM = process.env.CWS_ITEM_ID || 'jhljglakgocklinpblgcopplfinacfk'
const { CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN } = process.env

if (!CWS_CLIENT_ID || !CWS_CLIENT_SECRET || !CWS_REFRESH_TOKEN) {
  console.log('  Cannot check the Chrome Web Store: no API credentials.')
  console.log('  The store cannot be scraped — a published item, a draft and a')
  console.log('  nonexistent id all return HTTP 200 and the same page.')
  console.log('  Set CWS_CLIENT_ID, CWS_CLIENT_SECRET and CWS_REFRESH_TOKEN (see the')
  console.log('  header of this file), or read it at:')
  console.log('    https://chrome.google.com/webstore/devconsole')
  process.exit(2)
}

async function accessToken () {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CWS_CLIENT_ID,
      client_secret: CWS_CLIENT_SECRET,
      refresh_token: CWS_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  })
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`)
  return (await res.json()).access_token
}

try {
  const token = await accessToken()
  const res = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${ITEM}?projection=DRAFT`,
    { headers: { authorization: `Bearer ${token}`, 'x-goog-api-version': '2' } }
  )
  const body = await res.json()
  if (!res.ok) {
    console.log(`  Chrome Web Store API said HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
    process.exit(1)
  }
  // uploadState: SUCCESS | IN_PROGRESS | FAILURE. itemError carries review notes.
  console.log(`  item ${ITEM}`)
  console.log(`  uploadState: ${body.uploadState || '(none)'}`)
  if (body.itemError?.length) {
    for (const e of body.itemError) console.log(`  error: ${e.error_detail || JSON.stringify(e)}`)
  }
  console.log(body.uploadState === 'SUCCESS'
    ? '  → published or ready; check the dashboard for review state'
    : '  → not yet published')
} catch (e) {
  console.log('  check failed: ' + e.message)
  process.exit(1)
}
