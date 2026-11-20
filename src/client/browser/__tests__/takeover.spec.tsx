// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TakeoverBanner } from '../../view/TakeoverBanner.tsx'
import { BrowserBody, type BrowserBodyProps } from '../../view/BrowserBody.tsx'
import { emptyBrowserFrame } from '../BrowserFrame.ts'
import { zh } from '../../locales.ts'
import { connectBrowserTakeover, readTakeoverSummary, registerTakeoverSummary } from '../takeover-channel.ts'
import type { TakeoverNotice } from '../../../takeover-protocol.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'button', Tooltip: ({ children }: { children: import('react').ReactNode }) => children,
  IconChevronLeftOutlineRegular: () => null, IconChevronRightOutlineRegular: () => null,
  IconLinkOutlineRegular: () => null, IconRefreshOutlineRegular: () => null, IconRightUpOutlineRegular: () => null,
  SHIELD_OUTLINE_PATH: '', ICON_REGULAR_STROKE: 1,
}))
vi.mock('../../view/StartPage.tsx', () => ({
  EngineSettingsDialog: () => null, SearchEngineMenu: () => null, ShortcutDialog: () => null, StartPage: () => null,
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

const waiting: TakeoverNotice = { id: 'request-1', reason: '请完成登录', instructions: '使用你自己的账号', phase: 'waiting' }
const labels = { label: 'AI 正在等待你完成操作：请完成登录', done: '确认完成', skip: '跳过', failure: '确认失败，请重试' }

it('renders only a waiting request, its instructions and both scoped actions', () => {
  const answer = vi.fn()
  const view = render(<TakeoverBanner {...labels} answer={answer} />)
  expect(screen.queryByRole('status')).toBeNull()
  view.rerender(<TakeoverBanner {...labels} notice={waiting} answer={answer} />)
  expect(screen.getByRole('status').textContent).toContain(labels.label)
  expect(screen.getByText(labels.label).getAttribute('title')).toBe(`${labels.label}\n使用你自己的账号`)
  fireEvent.click(screen.getByRole('button', { name: '确认完成' }))
  fireEvent.click(screen.getByRole('button', { name: '跳过' }))
  expect(answer.mock.calls).toEqual([['done'], ['skipped']])
  view.rerender(<TakeoverBanner {...labels} notice={waiting} error answer={answer} />)
  expect(screen.getByRole('alert').textContent).toContain('确认失败')
  view.rerender(<TakeoverBanner {...labels} notice={{ ...waiting, phase: 'summary' }} answer={answer} />)
  expect(screen.queryByRole('status')).toBeNull()
})

it.each(['42', 'iframe:page'])('Desktop/Web channel %s registers canonical identity, answers once, and withdraws on stop', async pageId => {
  vi.useFakeTimers()
  const lifetime = new AbortController(), requests: Record<string, unknown>[] = [], changed = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const data = JSON.parse(init.body); requests.push(data)
    return { ok: true, json: async () => data.operation === 'register' ? { lease: 'lease' } : data.operation === 'poll' ? { notice: waiting } : {} }
  }))
  const channel = connectBrowserTakeover({ owner: 'session-owner', tabId: 'tab', pageId,
    current: () => ({ url: 'https://example.test/', active: true }), changed,
  }, lifetime.signal)
  await vi.advanceTimersByTimeAsync(0)
  expect(requests[0]).toMatchObject({ operation: 'register', owner: 'session-owner', pageId, tabId: 'tab', active: true })
  expect(changed).toHaveBeenCalledWith(waiting)
  await Promise.all([channel.answer('done'), channel.answer('skipped')])
  expect(requests.filter(request => request.operation === 'answer')).toEqual([{ operation: 'answer', lease: 'lease', id: 'request-1', outcome: 'done' }])
  lifetime.abort()
  expect(changed).toHaveBeenLastCalledWith(undefined)
  expect(requests.at(-1)).toEqual({ operation: 'remove', lease: 'lease' })
  const count = requests.length
  await vi.advanceTimersByTimeAsync(2000)
  expect(requests).toHaveLength(count)
})

it.each(['42', 'iframe:page'])('shared BrowserBody wires the current Desktop/Web page %s to its banner and controls', async pageId => {
  vi.useFakeTimers()
  const requests: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const data = JSON.parse(init.body); requests.push(data)
    return { ok: true, json: async () => data.operation === 'register' ? { lease: 'body-lease' } : data.operation === 'poll' ? { notice: waiting } : {} }
  }))
  const url = 'https://example.test/'
  const tab = { id: 'sidebar-tab', navigation: { params: { url }, revision: 1 }, actions: { bindCommands: () => () => {} } }
  const props = { sessionId: 'session-owner', useTabInfo: () => ({ tab }), useContextMenu: () => ({ getTriggerProps: () => ({}) }),
    useStore: () => undefined, useStartPage: () => ({ status: 'ready', engines: [], shortcuts: [] }),
    useBrowserState: () => ({ frame: { ...emptyBrowserFrame(), target: { kind: 'https', url }, address: 'observed' }, initialization: { guestId: 'stale-page' } }),
    currentPage: () => ({ url, guestId: pageId }), mount: () => () => {}, bindAddressFocus: () => () => {},
    loadUrl() {}, reload() {}, shortcuts: {}, engines: {},
    t: (key: keyof typeof zh, params?: Record<string, string>) => zh[key].replace('{reason}', params?.reason ?? ''),
  } as unknown as BrowserBodyProps
  const view = render(<BrowserBody {...props} />)
  Object.defineProperty(view.container.firstElementChild!, 'checkVisibility', { value: () => true })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(requests[0]).toMatchObject({ operation: 'register', owner: 'session-owner', tabId: 'sidebar-tab', pageId })
  expect(requests.some(request => request.operation === 'poll' && request.active === true)).toBe(true)
  expect(screen.getByRole('status').textContent).toContain(labels.label)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认完成' })) })
  expect(requests).toContainEqual({ operation: 'answer', lease: 'body-lease', id: waiting.id, outcome: 'done' })
  expect(screen.queryByText(labels.label)).toBeNull()
  view.unmount()
  expect(requests.at(-1)).toEqual({ operation: 'remove', lease: 'body-lease' })
})

it('Web summary is fresh, owner-scoped and submitted only after the answer is committed', async () => {
  vi.useFakeTimers()
  const lifetime = new AbortController(), requests: Record<string, unknown>[] = []
  const summary = { url: 'https://example.test/finished', title: 'Logged in', snapshotHint: 'Welcome back', fresh: true }
  const unregister = registerTakeoverSummary('iframe:page', 'owner', async () => summary)
  await expect(readTakeoverSummary('iframe:page', 'someone-else', lifetime.signal)).rejects.toThrow('unavailable')
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const data = JSON.parse(init.body); requests.push(data)
    return { ok: true, json: async () => data.operation === 'register' ? { lease: 'lease' } : data.operation === 'poll' ? { notice: { ...waiting, phase: 'summary' } } : {} }
  }))
  connectBrowserTakeover({ owner: 'session-owner', tabId: 'tab', pageId: 'iframe:page',
    current: () => ({ url: summary.url, active: true }), changed: vi.fn(),
  }, lifetime.signal)
  await vi.advanceTimersByTimeAsync(0)
  expect(requests).toContainEqual({ operation: 'summary', lease: 'lease', id: 'request-1', summary })
  lifetime.abort(); unregister()
  await expect(readTakeoverSummary('iframe:page', 'owner', lifetime.signal)).rejects.toThrow('unavailable')
})

it('a failed answer is visible and retryable; an unavailable registration never fabricates controls', async () => {
  vi.useFakeTimers()
  const lifetime = new AbortController(), changed = vi.fn()
  let unavailable = true
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const data = JSON.parse(init.body)
    return { ok: !unavailable && data.operation !== 'answer', status: 503,
      json: async () => data.operation === 'register' ? { lease: 'lease' } : { notice: waiting } }
  }))
  const channel = connectBrowserTakeover({ owner: 'owner', tabId: 'tab', pageId: '42', current: () => ({ url: 'https://example.test/', active: true }), changed }, lifetime.signal)
  await vi.advanceTimersByTimeAsync(0)
  expect(changed).not.toHaveBeenCalledWith(waiting)
  unavailable = false
  await vi.advanceTimersByTimeAsync(400)
  await channel.answer('done')
  expect(changed).toHaveBeenLastCalledWith(waiting, true)
  lifetime.abort()
})
