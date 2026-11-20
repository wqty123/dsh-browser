/**
 * Injected HTTP client for the built-in browser reference endpoints.
 *
 * No `fetch` global and no host transport is imported: a `RequestLike` function
 * is injected. The concrete `createReferenceHttpClient` builds the exact paths,
 * query strings and JSON bodies the plugin router expects, so a unit test can
 * assert on the real URL/params rather than on "fetch was called".
 *
 * Reads rely on the host cookie (the plugin's `requireRead`); writes add the
 * same-origin + loopback boundaries server-side, so the client only needs to
 * send credentials and a JSON content type.
 *
 * The plugin routes are EXACT paths registered on DSH's OWN webServer, so the
 * client uses SAME-ORIGIN RELATIVE paths (`/dsh-builtin-browser/reference/...`)
 * and NEVER hardcodes a port. `baseUrl` defaults to '' on purpose: a 3080 (or
 * any other) fallback would disguise "plugin version too old" as a routing
 * problem. A missing route (404) is surfaced as `plugin-too-old`, never retried
 * against another origin.
 *
 * @module dsh-browser-reference/production/http-transport
 */
import {
  ROUTES,
  ReferenceHttpError,
  type AckRequest,
  type AckResponse,
  type AssetResponse,
  type DeliveriesResponse,
  type ExportFormat,
  type RemoveResponse,
  type RevealResultWire,
} from './protocol.ts'
import { isDeliveriesResponse } from './availability.ts'

/** Minimal response face; `json` and `bytes` cover every route we consume. */
export interface RawResponse {
  readonly status: number
  readonly ok: boolean
  json(): Promise<unknown>
  bytes(): Promise<Uint8Array>
}

export interface RequestInitLike {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Uint8Array
}

/** Injected request function (a thin `fetch` adapter in the host assembly). */
export type RequestLike = (url: string, init?: RequestInitLike) => Promise<RawResponse>

export interface ReferenceHttpClient {
  deliveries(sessionId: string, since: number): Promise<DeliveriesResponse>
  assetBase64(key: string): Promise<AssetResponse>
  assetBytes(key: string): Promise<Uint8Array>
  ack(request: AckRequest): Promise<AckResponse>
  /** Persist an accepted message's consumption independently of browser storage. */
  consume?(sessionId: string, intentId: string): Promise<void>
  bindSubmission?(sessionId: string, requestId: string, intentIds: readonly string[]): Promise<void>
  remove(intentId: string): Promise<RemoveResponse>
  reveal(referenceId: string, partId?: string, navigate?: boolean): Promise<RevealResultWire>
  exportBundle(format: ExportFormat, sessionId: string): Promise<Uint8Array>
  importBundle(zip: Uint8Array): Promise<unknown>
}

export interface HttpClientOptions {
  /** Origin of the plugin HTTP surface, e.g. `http://127.0.0.1:<port>`. No trailing slash. */
  readonly baseUrl?: string
  readonly request: RequestLike
  /** Abort signal forwarded per request for cancellable polling. */
  readonly signal?: () => AbortSignal | undefined
}

function query(params: Readonly<Record<string, string | number | undefined>>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

function jsonHeaders(): Readonly<Record<string, string>> {
  return { 'content-type': 'application/json' }
}

/** Build the typed client over one injected request function. */
export function createReferenceHttpClient(options: HttpClientOptions): ReferenceHttpClient {
  const base = (options.baseUrl ?? '').replace(/\/+$/u, '')
  const request = options.request

  const readJson = async (url: string): Promise<unknown> => {
    const response = await request(url)
    if (!response.ok) {
      let body: unknown
      try { body = await response.json() } catch { /* error bodies are best-effort */ }
      throw new ReferenceHttpError(`GET ${url} failed with ${response.status}`, response.status, body)
    }
    return response.json()
  }

  const writeJson = async (url: string, payload: unknown): Promise<unknown> => {
    const response = await request(url, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      let body: unknown
      try { body = await response.json() } catch { /* error bodies are best-effort */ }
      throw new ReferenceHttpError(`POST ${url} failed with ${response.status}`, response.status, body)
    }
    return response.json()
  }

  return {
    async deliveries(sessionId, since) {
      const url = `${base}${ROUTES.deliveries}${query({ sessionId, since: since > 0 ? since : undefined, includeConsumed: 1 })}`
      const body: unknown = await readJson(url)
      // A 200 with an unexpected shape is a real failure (old/incompatible
      // plugin), not an empty delivery list. Status 0 is the shape-mismatch
      // sentinel consumed by availabilityOf().
      if (!isDeliveriesResponse(body)) {
        throw new ReferenceHttpError('invalid /reference/deliveries payload shape', 0, body)
      }
      return body
    },
    async assetBase64(key) {
      const url = `${base}${ROUTES.asset}${query({ key, encoding: 'base64' })}`
      return await readJson(url) as AssetResponse
    },
    async assetBytes(key) {
      const url = `${base}${ROUTES.asset}${query({ key })}`
      const response = await request(url)
      if (!response.ok) throw new ReferenceHttpError(`asset ${key} failed with ${response.status}`, response.status)
      return response.bytes()
    },
    async ack(ack) {
      const body: Record<string, unknown> = {
        intentId: ack.intentId,
        draftRev: ack.draftRev,
        assetKeys: [...ack.assetKeys],
      }
      if (ack.phase !== undefined) body.phase = ack.phase
      return await writeJson(`${base}${ROUTES.ack}`, body) as AckResponse
    },
    async consume(sessionId, intentId) {
      const result = await writeJson(`${base}${ROUTES.ack}`, { phase: 'consumed', sessionId, intentId }) as { state?: unknown }
      if (result.state !== 'consumed') throw new Error('reference consumption was not persisted')
    },
    async bindSubmission(sessionId, requestId, intentIds) {
      const result = await writeJson(`${base}${ROUTES.ack}`, { phase: 'submitting', sessionId, requestId, intentIds }) as { state?: unknown }
      if (result.state !== 'submitting') throw new Error('reference submission was not recorded')
    },
    async remove(intentId) {
      return await writeJson(`${base}${ROUTES.remove}`, { intentId }) as RemoveResponse
    },
    async reveal(referenceId, partId, navigate) {
      const body: Record<string, unknown> = { referenceId }
      if (partId !== undefined) body.partId = partId
      // The page is moved to the source by the plugin, which owns it.
      if (navigate === true) body.navigate = true
      return await writeJson(`${base}${ROUTES.reveal}`, body) as RevealResultWire
    },
    async exportBundle(format, sessionId) {
      const url = `${base}${ROUTES.export}${query({ format, sessionId })}`
      const response = await request(url)
      if (!response.ok) throw new ReferenceHttpError(`export failed with ${response.status}`, response.status)
      return response.bytes()
    },
    async importBundle(zip) {
      const response = await request(`${base}${ROUTES.import}`, {
        method: 'POST',
        headers: { 'content-type': 'application/zip' },
        body: zip,
      })
      if (!response.ok) throw new ReferenceHttpError(`import failed with ${response.status}`, response.status)
      return response.json()
    },
  }
}

/** Wrap the host's real `fetch` into the injected `RequestLike` shape. */
export function createFetchRequest(
  fetchImpl: (input: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string | Uint8Array
    credentials?: RequestCredentials
    signal?: AbortSignal
  }) => Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    arrayBuffer(): Promise<ArrayBuffer>
  }>,
  signal?: () => AbortSignal | undefined,
): RequestLike {
  return async (url, init) => {
    const activeSignal = signal?.()
    const fetchInit = {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.headers === undefined ? {} : { headers: { ...init.headers } }),
      ...(init?.body === undefined ? {} : { body: init.body }),
      credentials: 'include' as const,
      ...(activeSignal === undefined ? {} : { signal: activeSignal }),
    }
    const response = await fetchImpl(url, fetchInit)
    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json(),
      bytes: async () => new Uint8Array(await response.arrayBuffer()),
    }
  }
}
