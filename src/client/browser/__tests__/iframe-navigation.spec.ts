// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserNavigation } from '../BrowserNavigation.ts'
import { IframeImpl } from '../IframeImpl.ts'
import type { IframePresentation } from '../../view/IframePresentation.ts'
import { createIframePage } from '../../pages.ts'
import { parseBrowserAddress } from '../url.ts'

vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore<T>(initial: T) {
    let value = initial
    const listeners = new Set<() => void>()
    return { getSnapshot: () => value, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      set: (next: T) => { value = next; for (const listener of listeners) listener() } }
  },
}))

afterEach(() => { document.body.replaceChildren() })
function target(url: string) {
  const parsed = parseBrowserAddress(url)
  if (!parsed.ok) throw new Error('invalid test target')
  return parsed.target
}

describe('iframe navigation and presentation assembly', () => {
  it('records a first observed page even from the empty navigation variant', () => {
    const navigation = new BrowserNavigation()
    navigation.recordObserved(target('https://example.com/one'))
    expect(navigation.snapshot.navigation).toEqual({ status: 'known', revision: 0 })
    const request = navigation.navigate(target('https://example.com/two'))
    navigation.frameLoaded(request.revision)
    navigation.recordObserved(target('https://example.com/three'))
    expect(navigation.snapshot.navigation).toEqual({ status: 'known', revision: request.revision })
  })

  it('publishes native-history forward availability and clears it on forward or a new document', () => {
    const presentation = { historyStep: vi.fn(() => true), historyDepth: () => 2, show: vi.fn(), dispose: vi.fn() }
    const frame = new IframeImpl({ initial: undefined, persist: () => {}, openRequested: () => {} }, presentation as unknown as IframePresentation)
    expect(frame.getSnapshot().canGoForward).toBe(false)
    frame.goBack()
    expect(presentation.historyStep).toHaveBeenCalledWith(-1)
    expect(frame.getSnapshot().canGoForward).toBe(true)
    frame.goForward()
    expect(frame.getSnapshot().canGoForward).toBe(false)
    presentation.historyStep.mockReturnValue(false)
    frame.goBack()
    expect(frame.getSnapshot().canGoForward).toBe(false)
    presentation.historyStep.mockReturnValue(true)
    frame.goBack()
    frame.loadUrl(target('https://example.com/'))
    expect(frame.getSnapshot().canGoForward).toBe(false)
  })

  it('assembles the actual Web provider and CSS-backed presentation without a fictitious event', async () => {
    const page = createIframePage({ initial: undefined, persist: () => {}, openRequested: () => {} })
    const host = document.createElement('div')
    host.id = 'browser-viewport'
    document.body.append(host)
    const unmount = page.presentation.mount(host.id)
    page.frame.loadUrl(target('https://example.com/'))
    const iframe = host.querySelector('iframe')!
    expect(iframe.className).not.toBe('')
    expect(iframe.sandbox?.contains('allow-popups') ?? iframe.getAttribute('sandbox')!.includes('allow-popups')).toBe(false)
    unmount()
    await page.frame.dispose()
  })

  it.each(['before', 'after'])('completes only on native load when the guest report arrives %s it', async order => {
    const page = createIframePage({ initial: undefined, persist: () => {}, openRequested: () => {} })
    const host = document.createElement('div')
    host.id = 'authoritative-navigation'
    document.body.append(host)
    const unmount = page.presentation.mount(host.id)
    page.frame.loadUrl(target('https://example.com/'))
    const frame = host.querySelector('iframe')!
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    const report = (url: string, depth: number) => window.dispatchEvent(new MessageEvent('message', {
      origin: 'null', source: frame.contentWindow,
      data: { type: 'dsh.browser.guest.navigation', url, depth, loadId: post.mock.calls.at(-1)?.[0].loadId },
    }))
    if (order === 'after') frame.dispatchEvent(new Event('load'))
    report('https://example.com/', 1)
    expect(page.frame.getSnapshot().loading).toBe(order === 'before')
    if (order === 'before') frame.dispatchEvent(new Event('load'))
    report('https://example.com/', 1)
    expect(page.frame.getSnapshot().loading).toBe(false)
    expect(page.frame.getSnapshot().canGoBack).toBe(false)
    frame.dispatchEvent(new Event('load'))
    report('https://example.com/next', 2)
    report('https://example.com/next', 2)
    expect(page.frame.getSnapshot().canGoBack).toBe(true)
    page.frame.goBack()
    expect(page.frame.getSnapshot().target?.url).toBe('https://example.com/')
    unmount()
    await page.frame.dispose()
  })

  it.each(['text/plain', 'application/json', 'image/png', 'application/pdf', 'proxy error'])('completes %s without a runtime report and retains application Back', async kind => {
    const page = createIframePage({ initial: undefined, persist: () => {}, openRequested: () => {} })
    const host = document.createElement('div')
    host.id = 'non-html'
    document.body.append(host)
    page.presentation.mount(host.id)
    expect(page.frame.getSnapshot().loading).toBe(false)
    expect(host.querySelector('iframe')).toBeNull()
    page.frame.loadUrl(target('https://example.com/first'))
    host.querySelector('iframe')!.dispatchEvent(new Event('load'))
    page.frame.loadUrl(target(`https://example.com/${encodeURIComponent(kind)}`))
    expect(page.frame.getSnapshot().loading).toBe(true)
    host.querySelector('iframe')!.dispatchEvent(new Event('load'))
    expect(page.frame.getSnapshot().loading).toBe(false)
    expect(page.frame.getSnapshot().canGoBack).toBe(true)
    page.frame.goBack()
    expect(page.frame.getSnapshot().target?.url).toBe('https://example.com/first')
    await page.frame.dispose()
  })

  it('invalidates the old address on HTML-to-text navigation and rejects old load metadata', async () => {
    const page = createIframePage({ initial: undefined, persist: () => {}, openRequested: () => {} })
    const host = document.createElement('div')
    host.id = 'metadata'
    document.body.append(host)
    page.presentation.mount(host.id)
    page.frame.loadUrl(target('https://example.com/'))
    const frame = host.querySelector('iframe')!
    const post = vi.spyOn(frame.contentWindow!, 'postMessage')
    const report = (loadId: number) => window.dispatchEvent(new MessageEvent('message', {
      origin: 'null', source: frame.contentWindow,
      data: { type: 'dsh.browser.guest.navigation', url: 'https://example.com/', depth: 1, loadId },
    }))
    frame.dispatchEvent(new Event('load'))
    const first = post.mock.calls.at(-1)![0].loadId
    report(first)
    frame.dispatchEvent(new Event('load'))
    expect(page.frame.getSnapshot().loading).toBe(false)
    expect(page.frame.getSnapshot().address).toBe('unknown')
    report(first)
    expect(page.frame.getSnapshot().address).toBe('unknown')
    report(post.mock.calls.at(-1)![0].loadId)
    expect(page.frame.getSnapshot().address).toBe('requested')
    expect(page.frame.getSnapshot().canGoBack).toBe(false)
    page.frame.loadUrl(target('https://example.com/new'))
    frame.dispatchEvent(new Event('load'))
    report(first)
    expect(page.frame.getSnapshot().loading).toBe(true)
    expect(page.frame.getSnapshot().target?.url).toBe('https://example.com/new')
    await page.frame.dispose()
  })
})
