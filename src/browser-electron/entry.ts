/**
 * Electron browser provider plugin entry: registers the Electron-backed
 * `BrowserProvider` with `ctx.browser`. The provider needs a view host (real
 * Electron `WebContentsView` objects). When a desktop shell supplies
 * `ctx.electronViewHost`, that host is used (embedded, human-machine shared
 * view). Otherwise the plugin self-hosts: it spawns its own Electron child
 * (`host-main.js`) and drives it over a local TCP JSON-RPC socket, so
 * installing the plugin is enough for `browser_*` tools to work on any
 * surface.
 * @module dsh-browser/browser-electron
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BrowserRuntime } from '../browser/runtime.js'
import { ElectronBrowserProvider } from './provider.js'
import type { ElectronBrowserViewHost } from './provider.js'
import { defaultHostMainPath, RemoteElectronViewHost } from './remote-host.js'

export {
  ELECTRON_BROWSER_PROVIDER_ID,
  ElectronBrowserProvider,
} from './provider.js'
export type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js'
export { RemoteElectronViewHost, defaultHostMainPath } from './remote-host.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-electron'

/** The browser seam this provider registers into. */
export const inject = ['browser']

/** Plugin config: an optional externally-supplied view host. */
export interface Config {
  /** View host supplied by a desktop shell; absent -> self-host. */
  readonly viewHost?: ElectronBrowserViewHost
  /** Allow navigation only to HTTP(S) URLs. Default true. */
  readonly httpOnly?: boolean
  /**
   * Directory `browser_download` save paths must resolve inside (prevents a
   * prompt-injected agent from writing arbitrary machine paths). Default:
   * the user's Downloads folder; override to confine downloads elsewhere.
   */
  readonly downloadDir?: string
  /** Maximum snapshot elements before truncation. Default 60. */
  readonly snapshotMaxElements?: number
  /** Maximum content characters before truncation when no maxChars is given. Default 100_000. */
  readonly contentMaxChars?: number
}

export const Config: z<Config> = z.object({
  // Absent on surfaces without a desktop shell; the plugin self-hosts then.
  viewHost: z.any(),
  httpOnly: z.boolean().default(true),
  downloadDir: z.string(),
  snapshotMaxElements: z.number(),
  contentMaxChars: z.number(),
})

/** Register the Electron browser provider with `ctx.browser`. */
export function apply(ctx: Context & { browser: BrowserRuntime }, config: Config): void {
  // External host (desktop shell) wins; otherwise self-host. The self-hosted
  // child is disposed with the fiber, mirroring the shell's lifetime.
  const host: ElectronBrowserViewHost = config.viewHost ?? new RemoteElectronViewHost(defaultHostMainPath())
  // Own the disposer on THIS plugin's fiber: registerBrowserProvider's effect
  // is bound to the seam's own fiber (the browser row), so a reload of this
  // row would otherwise collide with the still-registered provider
  // (BROWSER_DUPLICATE_PROVIDER) or leave a stale provider behind.
  const unregister = ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(host, {
    httpOnly: config.httpOnly,
    downloadDir: config.downloadDir,
    snapshotMaxElements: config.snapshotMaxElements,
    contentMaxChars: config.contentMaxChars,
  }))
  ctx.effect(() => () => {
    unregister()
    if (config.viewHost === undefined && host instanceof RemoteElectronViewHost) {
      host.dispose()
    }
  })
}
