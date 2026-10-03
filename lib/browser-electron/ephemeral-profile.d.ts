/** Test seams; production passes neither. */
export interface SweepOptions {
    /** The clock, for the age check. */
    readonly now?: number;
    /** Liveness test for an owner pid. */
    readonly alive?: (pid: number) => boolean;
}
/**
 * The directory name an ephemeral profile for `kind` gets, before it is claimed.
 *
 * The sweep matches on the same shape, so the two must agree: a name built anywhere else
 * is a directory the sweep will never find.
 * @param kind - the detected browser product (`chrome`, `edge`, ...).
 * @param id - a per-run unique suffix.
 * @returns the directory NAME, not a path.
 */
export declare function ephemeralProfileName(kind: string, id: string): string;
/**
 * Mark an ephemeral profile directory as this process's, so a later run can tell whether
 * the process that created it is still there.
 * @param dir - the profile directory (created if it does not exist yet).
 * @param pid - the claiming process, defaulting to this one.
 * @param now - the claim time, defaulting to the current clock.
 * @returns true when the marker was written.
 */
export declare function claimEphemeralProfile(dir: string, pid?: number, now?: number): boolean;
/**
 * Delete the ephemeral profiles under `root` that belong to processes which are gone.
 *
 * Called before a new one is claimed, because that is the only moment that can still act
 * on a profile whose owner was killed: nothing runs when the signal lands.
 * @param root - the plugin's profile root (`<DSH_HOME>/dsh-builtin-browser-host`).
 * @param kind - the browser product, which selects the directory-name prefix.
 * @param options - test seams for the clock and the liveness test.
 * @returns the names of the directories that were removed.
 */
export declare function sweepAbandonedEphemeralProfiles(root: string, kind: string, options?: SweepOptions): string[];
