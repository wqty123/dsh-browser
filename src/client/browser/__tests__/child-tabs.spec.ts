// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createIframePage } from '../../pages.ts'
import { dispatchChildTab } from '../child-tabs.ts'
import { ElectronWebViewImpl } from '../../electron/ElectronWebViewImpl.ts'
import type { ElectronWebviewPresentation, WebviewElement } from '../../electron/ElectronWebviewPresentation.ts'
import type { DesktopBrowserBridge, DesktopBrowserChildTabs, DesktopBrowserLeaseId } from '../../../types.ts'

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren() })

it('dispatches only explicit URL-only HTTP(S) requests, never native children or an unavailable guest', () => {
  const open = vi.fn()
  expect(dispatchChildTab({ mode: 'url-only', url: 'https://example.test/path' }, location.origin, open)).toEqual({ status: 'url-only-dispatched' })
  expect(open).toHaveBeenCalledExactlyOnceWith('https://example.test/path')
  for (const url of ['', 'example.test', 'about:blank', 'javascript:alert(1)', 'file:///private', location.origin, 'https://user:secret@example.test/']) {
    expect(dispatchChildTab({ mode: 'url-only', url }, location.origin, open)).toEqual({ status: 'unsupported', code: 'invalid-child-url' })
  }
  expect(dispatchChildTab({ mode: 'native-opener', url: 'https://example.test' }, location.origin, open)).toEqual({ status: 'unsupported', code: 'BROWSER_NATIVE_CHILD_UNAVAILABLE' })
  expect(dispatchChildTab({ mode: 'url-only', url: 'https://example.test' }, location.origin, open, false)).toEqual({ status: 'unsupported', code: 'guest-disposed' })
  expect(open).toHaveBeenCalledTimes(1)
  expect(dispatchChildTab({ mode: 'url-only', url: 'https://example.test' }, location.origin, () => { throw new Error('disposed sidebar') })).toEqual({ status: 'unsupported', code: 'sidebar-tab-dispatch-failed' })
})

it.each([true, false])('binds Desktop child requests to the guest lifetime (structured: %s)', async structured => {
  const open = vi.fn(), stop = vi.fn(), load = vi.fn(async () => {})
  let requested!: Parameters<DesktopBrowserChildTabs['onRequested']>[1]
  let legacy!: (url: string) => void
  const onRequested = vi.fn((_lease, listener) => { requested = listener; return stop })
  const onOpenRequested = vi.fn((_lease, listener) => { legacy = listener; return stop })
  const bridge: DesktopBrowserBridge = {
    acquire: async () => ({ lease: 'child-lease' as DesktopBrowserLeaseId, partition: 'persist:test' }),
    release: vi.fn(async () => {}), onOpenRequested,
    ...(structured ? { childTabs: { protocolVersion: 1 as const, onRequested } } : {}),
  }
  const element = Object.assign(document.createElement('div'), { loadURL: load }) as unknown as WebviewElement
  const presentation = { createElement: () => element, present() {}, clear() {}, dispose() {} } as unknown as ElectronWebviewPresentation
  const frame = new ElectronWebViewImpl({ initial: undefined, persist() {}, openRequested: open }, bridge, async () => 'workspace', presentation, 'conversation')
  frame.loadUrl({ kind: 'https', url: 'https://example.test/source', title: 'Source' })
  frame.attach()
  await vi.waitFor(() => expect(structured ? onRequested : onOpenRequested).toHaveBeenCalledOnce())
  if (structured) {
    expect(onOpenRequested).not.toHaveBeenCalled()
    expect(requested({ mode: 'native-opener', url: 'https://example.test/child' })).toEqual({ status: 'unsupported', code: 'BROWSER_NATIVE_CHILD_UNAVAILABLE' })
    expect(frame.getSnapshot().error?.description).toBe('BROWSER_NATIVE_CHILD_UNAVAILABLE')
    expect(open).not.toHaveBeenCalled()
    expect(requested({ mode: 'url-only', url: 'https://example.test/child' })).toEqual({ status: 'url-only-dispatched' })
  } else legacy('https://example.test/child')
  expect(open).toHaveBeenCalledExactlyOnceWith('https://example.test/child')
  expect(load).not.toHaveBeenCalled()
  expect(frame.getSnapshot().target?.url).toBe('https://example.test/source')
  await frame.dispose()
  expect(stop).toHaveBeenCalledOnce()
  if (structured) expect(requested({ mode: 'url-only', url: 'https://example.test/late' })).toEqual({ status: 'unsupported', code: 'guest-disposed' })
  else legacy('https://example.test/late')
  expect(open).toHaveBeenCalledTimes(1)
})

it('authenticates Web URL-only tab requests and exposes unsupported opener errors without navigating the current page', async () => {
  const open = vi.fn()
  const page = createIframePage({ initial: undefined, persist() {}, openRequested: open })
  const host = document.createElement('div'); host.id = 'child-tabs'; document.body.append(host)
  page.frame.loadUrl({ kind: 'https', url: 'https://example.test/source', title: 'Source' })
  page.presentation.mount(host.id)
  const frame = host.querySelector('iframe')!
  const post = vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
  frame.dispatchEvent(new Event('load'))
  const loadId = post.mock.calls.at(-1)![0].loadId
  const emit = (data: object, source = frame.contentWindow, origin = 'null') => window.dispatchEvent(new MessageEvent('message', { source, origin,
    data: { type: 'dsh.browser.guest.child.request', loadId, requestId: 1, mode: 'url-only', url: 'https://example.test/child', ...data } }))
  emit({}, window)
  emit({}, frame.contentWindow, location.origin)
  emit({ loadId: loadId + 1 })
  expect(open).not.toHaveBeenCalled()
  emit({})
  emit({})
  expect(open).toHaveBeenCalledExactlyOnceWith('https://example.test/child')
  emit({ requestId: 2, mode: 'native-opener' })
  expect(page.frame.getSnapshot().error?.description).toBe('BROWSER_NATIVE_CHILD_UNAVAILABLE')
  expect(page.frame.getSnapshot().target?.url).toBe('https://example.test/source')
  expect(host.querySelector('iframe')).toBe(frame)
  await page.frame.dispose()
  emit({ requestId: 3 })
  expect(open).toHaveBeenCalledTimes(1)
})
