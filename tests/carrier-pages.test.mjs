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
  assert.match(provider, /listPages\?\(owner\?: string\): Promise<readonly CarrierPage\[\]>/, 'listPages is declared')
  assert.match(provider, /closePage\?\(id: string, owner\?: string\): Promise<void>/, 'and closePage with it')
})

test('the sidebar carrier lists and closes the panel pages the shell owns', () => {
  assert.match(bridgeHost, /async listPages\(owner: string = this.owner\): Promise<readonly CarrierPage\[\]>/, 'implemented')
  assert.match(bridgeHost, /answer\.sidebar/, 'from the bridge answer that already carries them')
  assert.match(bridgeHost, /async closePage\(id: string, owner: string = this.owner\): Promise<void>/, 'and closePage too')
  // The bridge closes by title and only for the caller's own guests — that restriction is what
  // stopped one conversation's teardown destroying another's page, so the title is looked up
  // rather than the restriction being worked around.
  assert.match(bridgeHost, /op: 'closePage', id: numeric, owner/, 'closing carries the exact guest and requesting conversation')
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
  assert.match(body, /this\.host\.listPages\?\.\(s.label\)/, 'the listing asks the carrier for this conversation')
  assert.match(body, /`page:\$\{page\.id\}`/, 'and marks those rows as carrier-owned')
  // A blank page the carrier opened for itself is not something a caller can act on, and the
  // blank normalisation already closes those.
  assert.match(body, /about:blank/, 'and blanks are skipped')
  // Deduplication is NOT here, and that is the point: a provider tab is known by the provider's
  // own id and a carrier page by the carrier's, so a comparison at this level matches nothing.
  // A first version did compare them and listed every page twice — measured on a live window.
  assert.doesNotMatch(body, /known\.has\(/, 'and it does not try to dedupe across id spaces here')
})

test('each host excludes the views it opened, where the mapping exists', () => {
  // This is the only place the match CAN be made: the host keeps the view id next to the carrier's
  // own id for it. Sidebar: `views` holds the guest number. Installed browser: `sessions` holds
  // the CDP target id.
  const sidebarList = bridgeHost.slice(bridgeHost.indexOf('async listPages('))
  const sidebarBody = sidebarList.slice(0, sidebarList.indexOf('\n  }'))
  assert.match(sidebarBody, /for \(const view of this\.views\.values\(\)\)/, 'the sidebar host walks its own views')
  assert.match(sidebarBody, /ours\.add\(view\.guest\)/, 'collecting the guests it opened')
  assert.match(sidebarBody, /!ours\.has\(guest\.id\)/, 'and excludes them')

  const browserList = systemHost.slice(systemHost.indexOf('async listPages()'))
  const browserBody = browserList.slice(0, browserList.indexOf('\n  }'))
  assert.match(browserBody, /this\.sessions\.values\(\)/, 'the browser host walks its sessions')
  assert.match(browserBody, /!ours\.has\(entry\.targetId as string\)/, 'and excludes its own targets')
})

test('closeTab understands those ids instead of refusing them', () => {
  const closeTab = provider.slice(provider.indexOf('closeTab(session: BrowserSessionId'))
  const body = closeTab.slice(0, closeTab.indexOf('\n  }'))
  assert.match(body, /tabId\.startsWith\('page:'\)/, 'the prefix selects the carrier path')
  assert.match(body, /this\.host\.closePage\(id, owner\)/, 'which closes through the host for this conversation')
  // A carrier that cannot close what it lists says so, rather than pretending the id is unknown.
  assert.match(body, /BROWSER_TAB_NOT_FOUND/, 'and a host without closePage reports why')
})
