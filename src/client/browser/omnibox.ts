/** Manual address-bar intent resolution; strict navigation stays in url.ts. */
import { MAX_BROWSER_URL_LENGTH, parseBrowserAddress } from './url.ts'
import type { BrowserAddressFailure, BrowserTarget } from './url.ts'

/** One search endpoint whose address is stored without template syntax. */
export interface SearchEngine {
  readonly id: string
  readonly label: string
  readonly homeUrl: string
  readonly searchUrl: string
  readonly queryParameter: string
  readonly extraParameters?: Readonly<Record<string, string>>
}

/** Locally shared search selection used to resolve keyword input. */
export interface OmniboxPreferences {
  readonly defaultSearchEngineId: string
  readonly searchEngines: readonly SearchEngine[]
}

/** Why manual input produced no navigation; address failures keep their strict meaning. */
export type OmniboxRefusal = BrowserAddressFailure | 'path' | 'engine-unavailable'

/** A validated HTTP(S) navigation resolved from manual input. */
export interface OmniboxNavigation {
  readonly kind: 'navigate'
  readonly target: BrowserTarget
  /** Whether the typed input already named its scheme or was completed as a host. */
  readonly source: 'explicit' | 'host'
}

/** A validated search-result address built from the selected engine. */
export interface OmniboxSearch {
  readonly kind: 'search'
  readonly engineId: string
  readonly query: string
  readonly target: BrowserTarget
}

/** One action a manual submission can take. */
export type OmniboxAction = OmniboxNavigation | OmniboxSearch

/** Primary action plus the explicit alternative offered for ambiguous input. */
export type OmniboxResolution =
  | { readonly kind: 'resolved'; readonly primary: OmniboxAction; readonly alternative?: OmniboxAction }
  | { readonly kind: 'refused'; readonly reason: OmniboxRefusal }

/** Inputs needed to resolve one address-bar submission. */
export interface OmniboxOptions extends OmniboxPreferences {
  readonly applicationOrigin?: string
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z\d+.-]*):/u
const HOST_AUTHORITY = /^(\[[0-9A-Fa-f:.]+\]|[^:@/?#\[\]\s]+)(?::(\d{1,5}))?$/u
const CREDENTIALS = /^[^\s/?#]*:[^\s/?#]*@/u
const IPV4_OR_VERSION = /^\d+(?:\.\d+)*$/u
const DISABLED_SCHEMES = new Set([
  'about', 'blob', 'chrome', 'data', 'file', 'ftp', 'ftps', 'javascript', 'mailto',
  'tel', 'vbscript', 'view-source', 'ws', 'wss',
])

/**
 * Resolve text typed into the manual address bar into navigation or search.
 * Explicit URLs still pass the strict HTTP(S) admission; no failure falls back
 * to a search engine.
 * @param input - raw address-bar value.
 * @param options - shared search selection and the current application origin.
 * @returns the action to take or the refusal to display.
 */
export function resolveOmniboxInput(input: string, options: OmniboxOptions): OmniboxResolution {
  const classified = classifyInput(input)
  switch (classified.kind) {
    case 'refused':
      return { kind: 'refused', reason: classified.reason }
    case 'keyword':
      return resolveSearch(classified.query, options)
    case 'credentials':
      return strictNavigation(`https://${classified.value}`, 'host', options)
    case 'explicit':
      return strictNavigation(classified.value, 'explicit', options)
    case 'host': {
      const primary = strictNavigation(classified.url, 'host', options)
      if (primary.kind === 'refused') return primary
      const alternative = resolveSearch(classified.query, options)
      return alternative.kind === 'resolved'
        ? { kind: 'resolved', primary: primary.primary, alternative: alternative.primary }
        : primary
    }
  }
}

/**
 * Resolve only the address branch of manual input, for shortcut forms that must
 * not turn ordinary keywords into an implicit search.
 * @param input - user-supplied website address.
 * @param applicationOrigin - current DSH origin, refused by strict admission.
 * @returns a validated target or the refusal to display.
 */
export function resolveAddressInput(input: string, applicationOrigin?: string):
  | { readonly ok: true; readonly target: BrowserTarget }
  | { readonly ok: false; readonly reason: OmniboxRefusal } {
  const classified = classifyInput(input)
  switch (classified.kind) {
    case 'refused': return { ok: false, reason: classified.reason }
    case 'keyword': return { ok: false, reason: 'invalid' }
    case 'credentials': return addressTarget(`https://${classified.value}`, applicationOrigin)
    case 'explicit': return addressTarget(classified.value, applicationOrigin)
    case 'host': return addressTarget(classified.url, applicationOrigin)
  }
}

type ClassifiedInput =
  | { readonly kind: 'refused'; readonly reason: OmniboxRefusal }
  | { readonly kind: 'keyword'; readonly query: string }
  | { readonly kind: 'credentials'; readonly value: string }
  | { readonly kind: 'explicit'; readonly value: string }
  | { readonly kind: 'host'; readonly url: string; readonly query: string }

function classifyInput(input: string): ClassifiedInput {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'refused', reason: 'empty' }
  if (trimmed.length > MAX_BROWSER_URL_LENGTH) return { kind: 'refused', reason: 'invalid' }
  if (CONTROL_CHARACTER.test(trimmed)) return { kind: 'refused', reason: 'invalid' }
  // Local paths belong to document and resource providers, never to an address or a search.
  if (/^[A-Za-z]:[\\/]/u.test(trimmed) || trimmed.startsWith('\\\\')) {
    return { kind: 'refused', reason: 'path' }
  }
  // A single leading slash without a host is a POSIX absolute path; a lone
  // slash-prefixed word such as "/help" can still be an ordinary search.
  if (/^\/(?!\/)(?:[^/\s]+\/)+[^/\s]*$/u.test(trimmed)) {
    return { kind: 'refused', reason: 'path' }
  }
  const scheme = SCHEME_PREFIX.exec(trimmed)?.[1]?.toLowerCase()
  if (scheme === 'http' || scheme === 'https') return { kind: 'explicit', value: trimmed }
  if (scheme !== undefined && (DISABLED_SCHEMES.has(scheme) || trimmed.includes('://'))) {
    return { kind: 'refused', reason: 'protocol' }
  }
  // Scheme-less userinfo still names a URL; strict admission reports the credential refusal.
  if (CREDENTIALS.test(trimmed)) return { kind: 'credentials', value: trimmed }
  const normalized = normalizeHostInput(trimmed)
  return normalized === undefined
    ? { kind: 'keyword', query: trimmed }
    : { kind: 'host', url: normalized, query: trimmed }
}

function addressTarget(value: string, applicationOrigin?: string):
  | { readonly ok: true; readonly target: BrowserTarget }
  | { readonly ok: false; readonly reason: OmniboxRefusal } {
  const parsed = parseBrowserAddress(value, applicationOrigin)
  return parsed.ok ? { ok: true, target: parsed.target } : { ok: false, reason: parsed.reason }
}

/**
 * Build one engine's result address.
 * @param engine - validated search endpoint.
 * @param query - keyword text encoded once through URLSearchParams.
 * @param applicationOrigin - current DSH origin, refused by strict admission.
 * @returns the target, or undefined when the engine cannot be used safely.
 */
export function buildSearchTarget(engine: SearchEngine, query: string,
  applicationOrigin?: string): BrowserTarget | undefined {
  if (engine.queryParameter === '') return undefined
  let url: URL
  try { url = new URL(engine.searchUrl) } catch { return undefined }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  try {
    for (const [name, value] of Object.entries(engine.extraParameters ?? {})) url.searchParams.set(name, value)
    url.searchParams.set(engine.queryParameter, query)
  } catch { return undefined }
  const parsed = parseBrowserAddress(url.href, applicationOrigin)
  if (!parsed.ok) return undefined
  return { ...parsed.target, title: query }
}

function strictNavigation(value: string, source: 'explicit' | 'host',
  options: OmniboxOptions): OmniboxResolution {
  const parsed = parseBrowserAddress(value, options.applicationOrigin)
  if (!parsed.ok) return { kind: 'refused', reason: parsed.reason }
  return { kind: 'resolved', primary: { kind: 'navigate', target: parsed.target, source } }
}

function resolveSearch(query: string, options: OmniboxOptions): OmniboxResolution {
  const engine = options.searchEngines.find(candidate => candidate.id === options.defaultSearchEngineId)
  if (engine === undefined) return { kind: 'refused', reason: 'engine-unavailable' }
  const target = buildSearchTarget(engine, query, options.applicationOrigin)
  if (target === undefined) return { kind: 'refused', reason: 'engine-unavailable' }
  return { kind: 'resolved', primary: { kind: 'search', engineId: engine.id, query, target } }
}

/**
 * Complete host-like input into an address; keyword-like input returns undefined.
 * Local loopback services use HTTP, public hosts HTTPS, and a single intranet
 * label needs an explicit scheme unless it names a port.
 */
function normalizeHostInput(input: string): string | undefined {
  if (/\s/u.test(input)) return undefined
  const protocolRelative = input.startsWith('//')
  const value = protocolRelative ? input.slice(2) : input
  if (value === '') return undefined
  const boundary = value.search(/[/?#]/u)
  const authority = boundary === -1 ? value : value.slice(0, boundary)
  const suffix = boundary === -1 ? '' : value.slice(boundary)
  if (authority === '') return undefined
  const match = HOST_AUTHORITY.exec(authority)
  if (match === null) return undefined
  const host = match[1]
  if (host === undefined) return undefined
  const port = match[2]
  const ipv6 = host.startsWith('[')
  const bare = ipv6 ? host.slice(1, -1) : host
  const local = isLoopbackHost(bare)
  if (!local && !ipv6) {
    if (IPV4_OR_VERSION.test(bare)) {
      const octets = bare.split('.')
      // A dotted number without exactly four in-range octets is a version, not a host.
      if (octets.length !== 4 || octets.some(octet => Number(octet) > 255)) return undefined
    } else if (!bare.includes('.')) {
      if (port === undefined) return undefined
      // A single intranet label with an explicit port is an HTTP service.
      return validHttpUrl(`http://${authority}${suffix}`) ? `http://${authority}${suffix}` : undefined
    }
  }
  const completed = `${local ? 'http' : 'https'}://${authority}${suffix}`
  return validHttpUrl(completed) ? completed : undefined
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase()
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (IPV4_OR_VERSION.test(normalized) && normalized.includes('.')) {
    const octets = normalized.split('.')
    if (octets.length === 4 && octets.every(octet => Number(octet) <= 255)) return octets[0] === '127'
  }
  return normalized === '::1' || normalized === '0:0:0:0:0:0:0:1'
}

function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
  } catch { return false }
}
