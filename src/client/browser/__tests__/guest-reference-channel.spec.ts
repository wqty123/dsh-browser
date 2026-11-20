// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { receiveGuestReference } from '../../reference-intents.ts'
import { IframePresentation } from '../../view/IframePresentation.ts'

afterEach(() => document.body.replaceChildren())

it('accepts only opaque-origin intents from the owned frame and uses app-owned identity', () => {
  const frame = document.createElement('iframe')
  const foreign = document.createElement('iframe')
  document.body.append(frame, foreign)
  const submit = vi.fn(async () => {})
  const owner = vi.fn(() => 'owned-session')
  const data = { type: 'dsh-browser-ref:intent', comment: 'quote', sessionId: 'forged' }
  const receive = (source: Window | null, origin = 'null', payload: unknown = data) =>
    receiveGuestReference(new MessageEvent('message', { source, origin, data: payload }), [frame], owner, submit)
  receive(foreign.contentWindow)
  receive(null)
  receive(frame.contentWindow, location.origin)
  receive(frame.contentWindow, 'null', { type: 'arbitrary-api-request' })
  expect(submit).not.toHaveBeenCalled()
  receive(frame.contentWindow)
  expect(submit).toHaveBeenCalledWith(data, 'owned-session')
  owner.mockReturnValue('')
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
  const data = { type: 'dsh.browser.guest.navigation', url: 'https://example.test/next', depth: 3 }
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
  expect(presentation.historyDepth()).toBe(3)
  expect(presentation.historyStep(-1)).toBe(true)
  expect(post).toHaveBeenCalledWith({ type: 'dsh.browser.guest.history', delta: -1 }, '*')
  presentation.dispose()
  send(frame.contentWindow)
  expect(loaded).toHaveBeenCalledTimes(1)
  expect(observed).toHaveBeenCalledTimes(1)
  expect(presentation.historyStep(1)).toBe(false)
})
