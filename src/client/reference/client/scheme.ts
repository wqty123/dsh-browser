/**
 * Canonical `dsh-browser-ref:` URI codec for reply-side web references (§15).
 *
 * The scheme is deliberately self-contained: it does NOT import the existing
 * `session-reference` codec, so this additive package can be adopted or dropped
 * independently. Wire form: `dsh-browser-ref:<referenceId>[/<partId>]`, where
 * each id is `encodeURIComponent`-encoded. Decoding is strict: non-canonical,
 * empty, over-long, or control-bearing ids are rejected rather than repaired.
 */

/** Internal scheme reserved for browser web references (§2.3). */
export const BROWSER_REF_SCHEME = 'dsh-browser-ref:'

/** Maximum accepted length of a single decoded id. */
export const MAX_BROWSER_REF_ID_LENGTH = 128
/** Maximum accepted length of a whole canonical URI. */
export const MAX_BROWSER_REF_URI_LENGTH = 512

/** A structurally valid browser reference address. */
export interface BrowserRefUri {
  readonly referenceId: string
  readonly partId?: string
}

/** Raised for every malformed or non-canonical browser reference URI. */
export class BrowserRefUriError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'BrowserRefUriError'
  }
}

function isDecodedId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_BROWSER_REF_ID_LENGTH) return false
  // Reject control characters only. Other characters (including '/', spaces,
  // '#', non-ASCII) are valid once percent-encoded; the canonical round-trip
  // check below is what rejects raw/non-normalized spellings of those bytes.
  return !/[\u0000-\u001f\u007f]/u.test(value)
}

function assertId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isDecodedId(value)) {
    throw new BrowserRefUriError(`invalid ${field}: expected a non-empty id without separators`)
  }
  return value
}

/** Encode a structured browser reference into its canonical URI. */
export function encodeBrowserRefUri(ref: BrowserRefUri): string {
  const referenceId = assertId(ref.referenceId, 'referenceId')
  const segments = [encodeURIComponent(referenceId)]
  if (ref.partId !== undefined) {
    segments.push(encodeURIComponent(assertId(ref.partId, 'partId')))
  }
  const uri = `${BROWSER_REF_SCHEME}${segments.join('/')}`
  if (uri.length > MAX_BROWSER_REF_URI_LENGTH) {
    throw new BrowserRefUriError('encoded browser reference URI is too long')
  }
  return uri
}

function decodeSegments(segments: readonly string[]): string[] {
  try {
    return segments.map(segment => decodeURIComponent(segment))
  } catch (cause: unknown) {
    throw new BrowserRefUriError('malformed percent-encoding', { cause })
  }
}

/** Decode and canonicalize one browser reference URI. Throws on any invalid input. */
export function decodeBrowserRefUri(uri: unknown): BrowserRefUri {
  if (typeof uri !== 'string' || uri.length > MAX_BROWSER_REF_URI_LENGTH) {
    throw new BrowserRefUriError('browser reference URI must be a bounded string')
  }
  if (!uri.startsWith(BROWSER_REF_SCHEME)) {
    throw new BrowserRefUriError('missing dsh-browser-ref: scheme')
  }
  const payload = uri.slice(BROWSER_REF_SCHEME.length)
  if (payload.length === 0) throw new BrowserRefUriError('empty browser reference payload')
  const segments = payload.split('/')
  if (segments.length > 2) throw new BrowserRefUriError('too many path segments')
  const decoded = decodeSegments(segments)
  const referenceId = assertId(decoded[0], 'referenceId')
  const partId = decoded.length === 2 ? assertId(decoded[1], 'partId') : undefined
  const result: BrowserRefUri = partId === undefined ? { referenceId } : { referenceId, partId }
  // Canonical round-trip: reject hand-written / non-normalized spellings.
  if (encodeBrowserRefUri(result) !== uri) {
    throw new BrowserRefUriError('browser reference URI is not canonical')
  }
  return result
}

/** Non-throwing decode. Returns undefined for any invalid input. */
export function parseBrowserRefUri(uri: unknown): BrowserRefUri | undefined {
  try {
    return decodeBrowserRefUri(uri)
  } catch {
    return undefined
  }
}

/** True only for a canonical `dsh-browser-ref:` URI (ordinary URLs are false). */
export function isBrowserRefUri(value: unknown): boolean {
  return parseBrowserRefUri(value) !== undefined
}

export type BrowserRefAvailability = 'available' | 'unknown-reference' | 'invalid'

export interface BrowserRefResolution {
  readonly status: BrowserRefAvailability
  readonly uri?: string
  readonly referenceId?: string
  readonly partId?: string
}
