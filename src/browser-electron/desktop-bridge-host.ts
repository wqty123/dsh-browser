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
import type { CarrierPage } from '../browser/types.js'


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
  // The panel path reports its own failure when the renderer never produced a page, and that is the
  // same class as a vanished guest — worth one retry on a fresh panel — so it is listed here too.
  return /guest \d+ is not available|sidebar unavailable|produced no page/i.test(message)
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
  /**
   * One entry per view this host handed out: the conversation it serves, and the guest backing it.
   *
   * The conversation belongs to the ENTRY, not to this host. A single plugin process serves every
   * conversation — DSH runs them all through one host instance — so an owner held on the host
   * would be one conversation's id applied to all of them, and a page could still land in
   * another's sidebar however carefully the bridge checked it.
   */
  private readonly views = new Map<string, { guest?: number; owner: string }>()
  /**
   * This process's identity with the bridge, for tab ownership.
   *
   * Every DSH session is its own plugin process, and the sidebar is one surface they all share.
   * A session can only see its own `views` map, so before the bridge kept a ledger it adopted
   * whichever tab it found — including one another session had opened, which is how a URL from
   * one session appeared in another's sidebar. The id is per process, so two sessions never
   * collide and one session's tabs are never handed to another; it is deliberately not the DSH
   * session id, which this layer has no access to and does not need.
   *
   * The whole ledger rests on that premise, so it was measured rather than assumed: with two
   * sessions running, the desktop had TWO host processes (plus one main, two renderers and a
   * gpu/utility pair). If sessions ever shared a process, every owner check in the bridge would
   * compare equal and the bleed would return in a new shape — so a change to how DSH spawns
   * sessions invalidates this file, not just this comment.
   *
   * It is now the CONVERSATION id rather than an invented uuid, read from the plugin's ctx by the
   * same path DSH's own desktop host uses. That matters because the shell keeps one sidebar per
   * conversation and writes its session id onto each sidebar container (on the React fiber,
   * measured on the running app) — so the bridge can only answer "is this sidebar mine" if it has
   * a comparable id. With an invented uuid it never could, which is how a command came to be typed
   * into another conversation's address bar.
   *
   * Falls back to a random uuid when the host cannot supply one — an older DSH, or a non-desktop
   * composition. That is no worse than before: the bridge then knows only "this process", and it
   * refuses to operate on a sidebar it cannot prove is its own.
   */
  private readonly owner: string
  /**
   * Guests whose view is gone but whose page may still be open in the sidebar, with the
   * conversation each belongs to.
   *
   * The provider destroys its view handles before it asks for a release, so the mapping is dropped
   * by then — keeping the guest ids here is what lets us close only our own tabs when several
   * conversations are running (requirements §4: each session gets its own page). The owner rides
   * along for the same reason it does in {@link views}: a release names one conversation.
   */
  private readonly orphaned = new Map<number, string>()
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
  /** Told when the shell behind this bridge exits; see `onLost`. */
  private lostListener: (() => void) | undefined

  /**
   * @param endpoint - the shell's published bridge endpoint.
   */
  private constructor(endpoint: BridgeEndpoint, sessionId?: string) {
    this.owner = sessionId !== undefined && sessionId !== String.fromCharCode(39,39) ? sessionId : randomUUID()
    this.connection = new BridgeConnection(endpoint, bridgeEndpointPath(), () => this.reportLost())
  }

  /**
   * Called by the transport once the shell behind it is gone.
   *
   * Forwarded rather than acted on here: only the entry point owns the swap back to the self-hosted
   * browser, and a host that tried to replace itself would be reaching outside its own contract.
   */
  private reportLost(): void {
    try {
      this.lostListener?.()
    } catch {
      // The listener's failure is not the transport's problem.
    }
  }

  /** Register the "this carrier is gone" listener (see the interface's `onLost`). */
  onLost(listener: () => void): void {
    this.lostListener = listener
  }

  /**
   * Find a usable desktop bridge, if this surface has one.
   *
   * A stale endpoint (a shell that already exited, leaving its file behind) is
   * rejected here rather than surfacing later as a mysterious ECONNREFUSED: the
   * caller falls back to self-hosting, which always works.
   * @returns the host, or undefined when no bridge is available.
   */
  static async discover(sessionId?: string): Promise<DesktopBridgeViewHost | undefined> {
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
      const probe = new BridgeConnection(endpoint, bridgeEndpointPath())
      try {
        const answer = await probe.call({ op: 'list' }, 5_000)
        if (answer.ok !== true) return undefined
        // Refuse a panel this plugin cannot drive, before adopting it.
        //
        // The sidebar browser renders as a <webview> only where the shell exposes
        // `dshDesktop.browser` and enables `webviewTag`. Where it renders as an <iframe> there is
        // no webContents, no `getWebContentsId()` and no CDP endpoint — and every tool here is
        // built on CDP, so adopting it means failing every call, with no path back to a carrier
        // that works. Reported on DSH Desktop 2.0.17 with both conditions measured.
        //
        // Read here WITHOUT an owner on purpose, because the question is not about a conversation:
        // whether the panel is a webview is decided by the shell's preload and window options, so
        // it is the same answer for every conversation and needs no session context.
        //
        // `none` and `unknown` are NOT refusals: a panel that does not exist yet is created by the
        // first open, and a probe that could not read the attribute has learned nothing.
        if (String(answer.frame ?? 'unknown') === 'iframe') {
          DesktopBridgeViewHost.refuseIframe = true
          return undefined
        }
        return new DesktopBridgeViewHost(endpoint, sessionId)
      } finally {
        probe.close()
      }
    } catch {
      // Dead endpoint or an older bridge: self-hosting remains the answer.
      return undefined
    }
  }

  /**
   * Whether the last discovery refused a bridge because its sidebar panel is an iframe.
   *
   * Recorded so the entry point can say WHY the plugin is self-hosting on a shell that does have a
   * bridge. Otherwise the user sees a second browser window and no explanation, on a machine where
   * they just followed instructions to install the bridge.
   */
  private static refuseIframe = false

  /** Whether discovery refused a bridge for an undrivable sidebar panel (see {@link discover}). */
  static refusedIframePanel(): boolean {
    return this.refuseIframe
  }

  /** Whether this host can back views: the bridge already answered `list`. */
  available(): boolean {
    return true
  }

  /**
   * Every page this conversation's sidebar panel currently holds.
   *
   * The shell owns page creation inside the panel: a link the user or the agent clicks may open a
   * new page, and nothing tells the provider. Those pages are real — they are what the human sees
   * — but without this the tab model reports only the ones the provider created, so the rest are
   * invisible to `dsh_browser_list_tabs` and unclosable through `dsh_browser_close_tab`.
   *
   * The bridge's `list` already answers with the sidebar guests, which is the same information, so
   * this asks for it rather than reaching into the shell again.
   * @returns the panel's pages, or an empty list when the bridge cannot answer.
   */
  /**
   * Every sidebar page this conversation holds that THIS HOST did not open.
   *
   * The shell owns page creation inside the panel: a link the user or the agent clicks may open a
   * new page, and nothing tells the provider. Those pages are real — they are what the human sees
   * — but without this the tab model reports only the ones the provider created, so the rest are
   * invisible to `dsh_browser_list_tabs` and unclosable through `dsh_browser_close_tab`.
   *
   * Pages this host opened are EXCLUDED here rather than deduplicated by the caller, because the
   * caller cannot do it: the provider knows a tab by its own id and the carrier knows a page by the
   * guest id, and the two never match. The first version returned everything and relied on the
   * caller to filter, which reported the same page twice — the mapping that makes the match
   * possible exists only here.
   * @returns the panel's pages that are not ours, or an empty list when the bridge cannot answer.
   */
  async listPages(): Promise<readonly CarrierPage[]> {
    try {
      const answer = await this.connection.call({ op: 'list', owner: this.owner }, 5_000)
      const guests = Array.isArray(answer.sidebar) ? answer.sidebar : []
      const ours = new Set<number>()
      for (const view of this.views.values()) {
        if (typeof view.guest === 'number') ours.add(view.guest)
      }
      return guests
        .filter((guest): guest is { id: number; url?: unknown } => typeof guest?.id === 'number')
        .filter(guest => !ours.has(guest.id))
        .map(guest => ({
          id: String(guest.id),
          url: typeof guest.url === 'string' ? guest.url : '',
        }))
    } catch {
      // A bridge that cannot answer has a real problem, and the next command reports it. Failing
      // the tab LIST here would make a listing worse than the driving it exists to describe.
      return []
    }
  }

  /**
   * Close one sidebar page by the id {@link listPages} reported.
   *
   * The bridge closes sidebar pages by TITLE, and only the ones the caller owns — that is what
   * stopped one conversation's teardown from destroying another's page. So the title is looked up
   * through the same listing, and a page that no longer appears is treated as already gone rather
   * than as an error: the caller asked for it to be closed, and it is.
   * @param id - the sidebar guest id, as a string.
   */
  async closePage(id: string): Promise<void> {
    const numeric = Number(id)
    if (!Number.isFinite(numeric)) throw new Error(`not a sidebar page id: ${id}`)
    const answer = await this.connection.call({ op: 'list', owner: this.owner }, 5_000)
    const guests = Array.isArray(answer.sidebar) ? answer.sidebar : []
    const title = guests
      .filter((guest): guest is { id: number; title?: unknown } => Number(guest?.id) === numeric)
      .map(guest => String(guest.title ?? ''))
      .find(candidate => candidate !== '')
    if (title === undefined) return
    await this.connection.call({ op: 'closeSidebarBrowser', titles: [title], owner: this.owner }, 10_000)
  }

  /**
   * The guest backing a view, materialized on first use.
   *
   * The conversation that called owns exactly one sidebar page on this carrier — a human and the
   * agent look at the same page — so every view resolves to that conversation's own guest, and the
   * page does not multiply behind the provider's own tab bookkeeping.
   *
   * A cached guest is used as-is: probing it first cost a round-trip on every command, so liveness
   * is established by the command failing instead.
   * @param viewId - the view whose guest is wanted.
   * @param url - address to use when this conversation has no page yet.
   */

  private async guestFor(viewId: string, url?: string): Promise<number> {
    const entry = this.views.get(viewId)
    // No liveness check here: verifying the cached guest cost a round-trip on every
    // command. A guest that has gone away is detected by the command itself failing,
    // and `createView`'s sendCommand then discards the cache and calls back in here.
    if (entry?.guest !== undefined) return entry.guest

    // The conversation THIS VIEW serves — read from the view, never from the process.
    //
    // The difference is the whole bug. This host is one instance shared by every conversation, so
    // `this.owner` alone can only be "whichever conversation this process happens to name", and
    // naming the wrong one is exactly how a page requested in one conversation appeared in
    // another. The view was created for a conversation (`createView(owner)`), so that is what it
    // asks for its page.
    //
    // Nothing here asks which conversation is on screen: `ensureSidebar` reaches this
    // conversation's own panel by id through the renderer, rather than by pressing the shell's
    // shortcut or clicking its card, both of which the shell delivers to whatever it displays.
    const owner = entry?.owner ?? this.owner
    const answer = await this.connection.call({
      op: 'ensureSidebar',
      owner,
      ...url !== undefined && url !== '' ? { url } : {},
    }, 30_000)
    if (answer.ok !== true) {
      // A bridge that answers but cannot produce a page is as unusable as one that has exited, and
      // the difference matters here: `onLost` is what returns the surface to the self-hosted
      // browser. Without this the same failure repeats on every call until DSH is restarted — on a
      // shell whose sidebar panel is an iframe, that is every call forever. Reported as "installing
      // the bridge made it worse than not installing it": the carrier was switched to one that
      // cannot work, with no path back to the one that does.
      if (String(answer.error).includes('produced no page')) this.reportLost()
      throw new Error(`dsh-builtin-browser: sidebar unavailable (${String(answer.error)})`)
    }
    const id = Number(answer.id)
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('dsh-builtin-browser: the sidebar reported no browser page for this conversation')
    }
    this.views.set(viewId, { guest: id, owner })
    return id
  }

  /**
   * @param owner - the conversation this view serves. Recorded WITH the view: one host instance
   *   serves every conversation, so the owner cannot live on the host.
   */
  createView(owner?: string): ElectronViewHandle {
    const viewId = randomUUID()
    this.views.set(viewId, { owner: owner !== undefined && owner !== '' ? owner : this.owner })
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
          // Drop the guest but keep the entry: the conversation it serves is what the retry needs,
          // and removing the entry would lose it back to the process-wide fallback owner.
          const lost = this.views.get(viewId)
          if (lost !== undefined) delete lost.guest
          guest = await this.guestFor(viewId, url)
          return await run(guest, method, params)
        }
      },
    }
  }

  destroyView(handle: ElectronViewHandle): void {
    const entry = this.views.get(handle.id)
    if (entry !== undefined) {
      // Remember the page: it outlives our handle, and a later release must be able to name
      // exactly the tabs this conversation's views opened. The owner comes along so a release
      // naming one conversation does not sweep up another's.
      if (entry.guest !== undefined) this.orphaned.set(entry.guest, entry.owner)
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
    // `owner` is required: the bridge refuses to bring forward a guest held by another session.
    // It comes from the view, not the process — with several conversations live, a process-wide
    // owner would raise the wrong conversation's tab.
    const owner = this.views.get(handle.id)?.owner ?? this.owner
    void this.connection.call({ op: 'showTab', viewId: Number(handle.id), owner }, 5_000).catch(() => undefined)
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
   * @param owner - the conversation whose pages to close. Omit to close every conversation's,
   *   which is only correct from a teardown that is itself global.
   * @returns a promise that settles once the shell has been asked.
   */
  async releasePage(owner?: string): Promise<void> {
    // Only this conversation's tabs. The host is ONE instance shared by every conversation, so a
    // release that named none would close pages other conversations are still driving — "every
    // webview currently visible" is precisely what must never be used here.
    const mine: number[] = []
    for (const [viewId, entry] of [...this.views]) {
      if (owner !== undefined && entry.owner !== owner) continue
      if (entry.guest !== undefined) mine.push(entry.guest)
      this.views.delete(viewId)
    }
    // A view destroyed before the release still owns its page; its guest is collected here.
    for (const [guest, holder] of [...this.orphaned]) {
      if (owner !== undefined && holder !== owner) continue
      mine.push(guest)
      this.orphaned.delete(guest)
    }
    // Nothing of ours is open: release nothing. Falling through to an unfiltered
    // release here would close tabs a human opened, or another session's page.
    if (mine.length === 0) return
    let titles: string[]
    try {
      // `owner` is REQUIRED here now that the bridge filters `list` by it. Without it the bridge
      // falls back to a different owner, so the guests this session holds are filtered out of the
      // answer, `mine.includes(...)` matches nothing, the title list comes back empty and this
      // returns without closing anything — the page stayed open and the human had to close it by
      // hand. Adding the ledger to the bridge without updating this call site is exactly the kind
      // of half-change that made the ownership work take four rounds.
      const answer = await this.connection.call({ op: 'list', owner: owner ?? this.owner }, 5_000)
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
      // `owner` is required for the same reason as above: the bridge closes only the guests the
      // caller holds, so an owner-less call closes nothing and the page stays open.
      await this.connection.call({ op: 'closeSidebarBrowser', titles, owner: owner ?? this.owner }, 10_000)
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
