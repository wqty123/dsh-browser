import { getDomain } from 'tldts'

/** Origin-isolated cookies with path, expiry and Secure matching for guest requests. */
export interface StoredCookie {
  readonly origin: string
  readonly name: string
  readonly value: string
  readonly path: string
  readonly secure: boolean
  readonly httpOnly?: boolean
  readonly sameSite?: 'strict' | 'lax' | 'none'
  readonly expiresAt?: number
}

function trimCookieWhitespace(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/gu, '')
}

function validCookiePair(name: string, value: string): boolean {
  return name.length + value.length > 0 && name.length + value.length <= 4096
    && !/[^\x20-\xff]|[\x7f;=]/u.test(name)
    && !/[^\x20-\xff]|[\x7f;]/u.test(value)
}

export function normalizeStoredCookie(input: unknown): StoredCookie | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const c = input as Record<string, unknown>
  if (typeof c.origin !== 'string' || typeof c.name !== 'string' || typeof c.value !== 'string'
    || typeof c.path !== 'string' || typeof c.secure !== 'boolean'
    || (c.httpOnly !== undefined && typeof c.httpOnly !== 'boolean')
    || (c.sameSite !== undefined && !['strict', 'lax', 'none'].includes(String(c.sameSite)))
    || (c.expiresAt !== undefined && (typeof c.expiresAt !== 'number' || !Number.isFinite(c.expiresAt)))
    || !c.path.startsWith('/') || /[\x00-\x1f\x7f]/u.test(c.path)) return undefined
  const name = trimCookieWhitespace(c.name), value = trimCookieWhitespace(c.value)
  if (!validCookiePair(name, value) || (name === '' && /^(?:__Secure-|__Host-|__Http-)/iu.test(value))) return undefined
  try {
    const url = new URL(c.origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || (c.secure && url.protocol !== 'https:')
      || (/^__Secure-/iu.test(name) && !c.secure)
      || (/^__Host-/iu.test(name) && (!c.secure || c.path !== '/'))
      || (/^__(?:Host-)?Http-/iu.test(name) && (!c.secure || !c.httpOnly))
      || (c.sameSite === 'none' && !c.secure)) return undefined
    return { origin: url.origin, name, value, path: c.path, secure: c.secure,
      httpOnly: c.httpOnly !== false, sameSite: c.sameSite as StoredCookie['sameSite'],
      expiresAt: c.expiresAt as number | undefined }
  } catch { return undefined }
}

function defaultPath(pathname: string): string {
  const lastSlash = pathname.lastIndexOf('/')
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash)
}

function pathMatches(pathname: string, path: string): boolean {
  return pathname === path || (pathname.startsWith(path) && (path.endsWith('/') || pathname[path.length] === '/'))
}

export class GuestCookieJar {
  private readonly store = new Map<string, StoredCookie>()

  constructor(private readonly changed?: (cookies: readonly StoredCookie[]) => void, saved: readonly StoredCookie[] = []) {
    for (const value of saved) {
      const cookie = normalizeStoredCookie(value)
      if (cookie !== undefined && (cookie.expiresAt === undefined || cookie.expiresAt > Date.now())) {
        this.store.set(cookie.origin + '\0' + cookie.path + '\0' + cookie.name, cookie)
      }
    }
  }

  private save(): void {
    this.changed?.([...this.store.values()].filter(cookie => cookie.expiresAt === undefined || cookie.expiresAt > Date.now()))
  }

  setCookies(target: URL, values: readonly string[], script = false): void {
    const now = Date.now()
    for (const raw of values) {
      if (/[\x00-\x08\x0a-\x1f\x7f]/u.test(raw)) continue
      const [pair = '', ...attributes] = raw.split(';').map(trimCookieWhitespace)
      const index = pair.indexOf('=')
      const name = index === -1 ? '' : trimCookieWhitespace(pair.slice(0, index))
      const value = trimCookieWhitespace(index === -1 ? pair : pair.slice(index + 1))
      if (!validCookiePair(name, value)) continue
      let path = defaultPath(target.pathname), secure = false, httpOnly = false, domain: string | undefined
      let sameSite: StoredCookie['sameSite'], explicitRoot = false
      let expires: number | undefined, maxAge: number | undefined
      let validAttributes = true
      for (const attribute of attributes) {
        const equals = attribute.indexOf('=')
        const key = trimCookieWhitespace(equals === -1 ? attribute : attribute.slice(0, equals)).toLowerCase()
        const content = equals === -1 ? '' : trimCookieWhitespace(attribute.slice(equals + 1))
        if (/[\x00-\x1f\x7f]/u.test(key + content)) { validAttributes = false; break }
        if (key === 'domain' && content !== '') domain = content.replace(/^\./u, '').toLowerCase()
        else if (key === 'path') { path = content.startsWith('/') ? content : defaultPath(target.pathname); explicitRoot = content === '/' }
        else if (key === 'secure') secure = true
        else if (key === 'httponly') httpOnly = true
        else if (key === 'samesite') sameSite = ['strict', 'lax', 'none'].includes(content.toLowerCase()) ? content.toLowerCase() as StoredCookie['sameSite'] : undefined
        else if (key === 'max-age' && /^-?\d+$/u.test(content)) maxAge = Math.min(Number(content), 400 * 86400)
        else if (key === 'expires' && Number.isFinite(Date.parse(content))) expires = Date.parse(content)
      }
      if (!validAttributes || (domain !== undefined && target.hostname !== domain && !target.hostname.endsWith('.' + domain))) continue
      if (domain !== undefined && domain !== target.hostname && getDomain(domain, { allowPrivateDomains: true }) === null) continue
      if (script && httpOnly) continue
      if (secure && target.protocol !== 'https:') continue
      if (/^__Secure-/iu.test(name) && !secure) continue
      if (/^__Host-/iu.test(name) && (!secure || domain !== undefined || !explicitRoot)) continue
      if (/^__(?:Host-)?Http-/iu.test(name) && (!secure || !httpOnly)) continue
      const cookie = normalizeStoredCookie({ origin: target.origin, name, value, path, secure, httpOnly, sameSite,
        expiresAt: maxAge === undefined ? expires : maxAge <= 0 ? 0 : now + maxAge * 1000 })
      if (cookie === undefined) continue
      const key = cookie.origin + '\0' + path + '\0' + name
      const existing = this.store.get(key)
      if (script && existing?.httpOnly && (existing.expiresAt === undefined || existing.expiresAt > now)) continue
      if (existing?.secure && target.protocol !== 'https:') continue
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) this.store.delete(key)
      else this.store.set(key, cookie)
    }
    if (values.length > 0) this.save()
  }

  getDocumentCookie(target: URL): string { return this.getCookieHeader(target, true) ?? '' }

  setDocumentCookie(target: URL, value: string): void { this.setCookies(target, [value], true) }

  getCookieHeader(target: URL, script = false, context?: { readonly site: URL; readonly topLevel: boolean; readonly method: string }): string | undefined {
    const now = Date.now()
    const matched: StoredCookie[] = []
    for (const [key, value] of this.store) {
      const cookie = normalizeStoredCookie(value)
      if (cookie === undefined || (cookie.expiresAt !== undefined && cookie.expiresAt <= now)) {
        this.store.delete(key)
        continue
      }
      if (cookie.origin !== target.origin || (cookie.secure && target.protocol !== 'https:')
        || (script && cookie.httpOnly)
        || !pathMatches(target.pathname, cookie.path)) continue
      if (!script && context !== undefined) {
        const site = (url: URL): string => url.protocol + '//' + (getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname)
        const crossSite = site(context.site) !== site(target)
        if (crossSite && cookie.sameSite !== 'none'
          && (cookie.sameSite === 'strict' || !context.topLevel || !['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(context.method))) continue
      }
      matched.push(cookie)
    }
    matched.sort((a, b) => b.path.length - a.path.length)
    return matched.length === 0 ? undefined : matched.map(cookie => cookie.name === '' ? cookie.value : cookie.name + '=' + cookie.value).join('; ')
  }
}
