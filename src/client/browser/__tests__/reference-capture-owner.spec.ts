import { afterEach, expect, it, vi } from 'vitest'
import { createReferenceCapture } from '../../reference-capture-owner.ts'

function source<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next: T) { value = next; for (const listener of listeners) listener() },
    listeners,
  }
}

const intent = { capture: { ok: true, events: [{ kind: 'text', exact: 'first quote' }] }, sessionId: 'forged' }
const workspace = { workspaceId: 'workspace:default', createdAt: '2026-01-01', sessionIds: [] as string[] }

function host(selected?: string) {
  const current = source<{ key: string | undefined }>({ key: selected })
  const list = source({ phase: 'ready', state: 'idle', items: [] as typeof workspace[] })
  const initializeDefault = vi.fn(async () => workspace as typeof workspace | undefined)
  const openWorkspace = vi.fn(async (_id: string, beforeOpen: (id: string) => void) => {
    beforeOpen('session-created')
    current.set({ key: 'session-created' })
  })
  const services: Record<string, unknown> = {
    uiSession: { adapter: { current } }, workspaces: { list, initializeDefault }, uiWorkspace: { openWorkspace },
    sessions: { list: source({ phase: 'ready', byId: { 'session-old': { updatedAt: 10 }, recent: { updatedAt: 100 } } }) },
  }
  const request = vi.fn(async (_input: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }))
  vi.stubGlobal('fetch', request)
  const lifetime = new AbortController()
  const capture = createReferenceCapture({ get: name => services[name] }, lifetime.signal)
  return { capture, current, list, initializeDefault, openWorkspace, request, lifetime, services }
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('binds a first unsent quote to the selected host Session, never a stale sidebar owner', async () => {
  const h = host('session-selected')
  await h.capture(intent, 'session-stale')
  expect(h.openWorkspace).not.toHaveBeenCalled()
  expect(JSON.parse(String(h.request.mock.calls[0]![1]!.body))).toMatchObject({ sessionId: 'selected' })
})

it.each([false, true])('submits to the host-scoped unsent Session without requiring a materialized UI binding (service absent: %s)', async absent => {
  const h = host()
  if (absent) delete h.services.uiSession
  h.list.set({ phase: 'pending', state: 'loading', items: [] })
  await h.capture(intent, 'session-unsent')
  expect(h.openWorkspace).not.toHaveBeenCalled()
  expect(h.initializeDefault).not.toHaveBeenCalled()
  expect(h.request).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(h.request.mock.calls[0]![1]!.body)).sessionId).toBe('unsent')
})

it('does not block an already selected Session behind another capture opening a Workspace', async () => {
  const h = host()
  let complete!: () => void
  h.openWorkspace.mockImplementation(async (_id, beforeOpen) => {
    beforeOpen('session-created')
    await new Promise<void>(resolve => { complete = resolve })
  })
  const opening = h.capture(intent)
  await vi.waitFor(() => expect(h.openWorkspace).toHaveBeenCalledTimes(1))
  h.current.set({ key: 'session-created' })
  const selected = h.capture(intent, 'session-stale')
  expect(h.request).toHaveBeenCalledTimes(1)
  await selected
  complete()
  await opening
  expect(h.request).toHaveBeenCalledTimes(2)
  for (const [, init] of h.request.mock.calls) expect(JSON.parse(String(init?.body)).sessionId).toBe('created')
})

it('shares home capture initialization and waits for the exact selection acknowledgement, without creation events', async () => {
  const h = host()
  let acknowledge!: () => void
  h.openWorkspace.mockImplementation(async (_id, beforeOpen) => {
    beforeOpen('session-reused-blank')
    acknowledge = () => { h.current.set({ key: 'session-reused-blank' }) }
  })
  const pending = [h.capture(intent), h.capture(intent)]
  await vi.waitFor(() => expect(h.openWorkspace).toHaveBeenCalledTimes(1))
  expect(h.request).not.toHaveBeenCalled()
  acknowledge()
  await Promise.all(pending)
  expect(h.request).toHaveBeenCalledTimes(2)
  for (const [, init] of h.request.mock.calls) expect(JSON.parse(String(init?.body)).sessionId).toBe('reused-blank')
  expect(h.current.listeners.size).toBe(0)
})

it.each(['recent', 'empty'])('uses the host recent/default Workspace policy only without a Session (%s)', async mode => {
  const h = host()
  h.list.set({ phase: 'ready', state: 'idle', items: mode === 'empty' ? [] : [
    { ...workspace, workspaceId: 'workspace:old', sessionIds: ['session-old'] },
    { ...workspace, workspaceId: 'workspace:recent', sessionIds: ['recent'] },
  ] })
  await h.capture(intent)
  expect(h.openWorkspace.mock.calls[0]![0]).toBe(`workspace:${mode === 'empty' ? 'default' : 'recent'}`)
  expect(h.initializeDefault).toHaveBeenCalledTimes(mode === 'empty' ? 1 : 0)
})

it('waits for the authoritative Workspace list instead of initializing from a loading snapshot', async () => {
  const h = host()
  h.list.set({ phase: 'pending', state: 'loading', items: [] })
  const pending = h.capture(intent)
  expect(h.initializeDefault).not.toHaveBeenCalled()
  h.list.set({ phase: 'ready', state: 'idle', items: [] })
  await pending
  expect(h.initializeDefault).toHaveBeenCalledTimes(1)
  expect(h.list.listeners.size).toBe(0)
})

it.each(['empty intent', 'no Workspace', 'Workspace failure', 'creation failure', 'superseded', 'wrong selection', 'missing navigation'])('refuses capture without guessing an owner: %s', async failure => {
  const h = host()
  if (failure === 'no Workspace') h.initializeDefault.mockResolvedValue(undefined)
  if (failure === 'Workspace failure') h.list.set({ phase: 'pending', state: 'error', items: [] })
  if (failure === 'creation failure') h.openWorkspace.mockRejectedValue(new Error('creation refused'))
  if (failure === 'superseded') h.openWorkspace.mockImplementation(async () => { h.current.set({ key: 'session-unrelated' }) })
  if (failure === 'wrong selection') h.openWorkspace.mockImplementation(async (_id, beforeOpen) => {
    beforeOpen('session-expected'); h.current.set({ key: 'session-unrelated' })
  })
  if (failure === 'missing navigation') delete h.services.uiWorkspace
  await expect(h.capture(failure === 'empty intent' ? {} : intent)).rejects.toThrow()
  expect(h.request).not.toHaveBeenCalled()
  expect(h.current.listeners.size).toBe(0)
})

it('cancels an unacknowledged selection and releases its subscription on plugin disposal', async () => {
  const h = host()
  h.openWorkspace.mockImplementation(async (_id, beforeOpen) => { beforeOpen('session-expected') })
  const pending = h.capture(intent)
  await vi.waitFor(() => expect(h.current.listeners.size).toBe(1))
  h.lifetime.abort(new Error('plugin disposed'))
  await expect(pending).rejects.toThrow('plugin disposed')
  expect(h.request).not.toHaveBeenCalled()
  expect(h.current.listeners.size).toBe(0)
})

it('surfaces capture transport failure after selecting the real Session', async () => {
  const h = host()
  h.request.mockRejectedValue(new Error('capture transport refused'))
  await expect(h.capture(intent)).rejects.toThrow('capture transport refused')
  expect(h.current.getSnapshot().key).toBe('session-created')
})

it.each(['Workspace loading', 'Workspace navigation', 'selection acknowledgement'])('rejects and cancels a capture with no %s rather than silently consuming it', async phase => {
  vi.useFakeTimers()
  const h = host()
  if (phase === 'Workspace loading') h.list.set({ phase: 'pending', state: 'loading', items: [] })
  if (phase === 'Workspace navigation') h.openWorkspace.mockImplementation(() => new Promise(() => {}))
  if (phase === 'selection acknowledgement') h.openWorkspace.mockImplementation(async (_id, beforeOpen) => { beforeOpen('session-created') })
  const failure = expect(h.capture(intent)).rejects.toThrow('reference capture was not acknowledged within 30 seconds')
  await vi.advanceTimersByTimeAsync(30_000)
  await failure
  expect(h.request).not.toHaveBeenCalled()
  expect(h.current.listeners.size).toBe(0)
  expect(h.list.listeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
