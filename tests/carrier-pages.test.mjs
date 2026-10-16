// Pages a carrier opens on its own, and why they must be visible.
//
// Measured on a real machine, driving 4399 through each carrier: every click that opened a new
// page produced a page NOTHING reported. On the sidebar carrier the shell held three webview
// guests while `dsh_browser_list_tabs` answered one; on the installed-browser carrier the window
// held four pages while the tool answered one. Those pages are real — the human sees them, they
// hold memory, and they persist — but they could not be listed and could not be closed, so they
// accumulated for the life of the browser.
//
// The three carriers differ in who creates a page, which is why this is a host capability rather
// than something the provider can do on its own:
//   self-hosted  — Electron's `setWindowOpenHandler` turns a popup into a `newTab` user action,
//                  so those pages already enter the model and need nothing new;
//   sidebar      — the shell creates them inside its panel and reports them only through `list`;
//   chrome/edge  — the browser creates them and reports them only through `Target.getTargets`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
const provider = read('../src/browser-electron/provider.ts')
const bridgeHost = read('../src/browser-electron/desktop-bridge-host.ts')
const systemHost = read('../src/browser-electron/system-browser.ts')
const selfHosted = read('../src/browser-electron/host-main.ts')

test('the seam declares both halves, and closing is part of listing', () => {
  // Listing a page the caller cannot close is worse than not listing it: the two tools would
  // contradict each other, which reads as a bug in whichever one the caller tried second.
  assert.match(provider, /listPages\?\(\): Promise<readonly CarrierPage\[\]>/, 'listPages is declared')
  assert.match(provider, /closePage\?\(id: string\): Promise<void>/, 'and closePage with it')
})

test('the sidebar carrier lists and closes the panel pages the shell owns', () => {
  assert.match(bridgeHost, /async listPages\(\): Promise<readonly CarrierPage\[\]>/, 'implemented')
  assert.match(bridgeHost, /answer\.sidebar/, 'from the bridge answer that already carries them')
  assert.match(bridgeHost, /async closePage\(id: string\): Promise<void>/, 'and closePage too')
  // The bridge closes by title and only for the caller's own guests — that restriction is what
  // stopped one conversation's teardown destroying another's page, so the title is looked up
  // rather than the restriction being worked around.
  assert.match(bridgeHost, /closeSidebarBrowser/, 'closing goes through the owner-scoped op')
  assert.match(bridgeHost, /owner: this\.owner/, 'scoped to this conversation')
})

test('the installed-browser carrier lists and closes its pages by target id', () => {
  assert.match(systemHost, /async listPages\(\): Promise<readonly CarrierPage\[\]>/, 'implemented')
  assert.match(systemHost, /Target\.getTargets/, 'from the browser\'s own target list')
  assert.match(systemHost, /async closePage\(id: string\): Promise<void>/, 'and closePage too')
  assert.match(systemHost, /Target\.closeTarget/, 'using the browser\'s own close')
})

test('the self-hosted carrier already routes popups into the model, url included', () => {
  // This is why it needs no listPages: it intercepts the popup and reports it as a tab action.
  assert.match(selfHosted, /setWindowOpenHandler/, 'popups are intercepted in the host window')
  assert.match(selfHosted, /type: 'newTab'[\s\S]{0,80}url/, 'and reported as a newTab carrying the url')
  // The url matters. A newTab that ignored it would open a blank tab and lose the page the human
  // asked for, which looks like the click did nothing.
  const handler = provider.slice(provider.indexOf("case 'newTab':"))
  const block = handler.slice(0, handler.indexOf('case ', 10))
  assert.match(block, /this\.newTab\(s\)/, 'a tab is created')
  assert.match(block, /action\.url !== undefined/, 'and the url is honoured, not dropped')
  assert.match(block, /await this\.navigate\(s\.id, \{ url: action\.url \}\)/, 'by navigating to it')
})

test('carrier pages are merged into the listing under a distinguishable id', () => {
  const listTabs = provider.slice(provider.indexOf('async listTabs('))
  const body = listTabs.slice(0, listTabs.indexOf('\n  }'))
  assert.match(body, /this\.host\.listPages\?\.\(\)/, 'the listing asks the carrier')
  assert.match(body, /`page:\$\{page\.id\}`/, 'and marks those rows as carrier-owned')
  // Deduplication is not cosmetic: the provider's own views appear in the carrier's list too, so
  // without it every tab we created would be reported twice.
  assert.match(body, /known\.has\(page\.id\)/, 'pages we created are not listed twice')
  // A blank page the carrier opened for itself is not something a caller can act on, and the
  // blank normalisation already closes those.
  assert.match(body, /about:blank/, 'and blanks are skipped')
})

test('closeTab understands those ids instead of refusing them', () => {
  const closeTab = provider.slice(provider.indexOf('closeTab(session: BrowserSessionId'))
  const body = closeTab.slice(0, closeTab.indexOf('\n  }'))
  assert.match(body, /tabId\.startsWith\('page:'\)/, 'the prefix selects the carrier path')
  assert.match(body, /this\.host\.closePage\(id\)/, 'which closes through the host')
  // A carrier that cannot close what it lists says so, rather than pretending the id is unknown.
  assert.match(body, /BROWSER_TAB_NOT_FOUND/, 'and a host without closePage reports why')
})
