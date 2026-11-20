import { describe, expect, it } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createBrowserInitializationJournal, createBrowserInitializationReader } from '../../../browser/initialization.ts'
import { openReferenceSource } from '../production/source-opener.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { BrowserController, type BrowserControllerOptions } from '../../../browser/BrowserController.ts'
import { emptyBrowserFrame, type BrowserCarrierState } from '../../../browser/BrowserFrame.ts'

const owner = '79b4e5bd-5bf4-49f3-b911-5d1a92b7002b'
const sessionId = `session-${owner}`
const tabId = 'source-tab' as TabId
const url = 'https://example.com/article'

function fixture() {
  const listeners = new Set<() => void>()
  const journal = createBrowserInitializationJournal({ onChange: () => { for (const listener of listeners) listener() } })
  const reader = createBrowserInitializationReader((_session, tab) => journal.get(tab), listener => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  const tabs: { id: string; kind: string }[] = []
  const sidebar = {
    tabsIn(id: string) { expect(id).toBe(sessionId); return tabs },
    openTabIn(id: string) {
      expect(id).toBe(sessionId)
      tabs.push({ id: tabId, kind: 'browser' })
      journal.begin({ sessionId, tabId, occurrenceId: 'mount-1', navigationRevision: 1, url })
      journal.advance(tabId, 'navigating')
    },
  }
  return { sidebar, reader, journal, listeners }
}

describe('source page readiness', () => {
  it.each([url, 'https://example.com/redirected'])('acknowledges the current completed navigation at %s without accepting stale documents', async observedUrl => {
    const frame = createSnapshotStore(emptyBrowserFrame())
    const lifecycle = createSnapshotStore<BrowserCarrierState>({ stage: 'guest', guestId: '42' })
    const journal = createBrowserInitializationJournal()
    const controller = new BrowserController({
      tabId, sessionId, signal: new AbortController().signal, occurrenceId: 'source-mount', journal,
      applicationOrigin: 'https://dsh.test', initial: undefined,
      actions: { replace() {} } as BrowserControllerOptions['actions'], openTab() {},
      createPage: () => ({
        frame: { ...frame, lifecycle, loadUrl(_target, navigationId) {
          frame.set({ ...frame.getSnapshot(), navigationId, address: 'requested', loading: true })
        }, goBack() {}, goForward() {}, reload() {}, async dispose() {} },
        presentation: { mount: () => () => {} },
      }),
    })
    try {
      controller.navigate(url, 1)
      const navigationId = journal.get(tabId)!.requestId
      lifecycle.set({ stage: 'ready', guestId: '42' })
      expect(journal.get(tabId)?.stage).toBe('navigating')
      frame.set({ ...emptyBrowserFrame(), navigationId: 'stale-request', address: 'observed', target: { kind: 'https', url: observedUrl, title: '' }, loading: false })
      expect(journal.get(tabId)?.stage).toBe('navigating')
      frame.set({ ...frame.getSnapshot(), navigationId, loading: true })
      expect(journal.get(tabId)?.stage).toBe('navigating')
      frame.set({ ...frame.getSnapshot(), loading: false })
      expect(journal.get(tabId)).toMatchObject({ stage: 'attached', guestId: '42', url })
    } finally { await controller.dispose() }
  })

  it('waits for the exact page acknowledgement rather than tab placement or elapsed time', async () => {
    const { sidebar, reader, journal, listeners } = fixture()
    let settled = false
    const result = openReferenceSource(sidebar, reader, owner, url, new AbortController().signal)
    void result.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    journal.advance(tabId, 'attached', { guestId: '42' })
    await expect(result).resolves.toEqual({ pageId: '42' })
    expect(listeners.size).toBe(0)
  })

  it.each(['navigation-failed', 'workspace-unavailable'] as const)('fails closed on %s', async reason => {
    const { sidebar, reader, journal, listeners } = fixture()
    const result = openReferenceSource(sidebar, reader, owner, url, new AbortController().signal)
    await Promise.resolve()
    journal.fail(tabId, reason)
    await expect(result).rejects.toThrow(reason)
    expect(listeners.size).toBe(0)
  })

  it('cancels a pending source wait and removes its subscription', async () => {
    const { sidebar, reader, listeners } = fixture()
    const cancellation = new AbortController()
    const result = openReferenceSource(sidebar, reader, owner, url, cancellation.signal)
    await Promise.resolve()
    cancellation.abort()
    await expect(result).rejects.toThrow('aborted')
    expect(listeners.size).toBe(0)
  })

  it('rejects an attached iframe without native page-control capability', async () => {
    const { sidebar, reader, journal } = fixture()
    const result = openReferenceSource(sidebar, reader, owner, url, new AbortController().signal)
    await Promise.resolve()
    journal.advance(tabId, 'attached')
    await expect(result).rejects.toThrow('controllable sidebar guest')
  })

  it('navigates the same sidebar tab back and waits for a new document receipt', async () => {
    const { sidebar, reader, journal } = fixture()
    sidebar.openTabIn(sessionId)
    journal.advance(tabId, 'attached', { guestId: '42' })
    let navigate!: () => void
    let opened = false
    const source = {
      ...sidebar,
      openTabIn() { opened = true },
      navigateTabIn(id: string, tab: string) {
        expect([id, tab]).toEqual([sessionId, tabId])
        navigate = () => {
          journal.begin({ sessionId, tabId, occurrenceId: 'mount-1', navigationRevision: 2, url })
          journal.advance(tabId, 'attached', { guestId: '42' })
        }
        return true
      },
    }
    const result = openReferenceSource(source, reader, owner, url, new AbortController().signal)
    let settled = false
    void result.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    navigate()
    await expect(result).resolves.toEqual({ pageId: '42' })
    expect(opened).toBe(false)
  })

  it('does not acknowledge another owner or document', async () => {
    const { reader, journal, listeners } = fixture()
    const cancellation = new AbortController()
    const result = reader.wait({ sessionId, tabId, url }, cancellation.signal)
    journal.begin({ sessionId: 'session-foreign', tabId, occurrenceId: 'foreign', navigationRevision: 1, url })
    journal.advance(tabId, 'attached', { guestId: '99' })
    journal.begin({ sessionId, tabId, occurrenceId: 'wrong-document', navigationRevision: 2, url: 'https://example.com/other' })
    journal.advance(tabId, 'attached', { guestId: '98' })
    expect(listeners.size).toBe(1)
    cancellation.abort()
    await expect(result).rejects.toThrow('aborted')
  })

  it('rejects missing owner, missing tab and a tab-open refusal', async () => {
    const { sidebar, reader } = fixture()
    const signal = new AbortController().signal
    await expect(openReferenceSource(sidebar, reader, '', url, signal)).rejects.toThrow('unavailable')
    await expect(openReferenceSource({ ...sidebar, openTabIn() {} }, reader, owner, url, signal)).rejects.toThrow('one source tab')
    await expect(openReferenceSource({ ...sidebar, openTabIn() { throw new Error('open refused') } }, reader, owner, url, signal)).rejects.toThrow('open refused')
  })
})
