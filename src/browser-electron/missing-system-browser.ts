/**
 * A host that exists only to explain why the browser you asked for is not here.
 *
 * WHY THIS EXISTS
 * When the browser setting names a browser explicitly (Chrome or Edge rather than
 * "bundled" or "automatic"), the plugin used to log a warning and quietly fall back
 * to its own Electron window. That is worse than failing: you asked for Chrome, you
 * got an Electron window, and the error that eventually surfaced talked about
 * Electron — pointing at something you never chose and never wanted to install. The
 * actual problem ("no Chrome on this machine") never reached you.
 *
 * So the two choices are treated as the different requests they are:
 *   - `auto` means "any browser will do", and falling back to the bundled one is the
 *     behaviour it asks for;
 *   - `chrome` / `edge` are explicit, and an explicit request that cannot be met is
 *     reported as such, with the ways out of it.
 *
 * `available()` reports true on purpose. Reporting false would make the provider pick
 * a different carrier and hide the problem again, which is exactly the bug.
 */
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js'
import type { BrowserChannel } from './system-browser.js'

/** How each product is named in the message, and what to install. */
const PRODUCT: Record<string, { label: string; install: string; variable: string }> = {
  chrome: {
    label: 'Google Chrome',
    install: 'install Google Chrome',
    variable: 'DSH_BROWSER_CHROME_PATH',
  },
  edge: {
    label: 'Microsoft Edge',
    install: 'install Microsoft Edge',
    variable: 'DSH_BROWSER_EDGE_PATH',
  },
  brave: {
    label: 'Brave',
    install: 'install Brave',
    variable: 'DSH_BROWSER_BRAVE_PATH',
  },
}

/** How the setting is named to the user. */
const SETTING_LABEL: Record<string, string> = {
  chrome: '本机 Chrome / installed Chrome',
  edge: '本机 Edge / installed Edge',
  brave: '本机 Brave / installed Brave',
  auto: '自动 / automatic',
  bundled: '内置 / bundled',
}

/**
 * A carrier that cannot carry anything: every command explains the real problem.
 *
 * The message is written to be acted on, not just read: it says which browser was
 * requested, where the plugin looked, and the three concrete ways to resolve it.
 */
export class MissingSystemBrowserHost implements ElectronBrowserViewHost {
  /**
   * @param kind - the browser the user asked for.
   * @param searched - the names and locations that were checked, for the report.
   */
  constructor(private readonly kind: Exclude<BrowserChannel, 'bundled' | 'auto'>, private readonly searched: readonly string[]) {}

  /** @returns always true: see the module comment — reporting false would hide this. */
  available(): boolean {
    return true
  }

  /**
   * The message every command fails with.
   * @returns a multi-line explanation with the fixes.
   */
  private explain(): string {
    const product = PRODUCT[this.kind] ?? { label: this.kind, install: `install ${this.kind}`, variable: 'DSH_BROWSER_<KIND>_PATH' }
    const searched = this.searched.length > 0 ? this.searched.join(', ') : 'PATH and the usual install locations'
    return [
      `dsh-builtin-browser: the browser you selected is not installed — no ${product.label} was found.`,
      ``,
      `  Setting:  browser carrier = "${SETTING_LABEL[this.kind] ?? this.kind}"`,
      `  Looked for: ${searched}`,
      ``,
      `Nothing else is wrong: the plugin falls back to its own bundled browser only when the`,
      `setting is "bundled" or "automatic". Because this one names a browser explicitly, it`,
      `reports the missing browser instead of silently using a different one.`,
      ``,
      `To fix it, any ONE of these is enough:`,
      `  1. ${product.install}, then restart DSH;`,
      `  2. point ${product.variable} at its executable;`,
      `  3. set the browser carrier back to "内置 / bundled" (or "自动 / automatic" to let it`,
      `     fall back on its own next time).`,
    ].join('\n')
  }

  /**
   * Create a handle whose every command fails with the explanation.
   * @returns a handle that never reaches a page.
   */
  createView(): ElectronViewHandle {
    const message = this.explain()
    return {
      id: `missing-${this.kind}`,
      sendCommand: async () => { throw new Error(message) },
    }
  }

  /**
   * Accept a handle for destruction. Nothing was created, so nothing is released.
   * @param handle - the handle returned by {@link createView}.
   */
  destroyView(handle: ElectronViewHandle): void {
    void handle
  }
}
