// Reusing the page the human already has (reported as a defect).
//
// The report: they opened a page by hand, then a tool call drove the plugin's own blank tab instead
// and reported nothing about the page on screen — which reads as "the page is broken" — and opening
// the same URL again produced a SECOND tab. `openUrl` now binds the existing page when the URL
// matches, and only then.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

const source = readFileSync(new URL('../src/browser-electron/provider.ts', import.meta.url), 'utf8')

test('opening a URL that is already open binds that page instead of creating another', () => {
  const at = source.indexOf('private async adoptMatchingPage')
  assert.ok(at !== -1, 'the reuse path exists')
  const block = source.slice(at, at + 2200)

  assert.match(block, /this\.host\.adoptPage\(this\.carrierTab\(s, match\.id\), this\.carrierScope\(s\)\)/, 'it adopts the canonical carrier page for its session')
  assert.match(block, /s\.tabs\.push\(tab\)/, 'and binds it into the session')
  assert.match(block, /s\.activeIndex = s\.tabs\.length - 1/, 'as the active tab')
  // Both halves of the carrier surface are optional; without either, the old behaviour is correct.
  assert.match(block, /this\.host\.adoptPage === undefined \|\| this\.host\.listPages === undefined/,
    'a carrier without both capabilities falls through')
  assert.match(block, /return false/, 'and says so, so the caller navigates as before')
})

test('only an exact match reuses a page, so a deliberate navigation is never redirected', () => {
  const comparableUrl = url => ElectronBrowserProvider.prototype.comparableUrl(url)
  const wanted = comparableUrl('https://example.test/page?q=one')
  assert.equal(wanted, 'https://example.test/page?q=one')
  for (const url of ['https://example.test/page/?q=one', 'https://example.test/page?q=one#section']) {
    assert.equal(comparableUrl(url), wanted, url)
  }
  for (const url of ['https://example.test/page?q=two', 'https://example.test/other?q=one',
    'https://other.test/page?q=one', 'http://example.test/page?q=one']) {
    assert.notEqual(comparableUrl(url), wanted, url)
  }
  for (const url of ['', 'about:blank', 'not a URL', 'http://[invalid']) {
    assert.equal(comparableUrl(url), undefined, JSON.stringify(url))
  }
})

test('the reuse path is consulted before navigating, and a new tab skips it', () => {
  const at = source.indexOf('async openUrl(')
  const block = source.slice(at, at + 1400)
  const adopt = block.indexOf('await this.adoptMatchingPage')
  const navigate = block.indexOf('await this.navigateTab(')
  assert.ok(adopt !== -1 && navigate !== -1, 'both steps are present')
  assert.ok(adopt < navigate, 'reuse is tried first')
  assert.match(block, /request\.newTab !== true && await this\.adoptMatchingPage/,
    'an explicit new tab is never redirected onto an existing page')
})
