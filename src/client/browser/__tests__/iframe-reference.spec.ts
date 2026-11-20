// @vitest-environment jsdom
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { guestRuntimeScript } from '../../../browser-electron/guest-runtime.ts'
import { captureEntrySource } from '../../../browser-reference/page-script.ts'
import { BrowserController, type BrowserControllerOptions } from '../BrowserController.ts'
import { createBrowserInitializationJournal, createBrowserInitializationReader } from '../initialization.ts'
import { createIframePage } from '../../pages.ts'
import { iframeReferenceSource } from '../iframe-reference.ts'
import { openReferenceSource } from '../../reference/client/production/source-opener.ts'
import { makeSnapshot } from '../../reference/client/__tests__/production.fixtures.ts'
import { webReferenceHttp } from '../../../../tests/fixtures/web-reference-http.mjs'

const owner = '79b4e5bd-5bf4-49f3-b911-5d1a92b7002b'
const sessionId = `session-${owner}`
const tabId = 'web-source-tab' as TabId
const url = 'https://example.test/article'
const snapshot = { ...makeSnapshot(owner), source: { ...makeSnapshot(owner).source, pageUrl: url, frameRoute: 'main' as const },
  parts: [{ partId: 'text', type: 'text' as const, text: 'selected words', content: [], anchor: { exact: 'selected words', prefix: '', suffix: '' } }] }
const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); document.body.replaceChildren() })

function fixture(initial = url) {
  const listeners = new Set<() => void>()
  const journal = createBrowserInitializationJournal({ onChange: () => { for (const listener of listeners) listener() } })
  let page!: ReturnType<typeof createIframePage>
  const controller = new BrowserController({
    sessionId, tabId, journal, occurrenceId: 'web', signal: new AbortController().signal,
    applicationOrigin: location.origin, initial: undefined,
    actions: { replace() {} } as BrowserControllerOptions['actions'], openTab() {},
    createPage: options => (page = createIframePage(options, sessionId)),
  })
  const navigate = vi.fn((_owner: string, _tab: TabId, url: string) => { controller.navigate(url, 2); return true })
  const reader = createBrowserInitializationReader(() => journal.get(tabId), listener => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  }, () => controller.currentPage(), navigate)
  const sidebar = { tabsIn: () => [{ id: tabId, kind: 'browser' }], openTabIn: vi.fn() }
  const host = document.createElement('div'); host.id = 'web-reveal'; document.body.append(host)
  controller.navigate(initial, 1)
  page.presentation.mount(host.id)
  disposers.push(async () => { await controller.dispose(); journal.dispose() })

  function connect(html = '<p>before selected words after</p>', holdReady = false, deferLoad = false) {
    const frame = host.querySelector('iframe')!
    const guest = { window: frame.contentWindow! }
    guest.window.document.open()
    guest.window.document.write('<html><body>' + html + '</body></html>')
    guest.window.document.close()
    disposers.push(() => { guest.window.close() })
    Object.defineProperty(guest.window.document, 'readyState', { value: 'complete', configurable: true })
    vi.spyOn(guest.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 100, right: 180, bottom: 120, width: 170, height: 20 } as DOMRect)
    Object.defineProperty(guest.window.Range.prototype, 'getClientRects', { value: () => [{ left: 10, top: 100, right: 180, bottom: 120, width: 170, height: 20 }] })
    const held: object[] = []
    const receive = (data: object, source: Window | null = frame.contentWindow, origin = 'null') => {
      window.dispatchEvent(new MessageEvent('message', { origin, source, data }))
    }
    const parent = { postMessage(data: { type: string }) {
      if (holdReady && data.type === 'dsh.browser.guest.navigation') held.push(data)
      else receive(data)
    } }
    Object.defineProperty(guest.window, 'parent', { value: parent })
    runInNewContext(guestRuntimeScript(new URL(frame.src).searchParams.get('u')!), {
      window: guest.window, document: guest.window.document, parent, location: guest.window.location, history: guest.window.history,
      URL, URLSearchParams, Request, Headers, NodeFilter: guest.window.NodeFilter, Element: guest.window.Element,
      HTMLFormElement: guest.window.HTMLFormElement, XMLHttpRequest: guest.window.XMLHttpRequest,
      MutationObserver: guest.window.MutationObserver, navigator: guest.window.navigator,
      setTimeout: guest.window.setTimeout.bind(guest.window), clearTimeout: guest.window.clearTimeout.bind(guest.window),
    })
    const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(data => {
      guest.window.dispatchEvent(new guest.window.MessageEvent('message', { origin: location.origin, source: parent as unknown as Window, data }))
    })
    const loaded = () => { frame.dispatchEvent(new Event('load')) }
    if (deferLoad) guest.window.dispatchEvent(new guest.window.Event('DOMContentLoaded'))
    else loaded()
    return { guest, post, frame, receive, loaded, ready: () => { holdReady = false; for (const report of held.splice(0)) receive(report) } }
  }
  return { connect, controller, reader, sidebar, navigate, journal, page: () => page }
}

it.each(['canonical', 'proxy'] as const)('captures a %s-URL frozen selection from the isolated Web guest and completes a registered model-tool reveal over real HTTP', async transport => {
  const server = await webReferenceHttp()
  disposers.push(() => server.close())
  const previousFetch = globalThis.fetch
  let captured: { referenceId: string } | undefined
  const sequence: string[] = []
  let removed = false
  globalThis.fetch = vi.fn(async (input, init) => {
    const path = new URL(String(input), server.baseUrl).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    sequence.push(body?.operation ?? path.split('/').pop()!)
    const response = await server.call(path, body)
    if (path.endsWith('/capture') && response.status === 200) captured = response.json().reference
    if (body?.operation === 'remove') removed = true
    return new Response(response.text, { status: response.status })
  })
  disposers.push(() => { globalThis.fetch = previousFetch })
  const f = fixture()
  const guest = f.connect()
  const range = guest.guest.window.document.createRange()
  range.selectNodeContents(guest.guest.window.document.querySelector('p')!)
  guest.guest.window.getSelection()!.addRange(range)
  const frozen = runInNewContext(`(${captureEntrySource()})({context:32})`, {
    window: guest.guest.window, document: guest.guest.window.document,
    location: transport === 'proxy' ? guest.guest.window.location : { href: url },
    URL, NodeFilter: guest.guest.window.NodeFilter,
  })
  expect(frozen.ok).toBe(true)
  expect(frozen.url).toBe(transport === 'proxy' ? guest.frame.src : url)
  guest.receive({ type: 'dsh-browser-ref:intent', origin: 'user-selection', entry: 'page-overlay', hasSelection: true, capture: frozen })
  await vi.waitFor(() => { expect(captured).toBeDefined() })
  expect(sequence.slice(0, 3)).toEqual(['register', 'poll', 'capture'])
  const reference = server.service.get(captured!.referenceId)
  expect(reference.source.pageUrl).toBe(url)
  expect(reference.source.frameUrl).toBe(url)
  expect(reference.owner).toEqual({ sessionId: owner, sourcePageId: f.controller.currentPage()!.guestId })
  expect(reference.owner.browserSessionId).toBeUndefined()
  expect((await server.reveal(reference.referenceId, sessionId)).status).toBe('revealed')
  expect(guest.guest.window.document.querySelector('#__dsh-ref-highlight')?.children.length).toBe(1)
  const opened = await openReferenceSource(f.sidebar, f.reader, sessionId, url, new AbortController().signal)
  expect(opened.pageId).toBe(reference.owner.sourcePageId)
  expect(await opened.reveal!(reference, undefined, new AbortController().signal)).toBe('revealed')
  expect((await server.reveal(reference.referenceId, 'session-other-owner')).status).toBe('unavailable')
  await f.controller.dispose()
  await vi.waitFor(() => { expect(removed).toBe(true) })
  expect((await server.reveal(reference.referenceId, sessionId)).status).toBe('unavailable')
})

it.each([true, false])('reveals through the actual Web guest runtime after readiness (already at source: %s)', async samePage => {
  const f = fixture(samePage ? url : 'https://cn.bing.com/')
  let guest = f.connect()
  expect(f.controller.currentPage()?.guestId).toMatch(/^iframe:/u)
  let completed = false
  const opened = openReferenceSource(f.sidebar, f.reader, sessionId, url, new AbortController().signal).then(source => { completed = true; return source })
  if (!samePage) {
    guest = f.connect(undefined, true)
    expect(f.journal.get(tabId)?.stage).toBe('navigating')
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(guest.post.mock.calls.some(([data]) => data.type === 'dsh.browser.guest.reference.request')).toBe(false)
    guest.ready()
  }
  const source = await opened
  expect(f.navigate).toHaveBeenCalledTimes(samePage ? 0 : 1)
  expect(iframeReferenceSource(source.pageId, 'another-conversation')).toBeUndefined()
  await expect(source.reveal!(snapshot, undefined, new AbortController().signal)).resolves.toBe('revealed')
  expect(guest.guest.window.document.querySelector('#__dsh-ref-highlight')?.children.length).toBe(1)
  const commands = guest.post.mock.calls.map(([data]) => data).filter(data => data.type === 'dsh.browser.guest.reference.request')
  expect(commands.map(data => data.operation)).toEqual(['text', 'highlight'])
  expect(commands[1].spec.end - commands[1].spec.start).toBe('selected words'.length)
  await expect(source.reveal!({ ...snapshot, owner: { sessionId: 'another-conversation' } }, undefined, new AbortController().signal)).resolves.toBe('session-mismatch')
})

it.each([
  { table: '<thead><tr><th>Firstname</th><th>Lastname</th></tr></thead><tbody><tr><td>Peter</td><td>Griffin</td></tr><tr><td>Lois</td><td>Griffin</td></tr></tbody>', cells: 6, selected: 'FirstnameLastnamePeterGriffinLoisGriffin' },
  { table: '<thead><tr><th colspan="2">Firstname</th></tr></thead><tbody><tr><td rowspan="2">Peter</td><td>Griffin</td></tr><tr><td>Griffin</td></tr></tbody>', cells: 4, selected: 'FirstnamePeterGriffinGriffin' },
])('captures a dragged Runoob-like table ($cells cells) over HTTP and selects its cells after navigating back', async ({ table, cells, selected }) => {
  const server = await webReferenceHttp()
  disposers.push(() => server.close())
  const sourceUrl = 'https://www.runoob.com/html/html-tables.html'
  const html = '<div id="content"><h2>HTML 表格</h2><table>' + table + '</table></div>'
  let captured: { referenceId: string } | undefined
  let polledUrl: string | undefined
  const previousFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async (input, init) => {
    const path = new URL(String(input), server.baseUrl).pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const response = await server.call(path, body)
    if (body?.operation === 'poll') polledUrl = body.url
    if (path.endsWith('/capture') && response.status === 200) captured = response.json().reference
    return new Response(response.text, { status: response.status })
  })
  disposers.push(() => { globalThis.fetch = previousFetch })
  const f = fixture(sourceUrl)
  let guest = f.connect(html)
  const doc = guest.guest.window.document
  const range = doc.createRange()
  range.setStart(doc.querySelector('th')!.firstChild!, 0)
  range.setEnd(doc.querySelector('tr:last-child td:last-child')!.firstChild!, 'Griffin'.length)
  guest.guest.window.getSelection()!.addRange(range)
  const frozen = runInNewContext(`(${captureEntrySource()})({context:32})`, {
    window: guest.guest.window, document: doc, location: guest.guest.window.location, URL, NodeFilter: guest.guest.window.NodeFilter,
  })
  expect(frozen.events.map((event: { kind: string }) => event.kind)).toEqual(['table'])
  expect(doc.querySelector(frozen.events[0].selector)).toBe(doc.querySelector('table'))
  guest.receive({ type: 'dsh-browser-ref:intent', origin: 'user-selection', entry: 'page-overlay', hasSelection: true, capture: frozen })
  await vi.waitFor(() => { expect(captured).toBeDefined() })
  const reference = server.service.get(captured!.referenceId)
  expect(reference.parts[0].type).toBe('table')
  f.controller.navigate('https://cn.bing.com/', 2)
  f.connect('<p>Another page</p>')
  await vi.waitFor(() => { expect(polledUrl).toBe('https://cn.bing.com/') })
  expect((await server.reveal(reference.referenceId, sessionId)).status).toBe('page-mismatch')
  const opening = openReferenceSource(f.sidebar, f.reader, sessionId, sourceUrl, new AbortController().signal)
  guest = f.connect(html, true, true)
  guest.ready()
  const source = await opening
  await vi.waitFor(() => { expect(polledUrl).toBe(sourceUrl) })
  expect(await source.reveal!(reference, undefined, new AbortController().signal)).toBe('revealed')
  const returned = guest.guest.window.document
  expect(returned.querySelector('#__dsh-ref-highlight')?.children).toHaveLength(cells)
  expect(guest.guest.window.getSelection()!.toString()).toBe(selected)
  guest.loaded()
  expect(guest.guest.window.getSelection()!.toString()).toBe(selected)
  const command = guest.post.mock.calls.map(([data]) => data).find(data => data.operation === 'element')
  expect(command.spec.cells).toHaveLength(cells)
  guest.guest.window.dispatchEvent(new guest.guest.window.Event('resize'))
  expect(returned.querySelector('#__dsh-ref-highlight')).toBeNull()
  expect(guest.guest.window.getSelection()!.toString()).toBe(selected)
})

it('reports missing and ambiguous text and guest operation errors explicitly', async () => {
  const f = fixture()
  const guest = f.connect('<p>selected words selected words</p>')
  const source = await openReferenceSource(f.sidebar, f.reader, sessionId, url, new AbortController().signal)
  await expect(source.reveal!(snapshot, undefined, new AbortController().signal)).resolves.toBe('ambiguous')
  await expect(source.reveal!({ ...snapshot, parts: [] }, undefined, new AbortController().signal)).resolves.toBe('not-found')
  guest.guest.window.document.body.textContent = ''
  await expect(source.reveal!(snapshot, undefined, new AbortController().signal)).resolves.toBe('missing')
  guest.guest.window.document.body.textContent = 'selected words'
  guest.guest.window.document.createRange = () => { throw new Error('guest range failed') }
  await expect(source.reveal!(snapshot, undefined, new AbortController().signal)).rejects.toThrow('guest range failed')
})

it('reveals a formula after navigation back at DOM readiness, without waiting for resource load', async () => {
  const f = fixture('https://katex.org/')
  f.connect('<p>initial source</p>')
  f.controller.navigate('https://away.example/', 2)
  f.connect('<p>away</p>')
  const opened = openReferenceSource(f.sidebar, f.reader, sessionId, 'https://katex.org/', new AbortController().signal)
  const guest = f.connect('<p>before <span class="katex" data-latex="\\KaTeX">KaTeX</span> after</p>', false, true)
  const source = await opened
  const formula = { ...snapshot, source: { ...snapshot.source, pageUrl: 'https://katex.org/' }, parts: [{
    partId: 'p1', type: 'text' as const, text: '\\KaTeX', content: [{ type: 'math' as const, latex: '\\KaTeX', display: false }],
    anchor: { exact: '\\KaTeX', prefix: 'before ', suffix: ' after' },
  }] }
  await expect(source.reveal!(formula, undefined, new AbortController().signal)).resolves.toBe('revealed')
  expect(guest.guest.window.getSelection()!.toString()).toBe('KaTeX')
  expect(guest.guest.window.document.querySelector('#__dsh-ref-highlight')).not.toBeNull()
  guest.loaded()
  expect(guest.guest.window.getSelection()!.toString()).toBe('KaTeX')
  expect(f.controller.currentPage()?.url).toBe('https://katex.org/')
})

it.each(['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'fragment', 'properties'] as const)('proxies runtime stylesheet and image URLs synchronously through %s', async insertion => {
  const f = fixture('https://www.bing.com/search?q=example')
  const guest = f.connect('<div id="dynamic"></div>')
  const doc = guest.guest.window.document
  const host = doc.querySelector('#dynamic')!
  const markup = '<link rel="stylesheet" href="/x.css"><img src="/y.png">'
  if (insertion === 'innerHTML') host.innerHTML = markup
  else if (insertion === 'outerHTML') host.outerHTML = markup
  else if (insertion === 'insertAdjacentHTML') host.insertAdjacentHTML('beforeend', markup)
  else if (insertion === 'fragment') {
    const range = doc.createRange()
    range.selectNodeContents(host)
    const fragment = range.createContextualFragment(markup)
    expect(new URL(fragment.querySelector('link')!.getAttribute('href')!, location.origin).pathname).toBe('/dsh-builtin-browser/browser-view/isolated-guest')
    host.append(fragment)
  } else {
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/x.css'
    const image = doc.createElement('img')
    image.src = '/y.png'
    host.append(link, image)
  }
  for (const [selector, attribute, source] of [['link', 'href', 'https://www.bing.com/x.css'], ['img', 'src', 'https://www.bing.com/y.png']]) {
    const resolved = new URL(doc.querySelector(selector)!.getAttribute(attribute)!, location.origin)
    expect(resolved.origin).toBe(location.origin)
    expect(resolved.pathname).toBe('/dsh-builtin-browser/browser-view/isolated-guest')
    expect(resolved.searchParams.get('u')).toBe(source)
  }
  const table = doc.createElement('table')
  table.innerHTML = '<tbody><tr><td>Preserved table context</td></tr></tbody>'
  expect(table.rows[0]!.cells[0]!.textContent).toBe('Preserved table context')
  await Promise.resolve()
  expect(doc.querySelectorAll('link')).toHaveLength(1)
})

it('rejects forged/stale acknowledgements and cancels pending commands on abort or navigation', async () => {
  const f = fixture()
  const guest = f.connect()
  const source = await openReferenceSource(f.sidebar, f.reader, sessionId, url, new AbortController().signal)
  guest.post.mockImplementation(() => {})
  const abort = new AbortController()
  const reveal = source.reveal!(snapshot, undefined, abort.signal)
  const request = guest.post.mock.calls.at(-1)![0]
  const ack = { ...request, type: 'dsh.browser.guest.reference.ack', ok: true, value: { ok: true, text: 'selected words' } }
  guest.receive(ack, null)
  guest.receive(ack, guest.frame.contentWindow, location.origin)
  guest.receive({ ...ack, loadId: request.loadId - 1 })
  guest.receive({ ...ack, requestId: request.requestId + 1 })
  guest.receive({ ...ack, url: 'https://other.test/' })
  guest.receive({ ...ack, value: null })
  expect(guest.post.mock.calls.at(-1)![0].operation).toBe('text')
  abort.abort()
  await expect(reveal).rejects.toThrow('cancelled')
  const next = source.reveal!(snapshot, undefined, new AbortController().signal)
  f.controller.navigate('https://other.test/', 3)
  await expect(next).rejects.toThrow('document changed')
  guest.receive(ack)
})

it('authenticates guest commands and acknowledges malformed or wrong-document requests with errors', () => {
  const f = fixture()
  const guest = f.connect()
  const reply = vi.spyOn(guest.guest.window.parent, 'postMessage')
  const loadId = guest.post.mock.calls.at(-1)![0].loadId
  const documentId = guest.post.mock.calls.at(-1)![0].documentId
  const request = { type: 'dsh.browser.guest.reference.request', loadId, documentId, requestId: 12, url, operation: 'text', spec: {} }
  const send = (data: object, source = guest.guest.window.parent, origin = location.origin) => {
    guest.guest.window.dispatchEvent(new guest.guest.window.MessageEvent('message', { data, source, origin }))
  }
  send(request, guest.guest.window)
  send(request, guest.guest.window.parent, 'https://untrusted.test')
  send({ ...request, loadId: loadId - 1 })
  send({ ...request, documentId: 'stale-document' })
  send({ ...request, requestId: '12' })
  expect(reply).not.toHaveBeenCalled()
  send({ ...request, operation: 'execute' })
  send({ ...request, requestId: 13, url: 'https://wrong.test/' })
  send({ ...request, requestId: 14, operation: 'highlight', spec: { start: -1, end: 1 } })
  send(request)
  expect(reply).toHaveBeenCalledTimes(3)
  for (const [ack] of reply.mock.calls) expect(ack).toMatchObject({ type: 'dsh.browser.guest.reference.ack', loadId, ok: false })
})
