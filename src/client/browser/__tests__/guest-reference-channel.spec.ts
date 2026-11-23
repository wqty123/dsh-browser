// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { IframePresentation } from '../../view/IframePresentation.ts'

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren() })

it('keeps one storage context across a tab navigation and separates other tabs', () => {
  const contexts: string[] = []
  for (let index = 0; index < 2; index++) {
    const host = document.createElement('div')
    host.id = `storage-context-${index}`
    document.body.append(host)
    const presentation = new IframePresentation({ loaded: vi.fn(), observed: vi.fn(), failed: vi.fn(), remounted: vi.fn() })
    presentation.mount(host.id)
    presentation.show({ target: { kind: 'https', url: 'https://one.example/', title: '' }, revision: 1, sandboxed: true })
    const context = new URL(host.querySelector('iframe')!.src).searchParams.get('storage-context')!
    expect(context).toBeTruthy()
    contexts.push(context)
    presentation.show({ target: { kind: 'https', url: 'https://two.example/', title: '' }, revision: 2, sandboxed: true })
    expect(new URL(host.querySelector('iframe')!.src).searchParams.get('storage-context')).toBe(context)
    presentation.dispose()
  }
  expect(contexts[0]).not.toBe(contexts[1])
})

it('accepts only opaque-origin reference intents from its own mounted frame', () => {
  const host = document.createElement('div')
  host.id = 'owned-reference'
  document.body.append(host)
  const submit = vi.fn(async () => {})
  const presentation = new IframePresentation({ loaded: vi.fn(), observed: vi.fn(), failed: vi.fn(), remounted: vi.fn(), reference: submit })
  presentation.mount(host.id)
  presentation.show({ target: { kind: 'https', url: 'https://example.test/', title: 'Example' }, revision: 1, sandboxed: true })
  const frame = host.querySelector('iframe')!
  const foreign = document.createElement('iframe')
  document.body.append(foreign)
  const data = { type: 'dsh-browser-ref:intent', comment: 'quote', sessionId: 'forged' }
  const receive = (source: Window | null, origin = 'null', payload: unknown = data) =>
    window.dispatchEvent(new MessageEvent('message', { source, origin, data: payload }))
  receive(foreign.contentWindow)
  receive(null)
  receive(frame.contentWindow, location.origin)
  receive(frame.contentWindow, 'null', { type: 'arbitrary-api-request' })
  expect(submit).not.toHaveBeenCalled()
  receive(frame.contentWindow)
  expect(submit).toHaveBeenCalledWith(data)
  presentation.dispose()
  receive(frame.contentWindow)
  expect(submit).toHaveBeenCalledTimes(1)
})

it('observes navigation and drives history only through the current opaque guest', () => {
  const host = document.createElement('div')
  host.id = 'guest-test'
  document.body.append(host)
  const loaded = vi.fn()
  const observed = vi.fn()
  const presentation = new IframePresentation({ loaded, observed, failed: vi.fn(), remounted: vi.fn() })
  presentation.mount(host.id)
  presentation.show({ target: { kind: 'https', url: 'https://example.test/', title: 'Example' }, revision: 7, sandboxed: true })
  const frame = host.querySelector('iframe')!
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  const data = { type: 'dsh.browser.guest.navigation', url: 'https://example.test/next', depth: history.length, documentId: 'guest-document' }
  const send = (source: Window | null, origin = 'null', payload: unknown = data) =>
    window.dispatchEvent(new MessageEvent('message', { source, origin, data: payload }))
  send(null)
  send(frame.contentWindow, location.origin)
  send(frame.contentWindow, 'null', { ...data, url: 'javascript:alert(1)' })
  expect(loaded).not.toHaveBeenCalled()
  send(frame.contentWindow)
  expect(observed).not.toHaveBeenCalled()
  frame.dispatchEvent(new Event('load'))
  expect(loaded).toHaveBeenCalledWith(7)
  const request = post.mock.calls.at(-1)![0]
  send(frame.contentWindow, 'null', { ...data, loadId: request.loadId })
  expect(observed).toHaveBeenCalledWith(7, data.url)
  expect(presentation.historyDepth()).toBe(1)
  expect(presentation.historyStep(-1)).toBe(false)
  expect(post).not.toHaveBeenCalledWith({ type: 'dsh.browser.guest.history', delta: -1 }, '*')
  send(frame.contentWindow, 'null', { ...data, depth: history.length + 1, loadId: request.loadId })
  expect(presentation.historyDepth()).toBe(2)
  expect(presentation.historyStep(-1)).toBe(true)
  expect(post).toHaveBeenCalledWith({ type: 'dsh.browser.guest.history', delta: -1 }, '*')
  expect(presentation.historyDepth()).toBe(1)
  presentation.dispose()
  send(frame.contentWindow)
  expect(loaded).toHaveBeenCalledTimes(1)
  expect(observed).toHaveBeenCalledTimes(2)
  expect(presentation.historyStep(1)).toBe(false)
})

it.each([undefined, '', 'x'.repeat(101)])('re-requests a missing/invalid identity (%s) and fails explicitly if it stays absent', async documentId => {
  vi.useFakeTimers()
  const host = document.createElement('div'); host.id = 'missing-identity'; document.body.append(host)
  const guestFailed = vi.fn(), guestReady = vi.fn()
  const presentation = new IframePresentation({ loaded: vi.fn(), observed: vi.fn(), failed: vi.fn(), remounted: vi.fn(), guestFailed, guestReady })
  presentation.mount(host.id)
  presentation.show({ target: { kind: 'https', url: 'https://example.test/', title: '' }, revision: 4, sandboxed: true })
  const frame = host.querySelector('iframe')!
  expect(new URL(frame.src).searchParams.get('runtime')).toBe('3')
  expect(new URL(frame.src).searchParams.get('storage-context')).toMatch(/^iframe:[\da-f-]+$/u)
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  frame.dispatchEvent(new Event('load'))
  const loadId = post.mock.calls.at(-1)![0].loadId
  const report = { type: 'dsh.browser.guest.navigation', url: 'https://example.test/', ready: true, documentId, loadId }
  const send = () => window.dispatchEvent(new MessageEvent('message', { origin: 'null', source: frame.contentWindow, data: report }))
  post.mockClear()
  send(); send()
  expect(post).toHaveBeenCalledTimes(1)
  expect(guestReady).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(5000)
  expect(guestFailed).toHaveBeenCalledWith(4, expect.stringContaining('GUEST_DOCUMENT_IDENTITY_UNAVAILABLE'))
  presentation.dispose()
})

it('recovers when the identity handshake supplies a matching report before its deadline', async () => {
  vi.useFakeTimers()
  const host = document.createElement('div'); host.id = 'retry-identity'; document.body.append(host)
  const guestFailed = vi.fn(), guestReady = vi.fn()
  const presentation = new IframePresentation({ loaded: vi.fn(), observed: vi.fn(), failed: vi.fn(), remounted: vi.fn(), guestFailed, guestReady })
  presentation.mount(host.id)
  presentation.show({ target: { kind: 'https', url: 'https://example.test/', title: '' }, revision: 5, sandboxed: true })
  const frame = host.querySelector('iframe')!, post = vi.spyOn(frame.contentWindow!, 'postMessage')
  frame.dispatchEvent(new Event('load'))
  const loadId = post.mock.calls.at(-1)![0].loadId
  const report = { type: 'dsh.browser.guest.navigation', url: 'https://example.test/', ready: true, loadId }
  for (const data of [report, { ...report, documentId: 'recovered-document' }]) {
    window.dispatchEvent(new MessageEvent('message', { origin: 'null', source: frame.contentWindow, data }))
  }
  window.dispatchEvent(new MessageEvent('message', { origin: 'null', source: frame.contentWindow,
    data: { ...report, documentId: 'recovered-document', loadId: post.mock.calls.at(-1)![0].loadId } }))
  await vi.advanceTimersByTimeAsync(5000)
  expect(guestReady).toHaveBeenCalledTimes(1)
  expect(guestFailed).not.toHaveBeenCalled()
  presentation.dispose()
})
