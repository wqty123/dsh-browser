import { afterEach, expect, it, vi } from 'vitest'
import { connectWebReferenceSource } from '../web-reference-source.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('renews an expired source lease and removes the current lease on disposal, including empty polls', async () => {
  vi.useFakeTimers()
  const lifetime = new AbortController()
  let registrations = 0
  const requests: { operation: string; lease?: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push(body)
    const expired = body.operation === 'poll' && body.lease === 'lease-1'
    return { ok: !expired, status: expired ? 410 : 200, json: async () => body.operation === 'register'
      ? { lease: `lease-${++registrations}` } : { commands: [] } }
  }))
  await connectWebReferenceSource('session-owner', 'iframe:source', () => 'https://example.test/', lifetime.signal)
  await vi.advanceTimersByTimeAsync(500)
  expect(registrations).toBe(2)
  expect(requests.some(request => request.operation === 'poll' && request.lease === 'lease-2')).toBe(true)
  lifetime.abort()
  expect(requests.at(-1)).toEqual({ operation: 'remove', lease: 'lease-2' })
  const length = requests.length
  await vi.advanceTimersByTimeAsync(2_000)
  expect(requests).toHaveLength(length)
})

it('rejects unavailable or malformed registration instead of capturing a source with no channel', async () => {
  const lifetime = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })))
  await expect(connectWebReferenceSource('owner', 'iframe:source', () => 'https://example.test/', lifetime.signal)).rejects.toThrow('503')
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
  await expect(connectWebReferenceSource('owner', 'iframe:source', () => 'https://example.test/', lifetime.signal)).rejects.toThrow('lease missing')
})
