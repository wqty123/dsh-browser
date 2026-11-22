import { describe, expect, it } from 'vitest'
import {
  createReferenceHttpClient,
  type RawResponse,
  type RequestInitLike,
} from '../production/http-transport.ts'
import { ROUTES } from '../production/protocol.ts'
import { decodeBase64 } from '../production/bytes.ts'
import { ASSET_MAP, IMG1_BYTES, IMG1_KEY } from './production.fixtures.ts'

interface RecordedCall {
  readonly url: string
  readonly init?: RequestInitLike
}

function jsonResponse(body: unknown, status = 200): RawResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    bytes: async () => new Uint8Array(),
  }
}

function recorder(handler: (url: string, init?: RequestInitLike) => RawResponse) {
  const calls: RecordedCall[] = []
  const request = (url: string, init?: RequestInitLike) => {
    calls.push({ url, ...(init === undefined ? {} : { init }) })
    return Promise.resolve(handler(url, init))
  }
  return { request, calls }
}

describe('base64 decoder (no node/DOM globals)', () => {
  const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')
  it('decodes exactly what an encoder produces, and rejects garbage', () => {
    expect(decodeBase64(base64(IMG1_BYTES))).toEqual(IMG1_BYTES)
    expect(Buffer.from(IMG1_BYTES).toString('hex')).toBe('89504e470d0a1a0a00010203faff002a')
    expect(() => decodeBase64('%%%bad')).toThrow()
  })
})

describe('createReferenceHttpClient — exact wire shapes', () => {
  const baseUrl = 'http://127.0.0.1:45123'

  it('GET deliveries carries sessionId and an incremental since (omits since=0)', () => {
    const { request, calls } = recorder(() => jsonResponse({ ok: true, sequence: 5, deliveries: [] }))
    const http = createReferenceHttpClient({ baseUrl, request })
    void http.deliveries('sess-A', 0)
    void http.deliveries('sess-A', 4)
    expect(calls[0]!.url).toBe(`${baseUrl}${ROUTES.deliveries}?sessionId=sess-A&includeConsumed=1`)
    expect(calls[1]!.url).toBe(`${baseUrl}${ROUTES.deliveries}?sessionId=sess-A&since=4&includeConsumed=1`)
  })

  it('asset base64 vs raw bytes use the correct encoding param', () => {
    const { request, calls } = recorder((url) =>
      url.includes('encoding=base64')
        ? jsonResponse({ ok: true, key: IMG1_KEY, mime: 'image/png', bytes: IMG1_BYTES.length, sha256: IMG1_KEY, data: Buffer.from(IMG1_BYTES).toString('base64') })
        : { ok: true, status: 200, json: async () => ({}), bytes: async () => IMG1_BYTES },
    )
    const http = createReferenceHttpClient({ baseUrl, request })
    void http.assetBase64(IMG1_KEY)
    void http.assetBytes(IMG1_KEY)
    expect(calls[0]!.url).toBe(`${baseUrl}${ROUTES.asset}?key=${IMG1_KEY}&encoding=base64`)
    expect(calls[1]!.url).toBe(`${baseUrl}${ROUTES.asset}?key=${IMG1_KEY}`)
  })

  it('ACK POSTs a JSON body with intentId, saved draftRev and all content-hash assetKeys', async () => {
    const { request, calls } = recorder(() => jsonResponse({ ok: true, state: 'acknowledged', draftRev: 1, assetKeys: [IMG1_KEY] }))
    const http = createReferenceHttpClient({ baseUrl, request })
    const response = await http.ack({ intentId: 'ref-mixed-1', draftRev: 1, assetKeys: [IMG1_KEY], phase: 'acknowledged' })
    expect(response.state).toBe('acknowledged')
    expect(calls[0]!.url).toBe(`${baseUrl}${ROUTES.ack}`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.headers?.['content-type']).toBe('application/json')
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({
      intentId: 'ref-mixed-1', draftRev: 1, assetKeys: [IMG1_KEY], phase: 'acknowledged',
    })
  })

  it('phase is omitted when not supplied (defaults to acknowledged server-side)', async () => {
    const { request, calls } = recorder(() => jsonResponse({ ok: true, state: 'acknowledged', draftRev: 2, assetKeys: [] }))
    const http = createReferenceHttpClient({ baseUrl, request })
    await http.ack({ intentId: 'x', draftRev: 2, assetKeys: [] })
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ intentId: 'x', draftRev: 2, assetKeys: [] })
  })

  it('remove / reveal / export / import use the right methods, params and bodies', async () => {
    const { request, calls } = recorder(() => jsonResponse({ ok: true }))
    const http = createReferenceHttpClient({ baseUrl, request })
    await http.remove('ref-mixed-1')
    await http.reveal('ref-mixed-1', 'tb-1')
    await http.exportBundle('markdown-zip', 'sess-A')
    await http.importBundle(new Uint8Array([1, 2, 3]))
    expect(calls[0]!.url).toBe(`${baseUrl}${ROUTES.remove}`)
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ intentId: 'ref-mixed-1' })
    expect(calls[1]!.url).toBe(`${baseUrl}${ROUTES.reveal}`)
    expect(JSON.parse(calls[1]!.init?.body as string)).toEqual({ referenceId: 'ref-mixed-1', partId: 'tb-1' })
    expect(calls[2]!.url).toBe(`${baseUrl}${ROUTES.export}?format=markdown-zip&sessionId=sess-A`)
    expect(calls[3]!.url).toBe(`${baseUrl}${ROUTES.import}`)
    expect(calls[3]!.init?.headers?.['content-type']).toBe('application/zip')
    expect(calls[3]!.init?.body).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('a non-2xx read throws ReferenceHttpError carrying the status', async () => {
    const { request } = recorder(() => jsonResponse({ ok: false, error: 'gone' }, 409))
    const http = createReferenceHttpClient({ baseUrl, request })
    await expect(http.ack({ intentId: 'x', draftRev: 1, assetKeys: [] })).rejects.toMatchObject({ status: 409 })
  })

  it('decodes a base64 asset response back to the original bytes', async () => {
    const asset = ASSET_MAP[IMG1_KEY]!
    const { request } = recorder(() => jsonResponse({
      ok: true, key: IMG1_KEY, mime: 'image/png', bytes: asset.length, sha256: IMG1_KEY, data: Buffer.from(asset).toString('base64'),
    }))
    const http = createReferenceHttpClient({ baseUrl, request })
    const response = await http.assetBase64(IMG1_KEY)
    expect(decodeBase64(response.data)).toEqual(IMG1_BYTES)
    expect(response.bytes).toBe(IMG1_BYTES.length)
  })
})
