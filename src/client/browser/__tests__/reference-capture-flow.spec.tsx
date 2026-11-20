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
import { ReferenceCapsules } from '../../reference/client/production/ReferenceCapsules.tsx'
import { referenceLabels } from '../../reference/client/production/reference-labels.ts'
import { fakeHostInput, memoryKV } from '../../reference/client/__tests__/production.fixtures.ts'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function harness() {
  const directory = mkdtempSync(join(homedir(), '.dsh-reference-flow-'))
  directories.push(directory)
  const service = new BrowserReferenceService({
    exists: () => false,
    evaluate: async () => { throw new Error('a frozen sidebar capture must not evaluate the selected external carrier') },
  }, new ReferenceStore(join(directory, 'references.jsonl')), { assetDir: join(directory, 'assets') })
  const queue = createDeliveryQueue({ path: join(directory, 'deliveries.jsonl') })
  const handlers = createReferenceRouteHandlers({ service, queue, carrier: () => 'edge' })
  const request = vi.fn(async (input: string, init?: { method?: string; body?: unknown }) => {
    const url = new URL(input, 'http://127.0.0.1:3080')
    const route = url.pathname.split('/').slice(3).join('/')
    const handler = ({ capture: handlers.capture, list: handlers.list, deliveries: handlers.deliveries, 'delivery/ack': handlers.ack })[route]
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
    http: createReferenceHttpClient({ request }), storage: memoryKV(), initialSessionId: 'owner-B', hostInputFor: () => input,
  })
  return { service, queue, request, runtime, input }
}

const intent = {
  type: 'dsh-browser-ref:intent', entry: 'page-overlay', origin: 'user-selection', sessionId: 'untrusted',
  capture: { ok: true, url: 'https://example.test/article', title: 'Frozen article', events: [
    { kind: 'text', exact: 'selected words', prefix: '', suffix: '' },
  ] },
}

it.each(['native', 'web'] as const)('%s overlay intent reaches its owning composer through the real capture, store and delivery handlers', async surface => {
  const { service, queue, request, runtime, input } = harness()
  await service.capture({ sessionId: 'owner-A', frozenCapture: intent.capture })
  let dispose: () => Promise<void>
  if (surface === 'web') {
    const page = createIframePage({ initial: undefined, persist() {}, openRequested() {} }, 'owner-B')
    const host = document.createElement('div')
    host.id = 'capture-flow'
    document.body.append(host)
    page.presentation.mount(host.id)
    page.frame.loadUrl({ kind: 'https', url: intent.capture.url, title: '' })
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
    const frame = new ElectronWebViewImpl({ initial: undefined, persist() {}, openRequested() {} }, bridge, async () => 'workspace', presentation, 'owner-B')
    frame.attach()
    frame.loadUrl({ kind: 'https', url: intent.capture.url, title: '' })
    dispose = () => frame.dispose()
  }
  try {
    await vi.waitFor(() => expect(queue.list({ sessionId: 'owner-B' }).deliveries).toHaveLength(1))
    const posts = request.mock.calls.filter(([url]) => url.endsWith('/capture'))
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]![1]!.body)).sessionId).toBe('owner-B')
    expect(service.list({ sessionId: 'owner-B' })).toHaveLength(1)
    expect(service.list({ sessionId: 'owner-B' })[0]?.source.carrier).toBe('sidebar')
    const report = await runtime.pollOnce()
    expect(report?.outcomes[0]?.outcome.kind).toBe('acknowledged')
    expect(runtime.cards()).toHaveLength(1)
    expect(runtime.draftState('owner-B').groups[0]?.parts[0]).toMatchObject({ kind: 'text', text: 'selected words' })
    expect(input.text).toBe('保留我的问题')
    const capsule = renderToStaticMarkup(createElement(ReferenceCapsules, {
      sessionId: 'owner-B', cards: runtime.cards(), actions: {}, labels: referenceLabels(),
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
