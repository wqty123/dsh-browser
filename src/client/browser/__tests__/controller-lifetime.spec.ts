import { describe, expect, it } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createBrowserControllers, type BrowserControllerOptions } from '../BrowserController.ts'
import { emptyBrowserFrame } from '../BrowserFrame.ts'
import { createBrowserInitializationJournal, type BrowserInitializationJournal } from '../initialization.ts'

const tabId = 'lifetime-tab' as TabId
const sessionId = 'session-owner'
const root = globalThis as typeof globalThis & { __DSH_BROWSER_INIT_JOURNALS__?: BrowserInitializationJournal[] }
const registered = () => root.__DSH_BROWSER_INIT_JOURNALS__ ?? []

function controllers(options: Parameters<typeof createBrowserControllers>[4] = {}, failDisposal = false) {
  const frame = createSnapshotStore(emptyBrowserFrame())
  return createBrowserControllers({ replace() {} } as BrowserControllerOptions['actions'], () => ({
    frame: { ...frame, loadUrl() {}, goBack() {}, goForward() {}, reload() {}, async dispose() {
      if (failDisposal) throw new Error('page disposal failed')
    } },
    presentation: { mount: () => () => {} },
  }), () => true, undefined, { sessionId, ...options })
}

function mount(facade: ReturnType<typeof controllers>, aborted = false) {
  const lifetime = new AbortController()
  if (aborted) lifetime.abort()
  facade.mount({ tabId, signal: lifetime.signal, viewportId: 'viewport', applicationOrigin: 'https://dsh.test',
    initial: undefined, initialUrl: undefined, openTab() {} })
}

describe('controller journal ownership', () => {
  it('acknowledges a native adoption without replaying its URL through loadUrl', async () => {
    const frame = createSnapshotStore(emptyBrowserFrame())
    const navigated: string[] = [], acknowledged: string[] = []
    const facade = createBrowserControllers({ replace() {} } as BrowserControllerOptions['actions'], () => ({
      frame: { ...frame, loadUrl(target) { navigated.push(target.url) }, goBack() {}, goForward() {}, reload() {}, async dispose() {} },
      presentation: { mount: () => () => {} },
      adoption: { url: 'https://example.test/native-child', acknowledge: id => { acknowledged.push(id) } },
    }), () => true, undefined, { sessionId })
    try {
      mount(facade)
      expect(navigated).toEqual([])
      expect(acknowledged).toHaveLength(1)
      expect(facade.initializationLog().some(entry => entry.url === 'https://example.test/native-child')).toBe(true)
    } finally { await facade.dispose() }
  })
  it('releases its owned history and diagnostic registration on every plugin lifetime', async () => {
    const count = registered().length
    for (let reload = 0; reload < 3; reload++) {
      let changes = 0
      const facade = controllers({ onInitializationChange: () => { changes++ } })
      mount(facade, true)
      expect(changes).toBe(1)
      expect(facade.initializationLog()).toHaveLength(1)
      expect(registered()).toHaveLength(count + 1)
      await facade.dispose()
      await facade.dispose()
      expect(facade.initializationLog()).toEqual([])
      expect(registered()).toHaveLength(count)
    }
  })

  it('unregisters an empty lifetime too', async () => {
    const count = registered().length
    const facade = controllers()
    await facade.dispose()
    expect(registered()).toHaveLength(count)
    expect(facade.initializationLog()).toEqual([])
  })

  it('leaves a borrowed journal to its owner and removes only its own registration', async () => {
    const count = registered().length
    const journal = createBrowserInitializationJournal()
    const first = controllers({ journal })
    const second = controllers({ journal })
    journal.begin({ sessionId, tabId, occurrenceId: 'one', navigationRevision: 1, url: 'https://example.com/' })
    await first.dispose()
    await first.dispose()
    expect(registered()).toHaveLength(count + 1)
    expect(journal.all()).toHaveLength(1)
    await second.dispose()
    expect(registered()).toHaveLength(count)
    expect(journal.all()).toHaveLength(1)
    journal.dispose()
    expect(journal.all()).toEqual([])
  })

  it('releases the owned journal even when page disposal rejects', async () => {
    const count = registered().length
    const facade = controllers({}, true)
    mount(facade)
    await expect(facade.dispose()).rejects.toThrow('page disposal failed')
    expect(registered()).toHaveLength(count)
    expect(facade.initializationLog()).toEqual([])
  })
})
