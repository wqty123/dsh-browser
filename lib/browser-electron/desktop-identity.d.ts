/** The identity rule, as data. */
interface IdentityRule {
    readonly packageNames: readonly string[];
    readonly mainEntry: string;
}
/**
 * The rule shipped in `desktop-bridge/desktop-identity.json`, used when the file cannot be read.
 *
 * A copy exists here only as a fallback for a broken package layout; the test suite asserts that it
 * equals the JSON, so the two can never drift apart silently.
 */
export declare const FALLBACK_RULE: IdentityRule;
/** A verified install. */
export interface DesktopIdentity {
    readonly ok: true;
    /** The install root that was verified. */
    readonly root: string;
    /** Which shape was verified — the archive when it exists, the extraction only without one. */
    readonly layout: 'packed' | 'unpacked';
    /** `name` from the package the caller will actually run. */
    readonly packageName: string;
    /** `version`, when the package declares one. */
    readonly version?: string;
}
/** A refusal, with a reason a human can act on. */
export interface IdentityRefusal {
    readonly ok: false;
    readonly reason: string;
}
/**
 * Read the identity rule.
 *
 * Resolved relative to this module, which in both the repository and the published tarball puts
 * `desktop-bridge/` beside `lib/`. A missing file is not fatal — the fallback is the same rule —
 * but a *malformed* one is an error the caller should not ignore, so it is reported through the
 * refusal path rather than silently swapped for the fallback.
 * @returns the rule, or an error string.
 */
export declare function readIdentityRule(): IdentityRule | {
    readonly error: string;
};
/**
 * Read one file out of an asar archive without extracting the tree.
 * @param archive - the archive path.
 * @param path - a slash-separated path inside the archive.
 * @returns the bytes, or undefined when the entry is absent or unreadable.
 */
export declare function readAsarFile(archive: string, path: string): Buffer | undefined;
/**
 * Whether an install directory is DSH Desktop.
 *
 * Everything the caller does next (stop the app, delete a tree, extract, rename, write) depends on
 * this being right, so every uncertainty resolves to a refusal that names what was found.
 * @param installRoot - the directory a user or the discovery probe named.
 * @returns the verified identity, or a refusal with a reason.
 */
export declare function readDesktopIdentity(installRoot: string): DesktopIdentity | IdentityRefusal;
export {};
