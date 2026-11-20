/** Host-isolated cookies with path, expiry, Secure and HttpOnly matching for guest requests. */
export interface StoredCookie {
  readonly host: string
  readonly name: string
  readonly value: string
  readonly path: string
  readonly secure: boolean
  readonly httpOnly?: boolean
  readonly expiresAt?: number
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

  setCookies(target: URL, values: readonly string[], options?: { readonly fromDocument?: boolean }): void {
    const now = Date.now()
    for (const raw of values) {
      const [pair = '', ...attributes] = raw.split(';').map(part => part.trim())
      const index = pair.indexOf('=')
      if (index <= 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (!/^[!#$%&'*+\-.^_`|~\da-z]+$/iu.test(name) || /[\x00-\x20\x7f;,]/u.test(value)) continue
      let path = defaultPath(target.pathname), secure = false, httpOnly = false, domain: string | undefined
      let expires: number | undefined, maxAge: number | undefined
      for (const attribute of attributes) {
        const equals = attribute.indexOf('=')
        const key = (equals === -1 ? attribute : attribute.slice(0, equals)).trim().toLowerCase()
        const content = equals === -1 ? '' : attribute.slice(equals + 1).trim()
        if (key === 'domain' && content !== '') domain = content.replace(/^\./u, '').toLowerCase()
        else if (key === 'path' && content.startsWith('/')) path = content
        else if (key === 'secure') secure = true
        else if (key === 'httponly') httpOnly = true
        else if (key === 'max-age' && /^-?\d+$/u.test(content) && Number.isFinite(Number(content))) maxAge = Number(content)
        else if (key === 'expires' && Number.isFinite(Date.parse(content))) expires = Date.parse(content)
      }
      if (domain !== undefined && target.hostname !== domain && !target.hostname.endsWith('.' + domain)) continue
      if (secure && target.protocol !== 'https:') continue
      if (name.startsWith('__Secure-') && !secure) continue
      if (name.startsWith('__Host-') && (!secure || domain !== undefined || path !== '/')) continue
      // Without a public-suffix list, never widen the existing host/port isolation for Domain cookies.
      const cookie: StoredCookie = {
        host: target.host,
        name,
        value,
        path,
        secure,
        httpOnly: options?.fromDocument === true ? false : httpOnly,
        expiresAt: maxAge === undefined ? expires : maxAge <= 0 ? 0 : now + maxAge * 1000,
      }
      const key = cookie.host + '\0' + path + '\0' + name
      const existing = this.store.get(key)
      if (options?.fromDocument === true && existing?.httpOnly === true) continue
      if (existing?.secure && target.protocol !== 'https:') continue
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) this.store.delete(key)
      else this.store.set(key, cookie)
    }
  }

  getCookieHeader(target: URL, options?: { readonly includeHttpOnly?: boolean }): string | undefined {
    const matched = this.exportCookies(target, options)
    return matched.length === 0 ? undefined : matched.map(cookie => cookie.name + '=' + cookie.value).join('; ')
  }

  /** Export matching cookies (used by HTTP requests, document.cookie seeding, and CDP sync). */
  exportCookies(target: URL, options?: { readonly includeHttpOnly?: boolean }): StoredCookie[] {
    const now = Date.now()
    const includeHttpOnly = options?.includeHttpOnly !== false
    const matched: StoredCookie[] = []
    for (const [key, cookie] of this.store) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.store.delete(key)
        continue
      }
      if (!includeHttpOnly && cookie.httpOnly === true) continue
      if (cookie.host !== target.host || (cookie.secure && target.protocol !== 'https:')
        || !pathMatches(target.pathname, cookie.path)) continue
      matched.push(cookie)
    }
    matched.sort((a, b) => b.path.length - a.path.length)
    return matched
  }

  /** Import cookies captured from the background real-browser engine via CDP. */
  importCookies(cookies: readonly StoredCookie[]): void {
    const now = Date.now()
    for (const cookie of cookies) {
      const key = cookie.host + '\0' + cookie.path + '\0' + cookie.name
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) this.store.delete(key)
      else this.store.set(key, cookie)
    }
  }
}
