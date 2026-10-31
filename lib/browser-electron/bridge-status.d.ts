/**
 * Find the desktop install to report on.
 *
 * The same shape probe the installer uses, repeated here because the two run in different processes
 * and neither can import the other: the product directory is `DeepSeek Harness` on some builds and
 * `DSH Desktop` on others, and the shape that identifies an install is stable across both.
 * @param localAppData - the base directory; defaults to the environment's.
 * @returns the install directory, or undefined when nothing matches.
 */
export declare function findDesktopInstall(localAppData?: string): string | undefined;
/** One reading of the install tree. */
export interface BridgeStatus {
    /** `installed`, `missing` or `stale`; see the module comment for what each means. */
    readonly state: 'installed' | 'missing' | 'stale';
    /** Whether the install directory looks like a DSH Desktop install at all. */
    readonly present: boolean;
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
