// Reusing the page the human already has (reported as a defect).
//
// The report: they opened a page by hand, then a tool call drove the plugin's own blank tab instead
// and reported nothing about the page on screen — which reads as "the page is broken" — and opening
// the same URL again produced a SECOND tab. `openUrl` now binds the existing page when the URL
// matches, and only then.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/browser-electron/provider.ts', import.meta.url), 'utf8')

test('opening a URL that is already open binds that page instead of creating another', () => {
  const at = source.indexOf('private async adoptMatchingPage')
  assert.ok(at !== -1, 'the reuse path exists')
  const block = source.slice(at, at + 2200)

  assert.match(block, /this\.host\.adoptPage\(match\.id\)/, 'it adopts the carrier page it matched')
  assert.match(block, /s\.tabs\.push\(tab\)/, 'and binds it into the session')
  assert.match(block, /s\.activeIndex = s\.tabs\.length - 1/, 'as the active tab')
  // Both halves of the carrier surface are optional; without either, the old behaviour is correct.
  assert.match(block, /this\.host\.adoptPage === undefined \|\| this\.host\.listPages === undefined/,
    'a carrier without both capabilities falls through')
  assert.match(block, /return false/, 'and says so, so the caller navigates as before')
})

test('only an exact match reuses a page, so a deliberate navigation is never redirected', () => {
  const at = source.indexOf('private comparableUrl')
  assert.ok(at !== -1, 'the comparison exists')
  const block = source.slice(at, at + 700)
  // Hash and trailing slash are not identity: a hash is a position inside a document and a slash is
  // spelling, so neither should make the page look different — or make a DIFFERENT page look same.
  assert.ok(block.includes("parsed.pathname.replace("), 'a trailing slash is normalised')
  assert.ok(block.includes('parsed.search'), 'the query is part of identity')
  assert.ok(!block.includes('parsed.hash'), 'the hash is not')
  // An unparseable or blank URL never matches, so nothing is adopted by accident.
  assert.match(block, /url === '' \|\| url === 'about:blank'\) return undefined/)
  assert.match(block, /catch \{\n      return undefined/, 'and an unparseable URL does not match either')
})

test('the reuse path is consulted before navigating, and a new tab skips it', () => {
  const at = source.indexOf('async openUrl(')
  const block = source.slice(at, at + 1400)
  const adopt = block.indexOf('await this.adoptMatchingPage')
  const navigate = block.indexOf('await this.navigate(')
  assert.ok(adopt !== -1 && navigate !== -1, 'both steps are present')
  assert.ok(adopt < navigate, 'reuse is tried first')
  assert.match(block, /request\.newTab !== true && await this\.adoptMatchingPage/,
    'an explicit new tab is never redirected onto an existing page')
})
