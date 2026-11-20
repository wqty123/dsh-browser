import { describe, expect, it, vi } from 'vitest'
import { createDeliveryPoller } from '../production/delivery-client.ts'
import type { DeliveriesResponse } from '../production/protocol.ts'
import type { ReferenceHttpClient } from '../production/http-transport.ts'
import { deliveriesResponse } from './production.fixtures.ts'

const scheduler = { setInterval: () => 0, clearInterval: () => {} }

function httpOf(deliveries: (sessionId: string, since: number) => Promise<DeliveriesResponse>) {
  return { deliveries } as unknown as ReferenceHttpClient
}

describe('delivery poller — single-flight under concurrent triggers', () => {
  it('coalesces an interval poll, a focus wake-up and a manual poll into one request', async () => {
    const resolvers: ((value: DeliveriesResponse) => void)[] = []
    const deliveries = vi.fn(() => new Promise<DeliveriesResponse>(resolve => { resolvers.push(resolve) }))
    const onCycle = vi.fn()
    const poller = createDeliveryPoller({
      http: httpOf(deliveries), scheduler, onCycle,
      getSessionId: () => 'session-A', getSince: () => 0,
    })
    const a = poller.pollOnce()
    const b = poller.pollOnce()
    const c = poller.pollOnce()
    expect(deliveries).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    resolvers[0]!(deliveriesResponse([], 0))
    await Promise.all([a, b, c])
    expect(onCycle).toHaveBeenCalledTimes(1)
    poller.dispose()
  })

  it('allows a fresh poll after the in-flight one settles', async () => {
    const deliveries = vi.fn(async (_sessionId: string, since: number) => deliveriesResponse([], since))
    const poller = createDeliveryPoller({
      http: httpOf(deliveries), scheduler, onCycle: () => {},
      getSessionId: () => 'session-A', getSince: () => 0,
    })
    await poller.pollOnce()
    await poller.pollOnce()
    expect(deliveries).toHaveBeenCalledTimes(2)
    poller.dispose()
  })

  it('a session switch is not blocked by the aborted request of the old session', () => {
    let session = 'session-A'
    const seen: string[] = []
    const deliveries = vi.fn((sessionId: string, _since: number) => {
      seen.push(sessionId)
      return new Promise<DeliveriesResponse>(() => { /* stays in flight */ })
    })
    const poller = createDeliveryPoller({
      http: httpOf(deliveries), scheduler, onCycle: () => {},
      getSessionId: () => session, getSince: () => 0,
    })
    void poller.pollOnce()
    session = 'session-B'
    poller.setSession('session-B')
    void poller.pollOnce()
    expect(seen).toEqual(['session-A', 'session-B'])
    poller.dispose()
  })

  it('stop() releases the slot so a later manual poll still runs', async () => {
    const deliveries = vi.fn(async (_sessionId: string, since: number) => deliveriesResponse([], since))
    const poller = createDeliveryPoller({
      http: httpOf(deliveries), scheduler, onCycle: () => {},
      getSessionId: () => 'session-A', getSince: () => 0,
    })
    await poller.pollOnce()
    poller.stop()
    await poller.pollOnce()
    expect(deliveries).toHaveBeenCalledTimes(2)
    poller.dispose()
  })

  it('never polls without a bound session', async () => {
    const deliveries = vi.fn(async (_sessionId: string, since: number) => deliveriesResponse([], since))
    const poller = createDeliveryPoller({
      http: httpOf(deliveries), scheduler, onCycle: () => {},
      getSessionId: () => '', getSince: () => 0,
    })
    expect(await poller.pollOnce()).toBeUndefined()
    expect(deliveries).not.toHaveBeenCalled()
    poller.dispose()
  })
})
