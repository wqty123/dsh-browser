/** Scoped native leases adapted to the existing bridge's page operations, never numeric ids. */
export function nativeGuestRegistry(capability) {
  const guests = new Map()
  const snapshot = () => capability()?.snapshot() ?? []
  const get = lease => {
    const entry = snapshot().find(entry => entry.lease === lease)
    if (entry === undefined) { guests.delete(lease); return undefined }
    let guest = guests.get(lease)
    if (guest !== undefined) return guest
    const current = () => snapshot().find(value => value.lease === lease && value.scope === entry.scope)
    const command = (method, params) => capability().command(entry.scope, lease, method, params)
    guest = {
      id: lease,
      scope: entry.scope,
      getURL: () => current()?.url ?? '',
      getTitle: () => current()?.title ?? '',
      getType: () => 'native',
      isDestroyed: () => current() === undefined,
      debugger: { isAttached: () => true, sendCommand: command },
      session: { fetch: (url, options) => capability().fetch(entry.scope, lease, url, options.signal) },
    }
    guests.set(lease, guest)
    return guest
  }
  return {
    get,
    ids(owner) {
      return snapshot().filter(entry => {
        const prefix = 'dsh-tab:v1:'
        if (!entry.scope.startsWith(prefix)) return false
        try { return JSON.parse(decodeURIComponent(entry.scope.slice(prefix.length)))[0] === owner }
        catch (_error) { return false }
      }).map(entry => entry.lease)
    },
    async releaseAll() {
      await Promise.all(snapshot().map(entry => capability().release(entry.scope, entry.lease)))
      guests.clear()
    },
    state(lease) { return snapshot().find(entry => entry.lease === lease)?.state },
  }
}
