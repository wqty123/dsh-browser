/**
 * Electron browser provider plugin entry: registers the Electron-backed
 * `BrowserProvider` with `ctx.browser`. The provider needs a view host (real
 * Electron `WebContentsView` objects) that only a desktop shell can supply,
 * so the view host arrives through plugin config (the bundle patch reads it
 * from `ctx.get('electronViewHost')`).
 * @module dsh-browser/browser-electron
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { BrowserRuntime } from '../browser/runtime.ts'
import { ElectronBrowserProvider } from './provider.ts'
import type { ElectronBrowserViewHost } from './provider.ts'

export {
  ELECTRON_BROWSER_PROVIDER_ID,
  ElectronBrowserProvider,
} from './provider.ts'
export type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-electron'

/** The browser seam this provider registers into. */
export const inject = ['browser']

/** Plugin config: the view host supplied by the desktop shell. */
export interface Config {
  /** The Electron view host supplied by the desktop shell. */
  readonly viewHost: ElectronBrowserViewHost
  /** Allow navigation only to HTTP(S) URLs. Default true. */
  readonly httpOnly?: boolean
}

export const Config: z<Config> = z.object({
  viewHost: z.any(),
  httpOnly: z.boolean().default(true),
})

/** Register the Electron browser provider with `ctx.browser`. */
export function apply(ctx: Context & { browser: BrowserRuntime }, config: Config): void {
  ctx.browser.registerBrowserProvider(new ElectronBrowserProvider(config.viewHost, { httpOnly: config.httpOnly }))
}
