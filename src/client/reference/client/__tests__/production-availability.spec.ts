import { describe, expect, it } from 'vitest'
import {
  AVAILABILITY_MESSAGES,
  OK,
  availabilityOf,
  isDeliveriesResponse,
} from '../production/availability.ts'
import {
  createReferenceHttpClient,
  type RawResponse,
  type RequestInitLike,
} from '../production/http-transport.ts'
import { ReferenceHttpError, ROUTES } from '../production/protocol.ts'
import { createProductionRuntime } from '../production/runtime.ts'
import { FakeReferenceHttp, deliveriesResponse, fakeHostInput, makeDelivery, memoryKV } from './production.fixtures.ts'

function raw(body: unknown, status = 200, ok = status >= 200 && status < 300): RawResponse {
  return { ok, status, json: async () => body, bytes: async () => new Uint8Array() }
}

function recording(request: (url: string, init?: RequestInitLike) => RawResponse | Promise<RawResponse>) {
  const calls: { url: string }[] = []
  return {
    calls,
    http: createReferenceHttpClient({ request: (url, init) => {
      calls.push({ url })
      return Promise.resolve(request(url, init))
    } }),
  }
}

describe('isDeliveriesResponse — strict shape (no silent empty success)', () => {
  it('accepts a well-formed empty or populated response', () => {
    expect(isDeliveriesResponse({ ok: true, sequence: 3, deliveries: [] })).toBe(true)
    expect(isDeliveriesResponse(deliveriesResponse([makeDelivery()]))).toBe(true)
  })
  it('rejects missing ok, bad sequence, non-array deliveries, bad state, missing snapshot', () => {
    expect(isDeliveriesResponse({ sequence: 1, deliveries: [] })).toBe(false)
    expect(isDeliveriesResponse({ ok: true, sequence: 'x', deliveries: [] })).toBe(false)
    expect(isDeliveriesResponse({ ok: true, sequence: 1, deliveries: {} })).toBe(false)
    expect(isDeliveriesResponse({ ok: true, sequence: 1, deliveries: [{ intentId: 'i', sessionId: 's', state: 'prepared', snapshot: {}, failures: [], assetKeys: [], requiredAssets: [], sequence: 1 }] })).toBe(false)
    expect(isDeliveriesResponse({ ok: true, sequence: 1, deliveries: [{ state: 'bogus' }] })).toBe(false)
    expect(isDeliveriesResponse(null)).toBe(false)
  })
})

describe('availabilityOf — explicit, human-readable states', () => {
  it('ok on success, plugin-too-old on 404, delivery-unavailable on 5xx/shape, offline on network', () => {
    expect(availabilityOf(undefined)).toEqual(OK)
    expect(availabilityOf(new ReferenceHttpError('x', 404))).toEqual({
      status: 'plugin-too-old', message: AVAILABILITY_MESSAGES['plugin-too-old'],
    })
    expect(availabilityOf(new ReferenceHttpError('x', 503))).toEqual({
      status: 'delivery-unavailable', message: AVAILABILITY_MESSAGES['delivery-unavailable'],
    })
    expect(availabilityOf(new ReferenceHttpError('shape', 0))).toEqual({
      status: 'delivery-unavailable', message: AVAILABILITY_MESSAGES['delivery-unavailable'],
    })
    expect(availabilityOf(new Error('ECONNREFUSED'))).toEqual({
      status: 'offline', message: AVAILABILITY_MESSAGES.offline,
    })
  })
  it('a cancelled poll is not a user-visible outage', () => {
    const abort = new Error('aborted'); abort.name = 'AbortError'
    expect(availabilityOf(abort)).toEqual(OK)
  })
  it('the plugin-too-old copy is a full human sentence about updating the plugin', () => {
    expect(AVAILABILITY_MESSAGES['plugin-too-old']).toContain('浏览器插件需要更新')
  })
})

describe('http-transport — same-origin relative paths + explicit failure', () => {
  it('with no baseUrl the deliveries URL is a relative same-origin path (NEVER a port)', async () => {
    const { calls, http } = recording(() => raw({ ok: true, sequence: 0, deliveries: [] }))
    await http.deliveries('sess-A', 0)
    expect(calls[0]!.url.startsWith('/dsh-builtin-browser/reference/deliveries')).toBe(true)
    expect(calls[0]!.url).not.toMatch(/:\d{2,5}\//u)
    expect(calls[0]!.url).not.toContain('3080')
  })

  it('404 is preserved as a status-404 ReferenceHttpError (plugin-too-old)', async () => {
    const { http } = recording(() => raw({ ok: false, error: 'not-found' }, 404, false))
    await expect(http.deliveries('sess-A', 0)).rejects.toMatchObject({ status: 404 })
  })

  it('a 200 with a malformed body throws a status-0 error instead of pretending empty', async () => {
    const { http } = recording(() => raw({ ok: true, nope: true }))
    await expect(http.deliveries('sess-A', 0)).rejects.toMatchObject({ status: 0 })
  })

  it('every route uses the exact same-origin path table', () => {
    expect(ROUTES.deliveries.startsWith('/dsh-builtin-browser/reference/')).toBe(true)
    expect(ROUTES.ack.startsWith('/dsh-builtin-browser/reference/')).toBe(true)
    expect(ROUTES.reveal.startsWith('/dsh-builtin-browser/reference/')).toBe(true)
  })
})

describe('runtime.availability() — surfaces through the real poll path', () => {
  function runtimeWith(http: FakeReferenceHttp) {
    return createProductionRuntime({
      http,
      storage: memoryKV(),
      initialSessionId: 'sess-A',
      hostInputFor: () => fakeHostInput(),
      now: () => 1,
    })
  }

  it('ok after a well-formed poll', async () => {
    const http = new FakeReferenceHttp()
    http.enqueue(deliveriesResponse([], 0))
    const runtime = runtimeWith(http)
    expect(runtime.availability().status).toBe('ok')
    await runtime.pollOnce()
    expect(runtime.availability().status).toBe('ok')
    runtime.dispose()
  })

  it('plugin-too-old after a 404, and recovers to ok on a good poll', async () => {
    const { http: failing } = recording(() => raw({ ok: false }, 404, false))
    const runtime = createProductionRuntime({ http: failing, storage: memoryKV(), initialSessionId: 'sess-A', hostInputFor: () => fakeHostInput(), now: () => 1 })
    await expect(runtime.pollOnce()).resolves.toBeUndefined()
    expect(runtime.availability().status).toBe('plugin-too-old')
    expect(runtime.availability().message).toContain('浏览器插件需要更新')
    runtime.dispose()

    const ok = new FakeReferenceHttp()
    ok.enqueue(deliveriesResponse([], 0))
    const recovered = runtimeWith(ok)
    await recovered.pollOnce()
    expect(recovered.availability()).toEqual(OK)
    recovered.dispose()
  })

  it('reports the failure as a human sentence instead of an empty dock', async () => {
    const { http: failing } = recording(() => raw({ ok: false }, 404, false))
    const runtime = createProductionRuntime({ http: failing, storage: memoryKV(), initialSessionId: 'sess-A', hostInputFor: () => fakeHostInput(), now: () => 1 })
    await runtime.pollOnce()
    // The rail itself stays empty (no phantom pills); the reason lives in the
    // availability state the host reads, not in a banner nobody renders.
    expect(runtime.cards()).toHaveLength(0)
    expect(runtime.availability()).toEqual({ status: 'plugin-too-old', message: AVAILABILITY_MESSAGES['plugin-too-old'] })
    expect(runtime.availability().message).toContain('浏览器插件需要更新')
    runtime.dispose()
  })
})
