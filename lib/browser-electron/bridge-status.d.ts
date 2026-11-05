/**
 * Find the desktop install to report on.
 *
 * Reported as issue #40: this used to probe for a *generic* Electron layout and return the first
 * directory that had one. Any Electron app has that layout, so a stranger's app was reported as
 * "DSH Desktop, bridge missing" — together with a ready-to-run installer command aimed at it. The
 * probe now verifies the same identity the installer does (see `desktop-identity.js`), so the
 * answer is about DSH Desktop and nothing else.
 *
 * Reported as issue #44: scanning `%LOCALAPPDATA%\Programs` alone is not enough, because that is
 * only the DEFAULT place the Windows installer puts the app. An install moved to another drive, or
 * installed with a custom directory, is a perfectly good DSH Desktop that this function used to
 * report as "no desktop on this machine" — with the repair command missing at exactly the moment it
 * was needed (measured: a `E:\Applications\DeepSeek Harness` install, once a stale unpacked
 * directory under `Programs` had been cleaned up, started reporting `present: false`).
 *
 * So the scan keeps its default first — a default install must stay cheap and unambiguous — and
 * then consults the two sources a moved install leaves behind: the user's own `DSH_DESKTOP_APP`
 * (already honoured by `tools/install-web-plugin.mjs`) and the Windows uninstall entry the installer
 * writes. Both are re-verified with the same identity rule, so neither widens what counts as an
 * install; they only widen where we look for one.
 * @param localAppData - the base directory; defaults to the environment's.
 * @param registry - where custom installs are looked up; injectable so a test can close the door on
 *   the machine it runs on. A test that asserted "nothing matches" while the developer's own install
 *   sat in the registry would pass or fail depending on the machine, which is worse than no test.
 * @param conventions - the platform's conventional install locations; injectable for the same reason.
 * @returns the install directory, or undefined when nothing matches.
 */
export declare function findDesktopInstall(localAppData?: string, registry?: () => readonly string[], conventions?: () => readonly string[]): string | undefined;
/** One reading of the install tree. */
export interface BridgeStatus {
    /** `installed`, `missing` or `stale`; see the module comment for what each means. */
    readonly state: 'installed' | 'missing' | 'stale';
    /** Whether the install directory looks like a DSH Desktop install at all. */
    readonly present: boolean;
    /**
     * The desktop build this reading belongs to, when the identity check could name one.
     *
     * The automatic install runs once per build: a desktop update is exactly when the bridge has to be
     * installed again, so the guard needs to tell the two apart.
     */
    readonly version?: string;
    /** The directory that was inspected, when one was found. */
    readonly installRoot?: string;
    /** Whether `resources/app.asar` exists — the archive the shell actually loads. */
    readonly archivePresent: boolean;
    /** When the pre-bridge backup was written, if there is one. */
    readonly backupAt?: string;
    /** A one-line explanation for the panel, in the plugin's own words. */
    readonly detail: string;
    /**
     * The command that installs or repairs the bridge.
     *
     * Shown rather than run. Executing it from a web request would mean a page can decide to close the
     * desktop shell, and no amount of same-origin checking makes that a good idea; the user runs it.
     */
    readonly command?: string;
}
/**
 * Read the bridge's state from an install directory.
 *
 * Never throws: a caller showing this in a settings panel must get an answer even when the directory
 * is unreadable or the user pointed at something that is not an install.
 * @param installRoot - the desktop install directory.
 * @returns the current state.
 */
export declare function readBridgeStatus(installRoot: string): BridgeStatus;
