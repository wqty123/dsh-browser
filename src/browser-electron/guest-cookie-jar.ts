/** Host-isolated cookies with path, expiry and Secure matching for guest requests. */
interface StoredCookie {
  readonly host: string
  readonly name: string
  readonly value: string
  readonly path: string
  readonly secure: boolean
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

  setCookies(target: URL, values: readonly string[]): void {
    const now = Date.now()
    for (const raw of values) {
      const [pair = '', ...attributes] = raw.split(';').map(part => part.trim())
      const index = pair.indexOf('=')
      if (index <= 0) continue
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      if (!/^[!#$%&'*+\-.^_`|~\da-z]+$/iu.test(name) || /[\x00-\x20\x7f;,]/u.test(value)) continue
      let path = defaultPath(target.pathname), secure = false, domain: string | undefined
      let expires: number | undefined, maxAge: number | undefined
      for (const attribute of attributes) {
        const equals = attribute.indexOf('=')
        const key = (equals === -1 ? attribute : attribute.slice(0, equals)).trim().toLowerCase()
        const content = equals === -1 ? '' : attribute.slice(equals + 1).trim()
        if (key === 'domain' && content !== '') domain = content.replace(/^\./u, '').toLowerCase()
        else if (key === 'path' && content.startsWith('/')) path = content
        else if (key === 'secure') secure = true
        else if (key === 'max-age' && /^-?\d+$/u.test(content) && Number.isFinite(Number(content))) maxAge = Number(content)
        else if (key === 'expires' && Number.isFinite(Date.parse(content))) expires = Date.parse(content)
      }
      if (domain !== undefined && target.hostname !== domain && !target.hostname.endsWith('.' + domain)) continue
      if (secure && target.protocol !== 'https:') continue
      if (name.startsWith('__Secure-') && !secure) continue
      if (name.startsWith('__Host-') && (!secure || domain !== undefined || path !== '/')) continue
      // Without a public-suffix list, never widen the existing host/port isolation for Domain cookies.
      const cookie: StoredCookie = { host: target.host, name, value, path, secure,
        expiresAt: maxAge === undefined ? expires : maxAge <= 0 ? 0 : now + maxAge * 1000 }
      const key = cookie.host + '\0' + path + '\0' + name
      const existing = this.store.get(key)
      if (existing?.secure && target.protocol !== 'https:') continue
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) this.store.delete(key)
      else this.store.set(key, cookie)
    }
  }

  getCookieHeader(target: URL): string | undefined {
    const now = Date.now()
    const matched: StoredCookie[] = []
    for (const [key, cookie] of this.store) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.store.delete(key)
        continue
      }
      if (cookie.host !== target.host || (cookie.secure && target.protocol !== 'https:')
        || !pathMatches(target.pathname, cookie.path)) continue
      matched.push(cookie)
    }
    matched.sort((a, b) => b.path.length - a.path.length)
    return matched.length === 0 ? undefined : matched.map(cookie => cookie.name + '=' + cookie.value).join('; ')
  }
}
