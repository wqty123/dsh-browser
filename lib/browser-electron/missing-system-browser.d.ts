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
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js';
import type { BrowserChannel } from './system-browser.js';
/**
 * A carrier that cannot carry anything: every command explains the real problem.
 *
 * The message is written to be acted on, not just read: it says which browser was
 * requested, where the plugin looked, and the three concrete ways to resolve it.
 */
export declare class MissingSystemBrowserHost implements ElectronBrowserViewHost {
    private readonly kind;
    private readonly searched;
    /**
     * @param kind - the browser the user asked for.
     * @param searched - the names and locations that were checked, for the report.
     */
    constructor(kind: Exclude<BrowserChannel, 'bundled' | 'auto'>, searched: readonly string[]);
    /** @returns always true: see the module comment — reporting false would hide this. */
    available(): boolean;
    /**
     * The message every command fails with.
     * @returns a multi-line explanation with the fixes.
     */
    private explain;
    /**
     * Create a handle whose every command fails with the explanation.
     * @returns a handle that never reaches a page.
     */
    createView(): ElectronViewHandle;
    /**
     * Accept a handle for destruction. Nothing was created, so nothing is released.
     * @param handle - the handle returned by {@link createView}.
     */
    destroyView(handle: ElectronViewHandle): void;
}
