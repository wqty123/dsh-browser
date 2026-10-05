/**
 * Desktop-sidebar browser host: drive the page the desktop shell shows in its
 * sidebar, instead of spawning a second, parallel Electron window.
 *
 * WHY
 * The plugin runs inside the desktop's Node-mode host, where there is no Electron
 * API — which is why it self-hosts a whole browser today. The shell, however, can
 * own views, and its sidebar already displays real web pages. This host borrows
 * that page over the shell's bridge (see apps/desktop/bridge/plugin-browser-bridge.js),
 * so the agent and the human end up on ONE page instead of two.
 *
 * CONTRACT
 * It implements the same `ElectronBrowserViewHost` seam the self-hosted host does,
 * so the provider, the tools, browsing history, the synthetic cursor and the
 * teardown rules are all unchanged: only the carrier differs. Everything is
 * lazily materialized — a fresh shell has no sidebar guest until something asks
 * for a page, and the bridge creates one on demand.
 *
 * FALLBACK
 * `discover()` returns undefined whenever the shell offers no usable bridge
 * (older desktop build, plain `dsh web`, bridge not started), and the entry point
 * then keeps the self-hosted Electron it has always used.
 * @module dsh-browser/browser-electron/desktop-bridge-host
 */

import { BridgeConnection, type BridgeEndpoint } from './bridge-connection.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js'
import type { BrowserUserAction } from './provider.js'


/** Absolute path of the endpoint file the shell writes. */
export function bridgeEndpointPath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-builtin-browser-bridge.json')
}

/**
 * Whether a command failed because the page is no longer there (as opposed to
 * failing on its own merits). Only these are worth retrying on a fresh guest.
 * @param error - the failure to classify.
 */
function isGuestGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /guest \d+ is not available|sidebar unavailable|did not create a browser guest/i.test(message)
}

/**
 * The desktop sidebar, presented as a browser view host.
 *
 * One sidebar exists per shell window, so every view this host hands out refers
 * to the same guest: the provider keeps its tab bookkeeping, and the tabs simply
 * share the visible page. That is the intended behaviour for this carrier — the
 * point is a single page both parties can see.
 */
export class DesktopBridgeViewHost implements ElectronBrowserViewHost {
  private readonly connection: BridgeConnection
  private readonly views = new Map<string, number>()
  /**
   * This process's identity with the bridge, for tab ownership.
   *
   * Every DSH session is its own plugin process, and the sidebar is one surface they all share.
   * A session can only see its own `views` map, so before the bridge kept a ledger it adopted
   * whichever tab it found — including one another session had opened, which is how a URL from
   * one session appeared in another's sidebar. The id is per process, so two sessions never
   * collide and one session's tabs are never handed to another; it is deliberately not the DSH
   * session id, which this layer has no access to and does not need.
   */
  private readonly owner = randomUUID()
  /**
   * Guests whose view is gone but whose page may still be open in the sidebar.
   *
   * The provider destroys its view handles before it asks for a release, so the
   * mapping is dropped by then — keeping the guest ids here is what lets us close
   * only our own tabs when several sessions are running (requirements §4: each
   * session gets its own page).
   */
  private readonly orphaned = new Set<number>()
  /**
   * Registered by the provider, and deliberately never invoked on this carrier.
   *
   * The sidebar is the shell's own interface: a human clicking inside that page is an
   * event the shell owns, and the bridge exposes no operation that reports it. The
   * handler is stored anyway so the interface contract holds (a caller may register
   * one and must not be surprised) and so a future bridge operation can deliver it
   * without changing the provider. Consequently no user-action event is emitted while
   * the desktop sidebar is the carrier — by design, not by omission.
   */
  private userActionHandler: ((action: BrowserUserAction) => void) | undefined

  /**
   * @param endpoint - the shell's published bridge endpoint.
   */
  private constructor(endpoint: BridgeEndpoint) {
    this.connection = new BridgeConnection(endpoint)
  }

  /**
   * Find a usable desktop bridge, if this surface has one.
   *
   * A stale endpoint (a shell that already exited, leaving its file behind) is
   * rejected here rather than surfacing later as a mysterious ECONNREFUSED: the
   * caller falls back to self-hosting, which always works.
   * @returns the host, or undefined when no bridge is available.
   */
  static async discover(): Promise<DesktopBridgeViewHost | undefined> {
    let endpoint: BridgeEndpoint
    try {
      const raw = JSON.parse(readFileSync(bridgeEndpointPath(), 'utf8')) as Partial<BridgeEndpoint>
      if (typeof raw.port !== 'number' || typeof raw.token !== 'string' || typeof raw.pid !== 'number') return undefined
      endpoint = { port: raw.port, token: raw.token, pid: raw.pid, ...raw.updatedAt !== undefined ? { updatedAt: raw.updatedAt } : {} }
    } catch {
      return undefined
    }
    try {
      // A throwaway connection for discovery: the adopted host opens its own, and a
      // rejected endpoint must not leave a socket behind.
      const probe = new BridgeConnection(endpoint)
      try {
        const answer = await probe.call({ op: 'list' }, 5_000)
        return answer.ok === true ? new DesktopBridgeViewHost(endpoint) : undefined
      } finally {
        probe.close()
      }
    } catch {
      // Dead endpoint or an older bridge: self-hosting remains the answer.
      return undefined
    }
  }

  /** Whether this host can back views: the bridge already answered `list`. */
  available(): boolean {
    return true
  }

  /**
   * The guest id backing a view, materialized on first use.
   *
   * The sidebar browser is itself a multi-tab surface, so each view gets its own
   * tab's guest: the provider's tab bookkeeping then maps onto real tabs the human
   * can see and switch between. Two rules keep that honest:
   *   - a cached guest is used as-is: probing it first cost a round-trip on every
   *     command, so liveness is established by the command failing instead;
   *   - a fresh view takes an unclaimed guest, growing the tab strip only when
   *     every existing guest is already spoken for.
   * @param viewId - the view whose guest is wanted.
   * @param url - address to use when a sidebar browser has to be opened first.
   */
  private async guestFor(viewId: string, url?: string): Promise<number> {
    const existing = this.views.get(viewId)
    // No liveness check here: verifying the cached guest cost a round-trip on every
    // command. A guest that has gone away is detected by the command itself failing,
    // and `createView`'s sendCommand then discards the cache and calls back in here.
    if (existing !== undefined) return existing

    // The browser tab must exist before its strip can be extended: `ensureSidebar`
    // opens the sidebar (and, on a fresh shell, materializes the first guest).
    const sidebar = await this.connection.call({
      op: 'ensureSidebar',
      owner: this.owner,
      ...url !== undefined ? { url } : {},
    })
    if (sidebar.ok !== true) throw new Error(`dsh-builtin-browser: sidebar unavailable (${String(sidebar.error)})`)

    const wanted = this.views.size + 1
    // Ask for the tabs THIS session owns, not the ones the sidebar happens to hold. The bridge
    // keeps the cross-session ledger — a session cannot see another's view map, so without this
    // it adopted whatever tab it found and drove someone else's page.
    let ids = await this.guestIds(Math.max(1, wanted))
    const taken = new Set(this.views.values())
    let free = ids.find(id => !taken.has(id))
    if (free === undefined) {
      // Every tab this session holds is already driving something: the strip has to grow.
      ids = await this.guestIds(ids.length + 1)
      free = ids.find(id => !taken.has(id))
    }
    if (free === undefined) throw new Error('dsh-builtin-browser: the sidebar reported no free browser tab')
    this.views.set(viewId, free)
    return free
  }

  /**
   * Ask for at least `count` tabs belonging to this session and return their guest ids.
   * @param count - minimum number of tabs.
   */
  private async guestIds(count: number): Promise<number[]> {
    const answer = await this.connection.call({ op: 'ensureTabs', count, owner: this.owner })
    if (answer.ok !== true) throw new Error(`dsh-builtin-browser: could not open a sidebar tab (${String(answer.error)})`)
    const ids = Array.isArray(answer.ids) ? answer.ids.map(Number).filter(Number.isFinite) : []
    if (ids.length === 0) throw new Error('dsh-builtin-browser: the sidebar reported no browser tabs')
    return ids
  }

  createView(): ElectronViewHandle {
    const viewId = randomUUID()
    const navigateUrl = (method: string, params?: Record<string, unknown>): string | undefined =>
      method === 'Page.navigate' ? String((params as { url?: unknown })?.url ?? '') : undefined
    const run = async (guest: number, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const answer = await this.connection.call({ op: 'cdp', id: guest, method, params })
      if (answer.ok !== true) throw new Error(`dsh-builtin-browser: sidebar command failed: ${String(answer.error)}`)
      // The bridge forwards whatever CDP answered; the seam expects an object.
      return (answer.result ?? {}) as Record<string, unknown>
    }
    return {
      id: viewId,
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        // No liveness probe up front. Checking first cost a whole round-trip on
        // every command; instead the command runs and its failure is what triggers
        // recovery. Only a genuinely missing guest is retried, so a real error (a
        // bad selector, a timeout) still surfaces unchanged.
        const url = navigateUrl(method, params)
        let guest = await this.guestFor(viewId, url)
        try {
          return await run(guest, method, params)
        } catch (error) {
          if (!isGuestGone(error)) throw error
          // The human closed the tab: the page is gone, so take a fresh one and
          // replay the command once. This is the "closing the interface ends the
          // session" rule, now paid for only when it actually happens.
          this.views.delete(viewId)
          guest = await this.guestFor(viewId, url)
          return await run(guest, method, params)
        }
      },
    }
  }

  destroyView(handle: ElectronViewHandle): void {
    const guest = this.views.get(handle.id)
    if (guest !== undefined) {
      // Remember it: the page outlives our handle, and a later release must be able
      // to name exactly the tabs this plugin opened.
      this.orphaned.add(guest)
      this.views.delete(handle.id)
    }
  }

  /**
   * Bring this view's tab to the front in the sidebar.
   *
   * This used to be empty, on the reasoning that the sidebar is already on screen so there is
   * nothing to show. That confused "the sidebar is visible" with "this page is the one being
   * looked at": opening a page left it behind whatever the human had in front, which is issue
   * #23. The other two carriers both do this — the self-hosted window re-adds the view and the
   * system browser calls `Page.bringToFront` — so this carrier was the odd one out.
   *
   * Best-effort by design: the tab strip belongs to the shell's renderer, and failing to raise
   * it must not fail the navigation that has already happened.
   * @param handle - the view to bring forward.
   */
  showView(handle: ElectronViewHandle): void {
    void this.connection.call({ op: 'showTab', viewId: Number(handle.id) }, 5_000).catch(() => undefined)
  }




  onUserAction(handler: (action: BrowserUserAction) => void): void {
    this.userActionHandler = handler
  }


  /**
   * Release the sidebar's browser pages (requirements §3, `ui.closeWithSession`).
   *
   * Destroying our own view handles is not enough on this carrier: the sidebar
   * belongs to the shell and would happily keep the page (and its renderer) alive.
   * Closing the tabs is what actually ends the page — and only the page: cookies
   * live in the partition, history on disk, so both survive.
   * @returns a promise that settles once the shell has been asked.
   */
  async releasePage(): Promise<void> {
    // Only our own tabs: the ids come from the views we handed out (and their
    // orphans), never from "every webview currently visible". With two sessions
    // live, releasing one must leave the other's page alone.
    const mine = [...this.views.values(), ...this.orphaned]
    this.views.clear()
    this.orphaned.clear()
    // Nothing of ours is open: release nothing. Falling through to an unfiltered
    // release here would close tabs a human opened, or another session's page.
    if (mine.length === 0) return
    let titles: string[]
    try {
      const answer = await this.connection.call({ op: 'list' }, 5_000)
      const sidebar = Array.isArray(answer.sidebar) ? answer.sidebar as Array<{ id?: unknown; title?: unknown }> : []
      titles = sidebar
        .filter(guest => mine.includes(Number(guest.id)))
        .map(guest => String(guest.title ?? ''))
        .filter(title => title !== '')
    } catch {
      // Could not read the titles back; releasing nothing is safer than closing
      // tabs that belong to somebody else.
      return
    }
    if (titles.length === 0) return
    try {
      await this.connection.call({ op: 'closeSidebarBrowser', titles }, 10_000)
    } catch {
      // Best effort: the setting expresses a preference, and a shell that cannot
      // be reached is no reason to fail the session teardown that called us.
    }
  }

  /**
   * Fold the sidebar away without ending the page (`ui.autoExpandOnce` is off, or
   * the caller wants the screen back while work continues).
   * @returns a promise that settles once the shell has been asked.
   */
  async collapse(): Promise<void> {
    try {
      await this.connection.call({ op: 'collapseSidebar' }, 10_000)
    } catch {
      // Presentation only; failing to fold is never worth an error.
    }
  }

  /** No child process of our own to stop; close the shared connection instead. */
  dispose(): void {
    this.connection.close()
    this.views.clear()
    this.orphaned.clear()
    this.userActionHandler = undefined
  }
}
