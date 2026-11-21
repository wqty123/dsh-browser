// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { installReferenceOverlay } from '../../electron/reference-overlay.ts'
import { createReferenceCapture } from '../../reference-capture-owner.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const intent = { capture: { ok: true, events: [{ kind: 'text', exact: 'first quote' }] } }

it.each(['transport', 'empty', 'unacknowledged'])('surfaces a consumed native intent failure in the app and guest: %s', async failure => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const lifetime = new AbortController()
  const queue = [failure === 'empty' ? {} : intent]
  const guest = { __dshRefTake: () => queue.shift() }
  const execute = vi.fn(async (source: string) => source.startsWith('JSON.stringify(')
    ? Function('window', `return (${source})`)(guest) : undefined)
  const fetch = vi.fn(async () => ({ ok: false, status: 503 }))
  vi.stubGlobal('fetch', fetch)
  const never = { getSnapshot: () => ({ phase: 'pending', state: 'loading', items: [] }), subscribe: () => () => {} }
  const capture = createReferenceCapture({ get: name => ({
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: undefined }), subscribe: () => () => {} } } },
    workspaces: { list: never }, uiWorkspace: { openWorkspace() {} },
  } as Record<string, unknown>)[name] }, lifetime.signal)
  try {
    installReferenceOverlay(execute, item => capture(item, failure === 'unacknowledged' ? undefined : 'session-unsent'), lifetime.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(queue).toHaveLength(0)
    if (failure === 'unacknowledged') await vi.advanceTimersByTimeAsync(30_000)
    expect(fetch).toHaveBeenCalledTimes(failure === 'transport' ? 1 : 0)
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('引用未能加入当前会话')
    expect(alert?.textContent).toContain(failure === 'transport' ? '503'
      : failure === 'empty' ? 'no captured content' : 'not acknowledged within 30 seconds')
    expect(execute.mock.calls.some(([script]) => script.includes('__dsh-ref-notice'))).toBe(true)
    alert?.querySelector('button')?.click()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  } finally { lifetime.abort() }
})

it('submits every taken intent even when the first failure notice cannot reach the old guest', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const lifetime = new AbortController()
  const queue = [{}, intent]
  const guest = { __dshRefTake: () => queue.shift() }
  const execute = vi.fn(async (source: string) => {
    if (source.startsWith('JSON.stringify(')) return Function('window', `return (${source})`)(guest)
    if (source.includes('__dsh-ref-notice')) throw new Error('guest navigated')
    return undefined
  })
  const request = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }))
  vi.stubGlobal('fetch', request)
  const capture = createReferenceCapture({ get: () => undefined }, lifetime.signal)
  try {
    installReferenceOverlay(execute, item => capture(item, 'session-unsent'), lifetime.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(queue).toHaveLength(0)
    expect(request).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('no captured content')
  } finally { lifetime.abort() }
})

it('reports an already taken intent if plugin disposal prevents submission', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const lifetime = new AbortController()
  let release!: (result: string) => void
  const execute = vi.fn(async (source: string) => source.startsWith('JSON.stringify(')
    ? new Promise<string>(resolve => { release = resolve }) : undefined)
  const request = vi.fn()
  vi.stubGlobal('fetch', request)
  const capture = createReferenceCapture({ get: () => undefined }, lifetime.signal)
  installReferenceOverlay(execute, item => capture(item, 'session-unsent'), lifetime.signal)
  await vi.advanceTimersByTimeAsync(0)
  lifetime.abort(new Error('plugin stopped'))
  release(JSON.stringify([intent]))
  await vi.advanceTimersByTimeAsync(0)
  expect(request).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('plugin stopped')
})

it.each(['[]', 'invalid JSON', '{}', '[false]'])('keeps polling after an empty or invalid drain: %s', async result => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const lifetime = new AbortController()
  const consume = vi.fn()
  const execute = vi.fn(async (source: string) => source.startsWith('JSON.stringify(') ? result : undefined)
  try {
    installReferenceOverlay(execute, consume, lifetime.signal)
    await vi.advanceTimersByTimeAsync(300)
    expect(execute.mock.calls.filter(([source]) => source.startsWith('JSON.stringify('))).toHaveLength(2)
    expect(consume).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]') !== null).toBe(result !== '[]')
  } finally { lifetime.abort() }
})
