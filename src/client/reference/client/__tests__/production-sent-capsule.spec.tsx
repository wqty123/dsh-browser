// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, type HostContext, type AssemblyConfig } from '../production/assembly.ts'
import { apply as applyClient } from '../plugin.ts'
import type { ProductionRuntime } from '../production/runtime.ts'
import type { RequestLike } from '../production/http-transport.ts'
import { ROUTES, type RevealResultWire } from '../production/protocol.ts'
import { browserSourceRule } from '../production/user-text-rule.ts'
import { UserTextDocument } from '@deepseek-ai/dsh-client-ui-conversation/src/client/conversation/user-text-document.ts'
import { encodeBrowserRefUri } from '../scheme.ts'
import { createBrowserInitializationJournal, createBrowserInitializationReader } from '../../../browser/initialization.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { referenceOwnerKey } from '../../../../reference-owner.ts'
import { BrowserController, type BrowserControllerOptions } from '../../../browser/BrowserController.ts'
import { ElectronWebViewImpl } from '../../../electron/ElectronWebViewImpl.ts'
import { nativeMainReveal } from '../../../../../tests/fixtures/native-main-reveal.mjs'
import type { ElectronWebviewPresentation, WebviewElement } from '../../../electron/ElectronWebviewPresentation.ts'
import {
  ASSET_MAP, LONG_TEXT, TAIL_TEXT, assetOf, deliveriesResponse,
  fakeHostInput, makeDelivery, manualScheduler, memoryKV,
} from './production.fixtures.ts'

const roots: Root[] = []
const cleanups: (() => void | Promise<void>)[] = []
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount()
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  })
  vi.useRealTimers()
  document.body.innerHTML = ''
})

async function assembled(storage = memoryKV(), options: {
  empty?: boolean; client?: boolean; acknowledged?: boolean; hostSessionId?: string; away?: boolean; native?: boolean
} = {}) {
  const hostSessionId = options.hostSessionId ?? 'sess-A'
  const sessionId = referenceOwnerKey(hostSessionId)
  const components = new Map<string, (props?: unknown) => unknown>()
  const services: Record<string, unknown> = {}
  let sourceRule: typeof browserSourceRule | undefined
  services.uiConversation = { userText: { register(rule: typeof browserSourceRule) { sourceRule = rule; return () => {} } } }
  const reveals: { referenceId: string; partId?: string; navigate?: boolean; sourcePageId?: string }[] = []
  let outcome: () => Promise<RevealResultWire> = async () => ({ ok: true, status: 'revealed' })
  let deliveries = options.empty ? [] : [makeDelivery({ sessionId, state: options.acknowledged ? 'acknowledged' : 'prepared', sequence: 1 })]
  const tabs: { id: TabId; kind: string }[] = []
  const listeners = new Set<() => void>()
  const journal = createBrowserInitializationJournal({ onChange: () => { for (const listener of listeners) listener() } })
  const live = { url: 'https://cn.bing.com/', ready: true, highlighted: false }
  let native: { controller: BrowserController; element: WebviewElement } | undefined
  const navigate = vi.fn((id: string, tabId: TabId, url: string) => {
    expect(id).toBe(hostSessionId)
    live.url = url
    live.ready = false
    if (native !== undefined) native.controller.navigate(url, 2)
    else {
      journal.begin({ sessionId: id, tabId, occurrenceId: 'source', navigationRevision: 2, url })
      journal.advance(tabId, 'navigating')
    }
    return true
  })
  if (options.away) {
    tabs.push({ id: 'sent-source' as TabId, kind: 'browser' })
    journal.begin({ sessionId: hostSessionId, tabId: 'sent-source' as TabId, occurrenceId: 'source', navigationRevision: 1, url: live.url })
    journal.advance('sent-source' as TabId, 'attached', { guestId: '42' })
  }
  if (options.native) {
    const element = Object.assign(document.createElement('div'), {
      getURL: () => live.url, getTitle: () => 'Source', getWebContentsId: () => 42,
      isLoading: () => true, canGoBack: () => false, canGoForward: () => false, clearHistory() {},
      executeJavaScript: async (source: string) => source.startsWith('JSON.stringify(') ? '[]' : undefined,
      loadURL: async (url: string) => {
        live.url = url
        live.ready = false
        element.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true, isInPlace: false }))
        element.dispatchEvent(new Event('did-navigate'))
      },
    }) as unknown as WebviewElement
    let frame!: ElectronWebViewImpl
    const presentation = {
      mount: () => { frame.attach(); return () => { frame.detach() } },
      createElement: () => element, present: () => { element.dispatchEvent(new Event('dom-ready')) },
      show() {}, clear() {}, dispose() {},
    } as unknown as ElectronWebviewPresentation
    const controller = new BrowserController({
      sessionId: hostSessionId, tabId: 'sent-source' as TabId, journal, occurrenceId: 'native-source',
      signal: new AbortController().signal, applicationOrigin: location.origin, initial: undefined,
      actions: { replace() {} } as BrowserControllerOptions['actions'], openTab() {},
      createPage: pageOptions => {
        frame = new ElectronWebViewImpl(pageOptions, {
          acquire: async () => ({ lease: 'native-source' as never, partition: 'persist:test' }),
          release: async () => {}, onOpenRequested: () => () => {},
        }, async () => 'workspace', presentation, hostSessionId)
        return { frame, presentation }
      },
    })
    native = { controller, element }
    cleanups.push(() => controller.dispose())
    controller.navigate(live.url, 1)
    controller.mount('native-source')
    await Promise.resolve()
    await Promise.resolve()
    element.dispatchEvent(new Event('dom-ready'))
    live.ready = true
  }
  services.sidebarBrowserInitialization = createBrowserInitializationReader((_session, tab) => journal.get(tab), listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => native !== undefined ? native.controller.currentPage()
    : options.away && live.ready ? { url: live.url, guestId: '42' } : undefined, navigate)
  const openTabIn = vi.fn((sessionId: string, _kind: string, options: { params: { url: string } }) => {
    expect(sessionId).toBe(hostSessionId)
    const tabId = 'sent-source' as TabId
    tabs.push({ id: tabId, kind: 'browser' })
    journal.begin({ sessionId, tabId, occurrenceId: 'source', navigationRevision: 1, url: options.params.url })
    journal.advance(tabId, 'attached', { guestId: '42' })
  })
  services.sidebarRight = { openTabIn, tabsIn: (id: string) => id === hostSessionId ? tabs : [] }
  const request: RequestLike = async (url, init) => {
    const parsed = new URL(url, 'https://dsh.test')
    let body: unknown
    if (parsed.pathname === ROUTES.deliveries) {
      body = deliveriesResponse(deliveries, 1)
      deliveries = []
    } else if (parsed.pathname === ROUTES.asset) {
      const key = parsed.searchParams.get('key')!
      body = assetOf(key, ASSET_MAP[key]!)
    } else if (parsed.pathname === ROUTES.ack) {
      const ack = JSON.parse(init!.body as string)
      body = { ok: true, ...ack, state: ack.phase ?? 'acknowledged' }
    } else if (parsed.pathname === ROUTES.reveal) {
      reveals.push(JSON.parse(init!.body as string))
      body = await outcome()
    } else {
      throw new Error(`unexpected production request: ${url}`)
    }
    return { ok: true, status: 200, json: async () => body, bytes: async () => new Uint8Array() }
  }
  const ctx: HostContext = {
    get: name => services[name],
    set: (name, value) => { services[name] = value },
    effect: fn => { const dispose = fn(); if (dispose) cleanups.push(dispose) },
    slots: {
      inject: (_name, producer) => { [...producer()] },
      register: (registration, component) => {
        components.set((registration as { name: string }).name, component as (props?: unknown) => unknown)
      },
    },
  }
  const hostInput = fakeHostInput('')
  const fetches: { url: string; method?: string; body?: string | Uint8Array; credentials?: RequestCredentials }[] = []
  const config: AssemblyConfig = {
    initialSessionId: sessionId, storage,
    ...(options.native ? { fetchImpl: async (url, init) => {
      fetches.push({ url, ...init })
      const response = await request(url, init)
      return { ...response, arrayBuffer: async () => new ArrayBuffer(0) }
    } } satisfies Pick<AssemblyConfig, 'fetchImpl'> : { request }),
    createElement: createElement as AssemblyConfig['createElement'],
    scheduler: manualScheduler(), hostInputFor: () => hostInput,
  }
  let runtime: ProductionRuntime | undefined
  await act(async () => {
    if (options.client) runtime = applyClient(ctx, config)
    else { runtime = apply(ctx, config); await runtime.pollOnce() }
  })
  return {
    runtime: runtime!, storage, reveals, fetches, openTabIn, navigate, live, hostInput,
    frame: () => native!.controller.getSnapshot().frame,
    initialization: () => native!.controller.initialization(),
    ready() {
      live.ready = true
      if (native !== undefined) native.element.dispatchEvent(new Event('dom-ready'))
      else journal.advance('sent-source' as TabId, 'attached', { guestId: '42' })
    },
    fail() {
      native!.element.dispatchEvent(Object.assign(new Event('did-fail-load'), {
        isMainFrame: true, errorCode: -105, errorDescription: 'name not resolved',
      }))
    },
    outcome(value: RevealResultWire | (() => Promise<RevealResultWire>)) {
      outcome = typeof value === 'function' ? value : async () => value
    },
    async sent(uri = encodeBrowserRefUri({ referenceId: 'ref-mixed-1' })) {
      const component = components.get('conversation.user.text.node')!
      return mount(() => component({ node: { data: { uri, label: '引用来源 3：原文' } } }) as ReactNode)
    },
    async sentMessage(text: string) {
      expect(sourceRule).toBe(browserSourceRule)
      const nodes = new UserTextDocument().evaluate({ text, facts: {} }, [sourceRule!])
      expect(nodes.find(node => node.id === 'browser-ref')).toMatchObject({ data: { uri: encodeBrowserRefUri({ referenceId: 'ref-mixed-1' }) } })
      return mount(() => createElement(Fragment, null, ...nodes.map(node =>
        node.id === 'text' ? node.data.display ?? node.data.text :
          components.get('conversation.user.text.node')!({ node, raw: text.slice(node.start, node.end) }) as ReactNode)))
    },
    async composer() {
      return mount(() => components.get('conversation.input.dock')!({ sessionId: hostSessionId }) as ReactNode)
    },
  }
}

async function mount(component: () => ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(createElement(component)) })
  return container
}

async function send(runtime: ProductionRuntime, text = 'question'): Promise<string> {
  runtime.setComment('ref-mixed-1', 'My frozen-source comment')
  const content = runtime.submission.buildContent({ sessionId: runtime.currentSessionId(), uploaded: [], text, requestId: 'send-1' })
  await runtime.submission.commit(runtime.currentSessionId(), 'send-1')
  expect(runtime.cards()).toHaveLength(0)
  return content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
}

function pill(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-reference-id]')!
}

describe('production assembly — shared composer and sent capsules', () => {
  it('projects an inserted composer source token into exactly one sent capsule', async () => {
    const h = await assembled(undefined, { acknowledged: true })
    expect(h.hostInput.text).toContain('dsh-browser-ref:')
    const message = await send(h.runtime, h.hostInput.text)
    expect(message.match(/dsh-browser-ref:/gu)).toHaveLength(1)
    const sent = await h.sentMessage(message)
    expect(sent.querySelectorAll('button[data-reference-id="ref-mixed-1"]')).toHaveLength(1)
    const textOnly = sent.cloneNode(true) as HTMLElement
    textOnly.querySelector('.dsh-browser-reference-capsules')!.remove()
    expect(textOnly.textContent?.trim()).toBe('')
    await act(async () => { pill(sent).focus() })
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    h.runtime.dispose()
  })

  it('renders the complete submitted message as one capsule plus user text, keeping the full quote for the model', async () => {
    const h = await assembled()
    const message = await send(h.runtime, 'my own question')
    expect(message).toContain(LONG_TEXT)
    expect(message).toContain(TAIL_TEXT)
    expect(message).toContain('My frozen-source comment')
    const sent = await h.sentMessage(message)
    expect(sent.querySelectorAll('button[data-reference-id]')).toHaveLength(1)
    const textOnly = sent.cloneNode(true) as HTMLElement
    textOnly.querySelector('.dsh-browser-reference-capsules')!.remove()
    expect(textOnly.textContent?.trim()).toBe('my own question')
    await act(async () => { pill(sent).focus() })
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(LONG_TEXT)
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('My frozen-source comment')
  })

  it('keeps a sent capsule, with ordered snapshot parts + comment on hover after durable reload', async () => {
    const first = await assembled()
    const before = first.runtime.referenceDetail('ref-mixed-1')!
    expect(before.snapshot.parts[0]).toMatchObject({ type: 'text', text: LONG_TEXT })
    const composer = await first.composer()
    expect(pill(composer)).not.toBeNull()
    const message = await send(first.runtime)
    expect(first.runtime.draftState().sent).toHaveLength(1)
    first.runtime.dispose()

    const restored = await assembled(first.storage, { empty: true })
    const detail = restored.runtime.referenceDetail('ref-mixed-1')!
    expect(detail.snapshot).toEqual(before.snapshot)
    expect(detail.comment).toBe('My frozen-source comment')
    const sent = await restored.sentMessage(message)
    const button = pill(sent)
    expect(sent.querySelector('.dsh-browser-reference-capsules')).not.toBeNull()
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.querySelector('[data-chip-remove]')).toBeNull()
    expect(button.getAttribute('data-index')).toBe('1')
    await act(async () => { button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const panel = document.querySelector('[role="dialog"]')!
    expect([...panel.querySelectorAll('[data-part-kind]')].map(node => node.getAttribute('data-part-kind')))
      .toEqual(['text', 'image', 'table', 'image', 'text'])
    expect(panel.querySelector('[data-part-kind="text"]')!.textContent).toBe(LONG_TEXT)
    expect(panel.textContent).toContain(TAIL_TEXT)
    expect(panel.textContent).toContain('My frozen-source comment')
    expect(panel.querySelector('img')!.src).toMatch(/^data:image\/png;base64,/u)
    expect(panel.querySelector('th[colspan="2"]')).not.toBeNull()
    expect(panel.querySelector('td[rowspan="2"]')).not.toBeNull()
  })

  it('shows the same quoted content on keyboard focus in the composer and sent message', async () => {
    const app = await assembled()
    const composer = await app.composer()
    await act(async () => { pill(composer).focus() })
    const content = [...document.querySelectorAll('[role="dialog"] [data-part-kind]')].map(node => node.textContent)
    expect(content[0]).toBe(LONG_TEXT)
    await act(async () => { roots.pop()!.unmount() })
    await send(app.runtime)
    const sent = await app.sent()
    vi.spyOn(pill(sent), 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, bottom: 46, width: 100, height: 26 } as DOMRect)
    await act(async () => { pill(sent).focus() })
    expect((document.querySelector('[role="dialog"]') as HTMLElement).style.top).toBe('54px')
    expect([...document.querySelectorAll('[role="dialog"] [data-part-kind]')].map(node => node.textContent)).toEqual(content)
  })

  it('resolves the snapshot and comment during a pending archive write, without resurrecting the draft', async () => {
    const storage = memoryKV()
    const write = storage.setItem.bind(storage)
    storage.setItem = (key, value) => {
      const record = JSON.parse(value)
      if (Array.isArray(record.sent) && record.sent.length > 0) throw new Error('archive quota exceeded')
      write(key, value)
    }
    const app = await assembled(storage)
    const snapshot = app.runtime.referenceDetail('ref-mixed-1')!.snapshot
    await send(app.runtime)
    expect(app.runtime.draftState().pendingArchive).toHaveLength(1)
    expect(app.runtime.draftState().sent).toHaveLength(0)
    const detail = app.runtime.referenceDetail('ref-mixed-1')!
    expect(detail.snapshot).toEqual(snapshot)
    expect(detail.comment).toBe('My frozen-source comment')
    const sent = await app.sent()
    await act(async () => { pill(sent).focus() })
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('My frozen-source comment')
  })

  it('sent-capsule activation navigates a changed page, preserving a part-specific URI', async () => {
    const app = await assembled()
    await send(app.runtime)
    app.outcome(async () => ({ ok: true, status: app.reveals.at(-1)?.sourcePageId ? 'revealed' : 'page-mismatch' }))
    app.runtime.setSourceOpener(async () => ({ pageId: '42' }))
    const sent = await app.sent(encodeBrowserRefUri({ referenceId: 'ref-mixed-1', partId: 'tb-1' }))
    await act(async () => { pill(sent).click() })
    expect(app.reveals).toEqual([
      { referenceId: 'ref-mixed-1', partId: 'tb-1' },
      { referenceId: 'ref-mixed-1', partId: 'tb-1', sourcePageId: '42' },
    ])
    expect(app.openTabIn).not.toHaveBeenCalled()
    expect(app.runtime.snapshot().reveal).toBeUndefined()
  })

  it('the client assembly opens the sidebar for a sent capsule with no live session, then awaits reveal', async () => {
    const first = await assembled()
    const sourceUrl = first.runtime.cards()[0]!.source.pageUrl
    await send(first.runtime)
    first.runtime.dispose()
    const app = await assembled(first.storage, { empty: true, client: true })
    app.outcome(async () => ({ ok: true, status: app.reveals.at(-1)?.sourcePageId ? 'revealed' : 'session-unavailable' }))
    const sent = await app.sent()
    await act(async () => { pill(sent).click() })
    expect(app.openTabIn).toHaveBeenCalledExactlyOnceWith('sess-A', 'browser', { params: { url: sourceUrl } })
    expect(app.reveals).toHaveLength(2)
  })

  it.each([
    ['chip', '79b4e5bd-5bf4-49f3-b911-5d1a92b7002b'],
    ['dialog', '79b4e5bd-5bf4-49f3-b911-5d1a92b7002b'],
    ['chip', 'session-79b4e5bd-5bf4-49f3-b911-5d1a92b7002b'],
    ['dialog', 'session-79b4e5bd-5bf4-49f3-b911-5d1a92b7002b'],
  ])('recovers a native sent %s after session-unavailable using the exact host Session %s', async (activation, hostSessionId) => {
    const first = await assembled(undefined, { hostSessionId })
    const sourceUrl = first.runtime.cards()[0]!.source.pageUrl
    await send(first.runtime)
    first.runtime.dispose()
    const app = await assembled(first.storage, { empty: true, client: true, away: true, hostSessionId })
    await app.composer()
    app.outcome(async () => {
      if (!app.reveals.at(-1)?.sourcePageId) return { ok: true, status: 'session-unavailable', pageUrl: sourceUrl }
      expect(app.live.ready).toBe(true)
      app.live.highlighted = true
      return { ok: true, status: 'revealed' }
    })
    const sent = await app.sent()
    if (activation === 'dialog') await act(async () => { pill(sent).focus() })
    await act(async () => {
      if (activation === 'chip') pill(sent).click()
      else document.querySelector<HTMLButtonElement>(`[role="dialog"] button[title="${sourceUrl}"]`)!.click()
    })
    expect(app.navigate).toHaveBeenCalledExactlyOnceWith(hostSessionId, 'sent-source', sourceUrl)
    expect(app.openTabIn).not.toHaveBeenCalled()
    expect(app.live).toEqual({ url: sourceUrl, ready: false, highlighted: false })
    expect(app.reveals).toEqual([{ referenceId: 'ref-mixed-1' }])
    await act(async () => { app.ready() })
    expect(app.reveals).toEqual([
      { referenceId: 'ref-mixed-1' },
      { referenceId: 'ref-mixed-1', sourcePageId: '42' },
    ])
    expect(app.live.highlighted).toBe(true)
    expect(app.runtime.snapshot().reveal).toBeUndefined()
  })

  it.each(['chip', 'dialog'])('completes native %s reveal through the Desktop main extension and bridge at DOM-ready', async activation => {
    const first = await assembled()
    const sourceUrl = first.runtime.cards()[0]!.source.pageUrl
    await send(first.runtime)
    first.runtime.dispose()
    const app = await assembled(first.storage, { client: true, away: true, native: true })
    const backend = await nativeMainReveal(app.runtime.referenceDetail('ref-mixed-1')!.snapshot, app.live, 42)
    cleanups.push(() => backend.close())
    await backend.start()
    app.outcome(async () => {
      return backend.post(app.reveals.at(-1)!)
    })
    const sent = await app.sent()
    if (activation === 'dialog') await act(async () => { pill(sent).focus() })
    const click = (): void => {
      if (activation === 'chip') pill(sent).click()
      else document.querySelector<HTMLButtonElement>(`[role="dialog"] button[title="${sourceUrl}"]`)!.click()
    }
    await act(async () => { click(); click() })
    expect(app.navigate).toHaveBeenCalledOnce()
    expect(app.reveals).toEqual([{ referenceId: 'ref-mixed-1' }])
    expect(app.live).toEqual({ url: sourceUrl, ready: false, highlighted: false })
    await act(async () => {
      app.ready()
      await vi.waitFor(() => { expect(backend.outcomes).toHaveLength(2) })
    })
    expect(app.frame()).toMatchObject({ loading: true, documentReady: true, address: 'observed' })
    expect(app.initialization()).toMatchObject({ stage: 'attached', guestId: '42', requestId: app.frame().navigationId })
    expect(app.reveals).toEqual([{ referenceId: 'ref-mixed-1' }, { referenceId: 'ref-mixed-1', sourcePageId: '42' }])
    expect(app.fetches.filter(request => request.url.endsWith('/reference/reveal'))).toEqual([
      expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ referenceId: 'ref-mixed-1' }) }),
      expect.objectContaining({ method: 'POST', credentials: 'include', body: JSON.stringify({ referenceId: 'ref-mixed-1', sourcePageId: '42' }) }),
    ])
    expect(backend.outcomes.map(outcome => outcome.status), JSON.stringify(backend.outcomes)).toEqual(['session-unavailable', 'revealed'])
    expect(app.live.highlighted).toBe(true)
    expect(backend.commands).toHaveLength(3)
    expect(app.openTabIn).not.toHaveBeenCalled()
    await act(async () => {
      click()
      await vi.waitFor(() => { expect(backend.outcomes).toHaveLength(4) })
    })
    expect(app.reveals).toHaveLength(4)
    expect(app.navigate).toHaveBeenCalledOnce()
  })

  it('does not highlight a failed native navigation, and allows a fresh activation to retry', async () => {
    const first = await assembled()
    await send(first.runtime)
    first.runtime.dispose()
    const app = await assembled(first.storage, { client: true, away: true, native: true })
    app.outcome(async () => ({ ok: true, status: 'session-unavailable' }))
    const sent = await app.sent()
    await act(async () => { pill(sent).click() })
    expect(app.reveals).toHaveLength(1)
    await act(async () => { app.fail(); app.ready() })
    expect(app.reveals).toHaveLength(1)
    expect(app.live.highlighted).toBe(false)
    expect(app.runtime.snapshot().reveal?.status).toBe('session-unavailable')
    await act(async () => { pill(sent).click() })
    expect(app.reveals).toHaveLength(2)
    expect(app.navigate).toHaveBeenCalledTimes(2)
  })

  it('uses the shared hover panel and orchestration for the anchor fallback and Enter activation', async () => {
    const app = await assembled()
    await send(app.runtime)
    app.outcome(async () => ({ ok: true, status: app.reveals.at(-1)?.sourcePageId ? 'revealed' : 'page-mismatch' }))
    app.runtime.setSourceOpener(async () => ({ pageId: '42' }))
    const anchor = document.createElement('a')
    anchor.href = encodeBrowserRefUri({ referenceId: 'ref-mixed-1' })
    anchor.textContent = '引用来源 1：原文'
    document.body.append(anchor)
    await act(async () => { anchor.focus() })
    expect(document.querySelector('[role="dialog"] [data-part-kind="table"]')).not.toBeNull()
    const keyboard = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => { anchor.dispatchEvent(keyboard) })
    expect(keyboard.defaultPrevented).toBe(true)
    expect(app.reveals.map(request => request.sourcePageId)).toEqual([undefined, '42'])
    await act(async () => { anchor.remove() })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('refuses missing and cross-session references without opening a tab or contacting reveal', async () => {
    const app = await assembled()
    await send(app.runtime)
    const missing = await app.sent(encodeBrowserRefUri({ referenceId: 'missing' }))
    await act(async () => { missing.querySelector('button')!.click() })
    expect(app.runtime.referenceDetail('missing')).toBeUndefined()
    expect(app.runtime.snapshot().reveal?.status).toBe('unknown-reference')
    app.runtime.setSession('sess-B')
    const foreign = await app.sent()
    expect(foreign.querySelector('[data-reference-id]')).toBeNull()
    await act(async () => { foreign.querySelector('button')!.click() })
    expect(app.runtime.snapshot().reveal?.status).toBe('session-mismatch')
    expect(app.reveals).toHaveLength(0)
    expect(app.openTabIn).not.toHaveBeenCalled()
  })

  it('never calls a tab-open request or an unacknowledged reply a successful reveal', async () => {
    const app = await assembled()
    await send(app.runtime)
    app.outcome({ ok: true, status: 'session-unavailable' })
    app.runtime.setSourceOpener(async () => { throw new Error('readiness not acknowledged') })
    vi.useFakeTimers()
    const activation = app.runtime.activateUri(encodeBrowserRefUri({ referenceId: 'ref-mixed-1' }))
    await vi.runAllTimersAsync()
    expect(await activation).toBe('session-unavailable')
    expect(app.runtime.snapshot().reveal?.status).not.toBe('revealed')
    app.outcome({ ok: true })
    expect(await app.runtime.revealReference('ref-mixed-1')).toBe('unavailable')
  })

  it('does not resume a pending sidebar reveal after switching conversations', async () => {
    const app = await assembled()
    await send(app.runtime)
    app.outcome({ ok: true, status: 'session-unavailable' })
    let opened!: () => void
    let resume!: () => void
    const opening = new Promise<void>(resolve => { opened = resolve })
    const pending = new Promise<void>(resolve => { resume = resolve })
    app.runtime.setSourceOpener(async () => { opened(); await pending; return { pageId: '42' } })
    const activation = app.runtime.revealReference('ref-mixed-1')
    await opening
    app.runtime.setSession('sess-B')
    resume()
    expect(await activation).toBe('superseded')
    expect(app.reveals).toHaveLength(1)
    expect(app.runtime.snapshot().reveal).toBeUndefined()
  })
})
