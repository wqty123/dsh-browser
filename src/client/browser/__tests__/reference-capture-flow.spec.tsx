// @vitest-environment jsdom
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BrowserReferenceService } from '../../../browser-reference/service.ts'
import { ReferenceStore } from '../../../browser-reference/store.ts'
import { createDeliveryQueue } from '../../../browser-reference/delivery.ts'
import { createReferenceRouteHandlers } from '../../../browser-electron/reference-route.ts'
import { createIframePage } from '../../pages.ts'
import { ElectronWebViewImpl } from '../../electron/ElectronWebViewImpl.ts'
import type { ElectronWebviewPresentation, WebviewElement } from '../../electron/ElectronWebviewPresentation.ts'
import type { DesktopBrowserBridge } from '../../../types.ts'
import { createReferenceHttpClient } from '../../reference/client/production/http-transport.ts'
import { createProductionRuntime } from '../../reference/client/production/runtime.ts'
import { apply as applyClient } from '../../reference/client/plugin.ts'
import type { HostContext } from '../../reference/client/production/assembly.ts'
import { captureReferenceIntent } from '../../reference-intents.ts'
import { createReferenceCapture } from '../../reference-capture-owner.ts'
import { ReferenceCapsules } from '../../reference/client/production/ReferenceCapsules.tsx'
import { referenceLabels } from '../../reference/client/production/reference-labels.ts'
import { fakeHostInput, manualScheduler, memoryKV } from '../../reference/client/__tests__/production.fixtures.ts'
import { openReferenceSource } from '../../reference/client/production/source-opener.ts'
import { createBrowserInitializationJournal, createBrowserInitializationReader } from '../initialization.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function harness(owner = 'owner-B', live?: { url: string; ready: boolean; highlighted: boolean }) {
  const directory = mkdtempSync(join(homedir(), '.dsh-reference-flow-'))
  directories.push(directory)
  const service = new BrowserReferenceService({
    exists: () => false,
    evaluate: async (sessionId, request) => {
      if (!live) throw new Error('a frozen sidebar capture must not evaluate the selected external carrier')
      expect(sessionId).toBe('browser:attached')
      expect(live.ready).toBe(true)
      if (request.script.includes('text: map.text, truncated: map.truncated')) return JSON.stringify({ text: 'selected words' })
      if (request.script.includes('return JSON.stringify(highlightText(spec))')) {
        live.highlighted = true
        return JSON.stringify({ ok: true, rects: 1, scrolled: true })
      }
      if (request.script.includes('String(location.href)')) return JSON.stringify({ url: live.url })
      throw new Error('unexpected source operation')
    },
  }, new ReferenceStore(join(directory, 'references.jsonl')), {
    assetDir: join(directory, 'assets'),
    sourceSession: async (boundOwner, pageId) => {
      expect([boundOwner, pageId]).toEqual([owner, '42'])
      expect(live?.ready).toBe(true)
      return 'browser:attached'
    },
  })
  const queue = createDeliveryQueue({ path: join(directory, 'deliveries.jsonl') })
  const handlers = createReferenceRouteHandlers({ service, queue, carrier: () => 'edge' })
  const request = vi.fn(async (input: string, init?: { method?: string; body?: unknown }) => {
    const url = new URL(input, 'http://127.0.0.1:3080')
    const route = url.pathname.split('/').slice(3).join('/')
    const handler = ({ capture: handlers.capture, reveal: handlers.reveal, list: handlers.list, deliveries: handlers.deliveries, 'delivery/ack': handlers.ack })[route]
    if (handler === undefined) throw new Error(`unexpected route: ${url.pathname}`)
    let status = 0
    let result: unknown
    await handler({
      method: init?.method ?? 'GET', url: `${url.pathname}${url.search}`,
      headers: { host: url.host, origin: url.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { if (typeof init?.body === 'string') yield Buffer.from(init.body) },
    } as IncomingMessage, {
      writeHead(value: number) { status = value },
      end(value: string) { result = JSON.parse(value) as unknown },
    } as unknown as ServerResponse)
    return { ok: status >= 200 && status < 300, status, json: async () => result, bytes: async () => new Uint8Array() }
  })
  vi.stubGlobal('fetch', request)
  const input = fakeHostInput('保留我的问题')
  const runtime = createProductionRuntime({
    http: createReferenceHttpClient({ request }), storage: memoryKV(), initialSessionId: owner, hostInputFor: () => input,
  })
  return { service, queue, request, runtime, input }
}

const intent = {
  type: 'dsh-browser-ref:intent', entry: 'page-overlay', origin: 'user-selection', sessionId: 'untrusted',
  capture: { ok: true, url: 'https://example.test/article', title: 'Frozen article', events: [
    { kind: 'text', exact: 'selected words', prefix: '', suffix: '' },
  ] },
}

const firstOwner = '79b4e5bd-5bf4-49f3-b911-5d1a92b7002b'
const nextOwner = '96092e17-63b5-4f8a-a466-54be10d7daba'

it.each([false, true])('highlights the same sidebar tab without unnecessary navigation (already at source: %s)', async alreadyAtSource => {
  const live = { url: alreadyAtSource ? intent.capture.url : 'https://cn.bing.com/', ready: alreadyAtSource, highlighted: false }
  const { runtime, request, queue } = harness(firstOwner, live)
  const listeners = new Set<() => void>()
  const journal = createBrowserInitializationJournal({ onChange: () => { for (const listener of listeners) listener() } })
  const reader = createBrowserInitializationReader((_session, tab) => journal.get(tab), listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => live.ready ? { url: live.url, guestId: '42' } : undefined)
  const tabId = 'original-sidebar-tab' as TabId
  const sessionId = `session-${firstOwner}`
  journal.begin({ sessionId, tabId, occurrenceId: 'original', navigationRevision: 1, url: live.url })
  journal.advance(tabId, 'attached', { guestId: '42' })
  let requested!: () => void
  const navigated = new Promise<void>(resolve => { requested = resolve })
  const sidebar = {
    tabsIn: () => [{ id: tabId, kind: 'browser' }],
    openTabIn() { throw new Error('must reuse the same tab') },
  }
  reader.navigate = (query) => {
    expect([query.sessionId, query.tabId]).toEqual([sessionId, tabId])
    live.url = query.url
    journal.begin({ sessionId, tabId, occurrenceId: 'original', navigationRevision: 2, url: live.url })
    journal.advance(tabId, 'navigating')
    requested()
    return true
  }
  try {
    await captureReferenceIntent(intent, sessionId)
    await runtime.pollOnce()
    runtime.setSourceOpener((url, signal) => openReferenceSource(sidebar, reader, sessionId, url, signal))
    const activation = runtime.revealReference(runtime.cards()[0]!.referenceId)
    if (!alreadyAtSource) {
      await navigated
      expect(live.highlighted).toBe(false)
      expect(request.mock.calls.filter(([url]) => url.includes('/reference/reveal'))).toHaveLength(1)
      live.ready = true
      journal.advance(tabId, 'attached', { guestId: '42' })
    }
    expect(await activation).toBe('revealed')
    expect(live.url).toBe(intent.capture.url)
    expect(live.highlighted).toBe(true)
    expect(request.mock.calls.filter(([url]) => url.includes('/reference/reveal'))).toHaveLength(2)
  } finally { runtime.dispose(); queue.dispose() }
})

it.each(['', 'unsent question'])('binds the Web hero composer with draft "%s" and no model before first send', async draft => {
  const { service, queue, request, runtime: unused } = harness()
  unused.dispose()
  let dock!: (props: unknown) => unknown
  const disposers: (() => void)[] = []
  const ctx: HostContext = {
    get: name => name === 'uiConversation' ? { userText: { register: () => () => {} } } : undefined,
    set() {},
    effect: effect => { const stop = effect(); if (stop) disposers.push(stop) },
    slots: {
      inject: (name, produce) => {
        if (['conversation.input.dock', 'conversation.user.text.node', 'shell.overlay'].includes(name)) [...produce()]
      },
      register: (registration, component) => {
        if ((registration as { name: string }).name === 'conversation.input.dock') dock = component as typeof dock
      },
    },
  }
  const runtime = applyClient(ctx, { request, storage: memoryKV(), scheduler: manualScheduler() })
  const bind = (sessionId: string | undefined) => dock({
    sessionId,
    session: { sessionId: `session-${firstOwner}` },
    useInput: () => ({ draft }),
    inputActions: { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => true, persistDraft() {} },
  })
  try {
    for (const owner of [firstOwner, nextOwner]) {
      bind(`session-${owner}`)
      expect(runtime.currentSessionId()).toBe(owner)
      expect(renderToStaticMarkup(bind(`session-${owner}`) as ReturnType<typeof createElement>)).toContain('data-cards="0"')
      await runtime.pollOnce()
      const page = createIframePage({ initial: undefined, persist() {}, openRequested() {} }, `session-${owner}`)
      const host = document.createElement('div')
      host.id = `hero-${owner}`
      document.body.append(host)
      page.presentation.mount(host.id)
      page.frame.loadUrl({ kind: 'https', url: intent.capture.url, title: '' })
      window.dispatchEvent(new MessageEvent('message', { origin: 'null', source: host.querySelector('iframe')!.contentWindow, data: intent }))
      await vi.waitFor(() => expect(queue.list({ sessionId: owner }).deliveries).toHaveLength(1))
      expect(request.mock.calls.filter(([url]) => url.endsWith('/capture'))).toHaveLength(owner === firstOwner ? 1 : 2)
      await page.frame.dispose()
      const record = queue.list({ sessionId: owner }).deliveries[0]!
      expect(record.sessionId).toBe(owner)
      expect(record.snapshot.owner.sessionId).toBe(owner)
      expect(service.list({ sessionId: `session-${owner}` })).toHaveLength(1)
      await runtime.pollOnce()
      expect(runtime.cards()).toHaveLength(1)
      expect(runtime.cards()[0]!.referenceId).toBe(record.referenceId)
      expect(renderToStaticMarkup(bind(`session-${owner}`) as ReturnType<typeof createElement>)).toContain('data-cards="1"')
      const content = runtime.submission.buildContent({ sessionId: `session-${owner}`, uploaded: [], text: '', requestId: owner })
      expect(JSON.stringify(content)).toContain('selected words')
      await runtime.submission.commit(`session-${owner}`, owner)
      expect(runtime.cards()).toHaveLength(0)
      expect(runtime.draftState(owner).sent).toHaveLength(1)
    }
    expect(queue.list({ sessionId: nextOwner, includeConsumed: true }).deliveries).toHaveLength(1)
    expect(runtime.draftState(firstOwner).groups).toHaveLength(0)
    // No selected Session must not leave the previously displayed draft active.
    dock({ sessionId: '', inputActions: undefined })
    expect(runtime.currentSessionId()).toBe('')
    expect(runtime.cards()).toHaveLength(0)
    await expect(captureReferenceIntent(intent, '')).rejects.toThrow('owner is unavailable')
    expect(queue.list({ includeConsumed: true }).deliveries).toHaveLength(2)
  } finally { for (const stop of disposers.reverse()) stop(); runtime.dispose(); queue.dispose() }
})

it.each([503, 200])('reports a Web capture refusal (%s) instead of silently accepting it', async status => {
  const request = vi.fn(async (_url: string, _init?: { body?: unknown }) => ({ ok: status === 200, status, json: async () => ({ ok: false }) }))
  vi.stubGlobal('fetch', request)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const page = createIframePage({ initial: undefined, persist() {}, openRequested() {} }, `session-${firstOwner}`)
  const host = document.createElement('div')
  host.id = 'failed-web-capture'
  document.body.append(host)
  page.presentation.mount(host.id)
  page.frame.loadUrl({ kind: 'https', url: intent.capture.url, title: '' })
  try {
    window.dispatchEvent(new MessageEvent('message', { origin: 'null', source: host.querySelector('iframe')!.contentWindow, data: intent }))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[dsh-browser] reference capture failed', expect.any(Error)))
    expect(request).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body)).sessionId).toBe(firstOwner)
  } finally { await page.frame.dispose() }
})

it.each(['native', 'web'] as const)('%s overlay intent reaches its owning composer through the real capture, store and delivery handlers', async surface => {
  const { service, queue, request, runtime, input } = harness(firstOwner)
  await service.capture({ sessionId: 'owner-A', frozenCapture: intent.capture })
  let dispose: () => Promise<void>
  if (surface === 'web') {
    const page = createIframePage({ initial: undefined, persist() {}, openRequested() {} }, `session-${firstOwner}`)
    const host = document.createElement('div')
    host.id = 'capture-flow'
    document.body.append(host)
    page.presentation.mount(host.id)
    page.frame.loadUrl({ kind: 'https', url: intent.capture.url, title: '' }, 'iframe-request')
    expect(page.frame.getSnapshot().navigationId).toBe('iframe-request')
    window.dispatchEvent(new MessageEvent('message', { origin: 'null', source: host.querySelector('iframe')!.contentWindow, data: intent }))
    dispose = () => page.frame.dispose()
  } else {
    const element = document.createElement('div') as unknown as WebviewElement
    const intents = [intent]
    Object.assign(element, {
      loadURL: async () => {}, getURL: () => intent.capture.url, getTitle: () => intent.capture.title,
      canGoBack: () => false, canGoForward: () => false, isLoading: () => false,
      executeJavaScript: async (source: string) => source.startsWith('JSON.stringify(') ? JSON.stringify(intents.splice(0)) : undefined,
    })
    const presentation = {
      createElement: () => element, present: () => element.dispatchEvent(new Event('dom-ready')), clear() {}, dispose() {},
    } as unknown as ElectronWebviewPresentation
    const bridge = {
      acquire: async () => ({ lease: 'lease', partition: 'persist:flow' }), release: async () => {}, onOpenRequested: () => () => {},
    } as unknown as DesktopBrowserBridge
    const frame = new ElectronWebViewImpl({ initial: undefined, persist() {}, openRequested() {} }, bridge, async () => 'workspace', presentation, `session-${firstOwner}`)
    frame.attach()
    frame.loadUrl({ kind: 'https', url: intent.capture.url, title: '' }, 'native-request')
    expect(frame.getSnapshot().navigationId).toBe('native-request')
    dispose = () => frame.dispose()
  }
  try {
    await vi.waitFor(() => expect(queue.list({ sessionId: firstOwner }).deliveries).toHaveLength(1))
    const posts = request.mock.calls.filter(([url]) => url.endsWith('/capture'))
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]![1]!.body)).sessionId).toBe(firstOwner)
    expect(service.list({ sessionId: firstOwner })).toHaveLength(1)
    expect(service.list({ sessionId: firstOwner })[0]?.source.carrier).toBe('sidebar')
    const report = await runtime.pollOnce()
    expect(report?.outcomes[0]?.outcome.kind).toBe('acknowledged')
    expect(runtime.cards()).toHaveLength(1)
    expect(runtime.draftState(firstOwner).groups[0]?.parts[0]).toMatchObject({ kind: 'text', text: 'selected words' })
    expect(input.text).toBe('保留我的问题')
    const capsule = renderToStaticMarkup(createElement(ReferenceCapsules, {
      sessionId: firstOwner, cards: runtime.cards(), actions: {}, labels: referenceLabels(),
    }))
    expect(capsule).toContain('data-cards="1"')
    expect(capsule).toContain('selected words')
    await runtime.pollOnce()
    expect(runtime.cards()).toHaveLength(1)
  } finally { await dispose(); runtime.dispose(); queue.dispose() }
})

it('an empty delivery stream leaves the composer empty without capturing another carrier', async () => {
  const { runtime, queue, request } = harness()
  try {
    const report = await runtime.pollOnce()
    expect(report?.outcomes).toEqual([])
    expect(runtime.cards()).toEqual([])
    expect(request.mock.calls.every(([url]) => !url.endsWith('/capture'))).toBe(true)
  } finally { runtime.dispose(); queue.dispose() }
})

it.each(['native', 'web'] as const)('%s first quote survives home → selected Session → dock → first send', async surface => {
  const { service, queue, request, runtime: unused } = harness()
  unused.dispose()
  let dock!: (props: unknown) => unknown
  const disposers: (() => void)[] = []
  const ctx: HostContext = {
    get: name => name === 'uiConversation' ? { userText: { register: () => () => {} } } : undefined,
    set() {}, effect: effect => { const stop = effect(); if (stop) disposers.push(stop) },
    slots: {
      inject: (name, produce) => { if (['conversation.input.dock', 'conversation.user.text.node', 'shell.overlay'].includes(name)) [...produce()] },
      register: (registration, component) => { if ((registration as { name: string }).name === 'conversation.input.dock') dock = component as typeof dock },
    },
  }
  const runtime = applyClient(ctx, { request, storage: memoryKV(), scheduler: manualScheduler() })
  let selected: string | undefined = surface === 'native' ? `session-${nextOwner}` : undefined
  const listeners = new Set<() => void>()
  const current = { getSnapshot: () => ({ key: selected }), subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }
  const bind = () => dock({ sessionId: selected, useInput: () => ({ draft: '' }), inputActions: {
    captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }), insertText: () => true, persistDraft() {},
  } })
  if (selected !== undefined) expect(renderToStaticMarkup(bind() as ReturnType<typeof createElement>)).toContain('data-cards="0"')
  let open!: () => void
  const openWorkspace = vi.fn(async (_id: string, beforeOpen: (id: string) => void) => {
    beforeOpen(`session-${nextOwner}`)
    open = () => {
      selected = `session-${nextOwner}`
      bind()
      for (const listener of listeners) listener()
    }
  })
  const lifetime = new AbortController()
  const services: Record<string, unknown> = {
    uiSession: { adapter: { current } }, uiWorkspace: { openWorkspace },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', state: 'idle', items: [] }), subscribe: () => () => {} },
      initializeDefault: async () => ({ workspaceId: 'workspace:default' }) },
  }
  const capture = createReferenceCapture({ get: name => services[name] }, lifetime.signal)
  let dispose = async (): Promise<void> => {}
  try {
    if (surface === 'web') {
      const page = createIframePage({ initial: undefined, persist() {}, openRequested() {} }, undefined, capture)
      const host = document.createElement('div')
      host.id = 'home-first-quote'
      document.body.append(host)
      page.presentation.mount(host.id)
      page.frame.loadUrl({ kind: 'https', url: intent.capture.url, title: '' })
      window.dispatchEvent(new MessageEvent('message', { origin: 'null', source: host.querySelector('iframe')!.contentWindow, data: intent }))
      dispose = () => page.frame.dispose()
      await vi.waitFor(() => expect(openWorkspace).toHaveBeenCalledTimes(1))
      expect(request.mock.calls.some(([url]) => url.endsWith('/capture'))).toBe(false)
      open()
    } else {
      const element = document.createElement('div') as unknown as WebviewElement
      const intents = [intent]
      Object.assign(element, {
        loadURL: async () => {}, getURL: () => intent.capture.url, getTitle: () => intent.capture.title,
        canGoBack: () => false, canGoForward: () => false, isLoading: () => false,
        executeJavaScript: async (source: string) => source.startsWith('JSON.stringify(') ? JSON.stringify(intents.splice(0)) : undefined,
      })
      const presentation = { createElement: () => element, present: () => element.dispatchEvent(new Event('dom-ready')), clear() {}, dispose() {} } as unknown as ElectronWebviewPresentation
      const bridge = { acquire: async () => ({ lease: 'lease', partition: 'persist:first' }), release: async () => {}, onOpenRequested: () => () => {} } as unknown as DesktopBrowserBridge
      const frame = new ElectronWebViewImpl({ initial: undefined, persist() {}, openRequested() {} }, bridge, async () => 'workspace', presentation, `session-${firstOwner}`, capture)
      frame.attach()
      frame.loadUrl({ kind: 'https', url: intent.capture.url, title: '' })
      dispose = () => frame.dispose()
    }
    await vi.waitFor(() => expect(queue.list({ sessionId: nextOwner }).deliveries).toHaveLength(1))
    expect(service.list({ sessionId: firstOwner })).toEqual([])
    expect(service.list({ sessionId: nextOwner })).toHaveLength(1)
    expect(openWorkspace).toHaveBeenCalledTimes(surface === 'web' ? 1 : 0)
    await runtime.pollOnce()
    expect(renderToStaticMarkup(bind() as ReturnType<typeof createElement>)).toContain('data-cards="1"')
    const content = runtime.submission.buildContent({ sessionId: selected!, uploaded: [], text: '', requestId: 'first-send' })
    expect(JSON.stringify(content)).toContain('selected words')
    await runtime.submission.commit(selected!, 'first-send')
    expect(runtime.cards()).toHaveLength(0)
    expect(runtime.draftState(nextOwner).sent).toHaveLength(1)
  } finally {
    lifetime.abort(); await dispose(); runtime.dispose(); queue.dispose()
    for (const stop of disposers.reverse()) stop()
  }
})
