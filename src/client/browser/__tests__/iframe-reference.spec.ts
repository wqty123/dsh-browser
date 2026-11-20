// @vitest-environment jsdom
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { guestRuntimeScript } from '../../../browser-electron/guest-runtime.ts'
import { BrowserController, type BrowserControllerOptions } from '../BrowserController.ts'
import { createBrowserInitializationJournal, createBrowserInitializationReader } from '../initialization.ts'
import { createIframePage } from '../../pages.ts'
import { iframeReferenceSource } from '../iframe-reference.ts'
import { openReferenceSource } from '../../reference/client/production/source-opener.ts'
import { makeSnapshot } from '../../reference/client/__tests__/production.fixtures.ts'

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

  function connect(html = '<p>before selected words after</p>', holdReady = false) {
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
    frame.dispatchEvent(new Event('load'))
    return { guest, post, frame, receive, ready: () => { for (const report of held.splice(0)) receive(report) } }
  }
  return { connect, controller, reader, sidebar, navigate, journal, page: () => page }
}

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
  const request = { type: 'dsh.browser.guest.reference.request', loadId, requestId: 12, url, operation: 'text', spec: {} }
  const send = (data: object, source = guest.guest.window.parent, origin = location.origin) => {
    guest.guest.window.dispatchEvent(new guest.guest.window.MessageEvent('message', { data, source, origin }))
  }
  send(request, guest.guest.window)
  send(request, guest.guest.window.parent, 'https://untrusted.test')
  send({ ...request, loadId: loadId - 1 })
  send({ ...request, requestId: '12' })
  expect(reply).not.toHaveBeenCalled()
  send({ ...request, operation: 'execute' })
  send({ ...request, requestId: 13, url: 'https://wrong.test/' })
  send({ ...request, requestId: 14, operation: 'highlight', spec: { start: -1, end: 1 } })
  send(request)
  expect(reply).toHaveBeenCalledTimes(3)
  for (const [ack] of reply.mock.calls) expect(ack).toMatchObject({ type: 'dsh.browser.guest.reference.ack', loadId, ok: false })
})
