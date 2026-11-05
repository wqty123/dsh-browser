import type { BridgeStatus } from './bridge-status.js';
/** What the last automatic attempt was, and for which desktop build. */
export interface AutoInstallMarker {
    /** Desktop build the attempt belonged to (`version` from the identity check when known). */
    readonly build: string;
    /** ISO timestamp of the attempt, recorded BEFORE running, so a crash still counts. */
    readonly attemptedAt: string;
    /** Outcome recorded afterwards, for the panel and for support: `started` / `installed` / a reason. */
    readonly outcome: string;
}
/** Everything the decision needs, so it can be tested without a filesystem or a shell. */
export interface AutoInstallInput {
    /** The desktop install directory, or undefined when this is the web end. */
    readonly installRoot: string | undefined;
    /** Whether the operator left automatic installation on. */
    readonly enabled: boolean;
    /** The reading the panel would show. */
    readonly status: BridgeStatus;
    /** The last attempt, when one is recorded. */
    readonly marker: AutoInstallMarker | undefined;
    /** How long an attempt for the same build suppresses the next one. */
    readonly cooldownMs: number;
    /** Current time, injected. */
    readonly now: number;
}
/** Why the automatic install did or did not run, in words a log line can carry. */
export interface AutoInstallDecision {
    /** Whether to start the installer now. */
    readonly run: boolean;
    /** The reason, either way. */
    readonly why: string;
}
/** A day is short enough to feel automatic and long enough that a broken install cannot loop. */
export declare const AUTO_INSTALL_COOLDOWN_MS: number;
/**
 * Decide whether this load should install the bridge.
 *
 * @param input - the readings described by {@link AutoInstallInput}.
 * @returns whether to run, and why.
 */
export declare function autoInstallDecision(input: AutoInstallInput): AutoInstallDecision;
/** Where the attempt record lives, beside the settings the plugin already owns. */
export declare function autoInstallMarkerPath(dshHome: string): string;
/**
 * Read the last attempt.
 *
 * A record that cannot be parsed is treated as absent: the guard exists to prevent loops, and a single
 * extra attempt after a corrupt file is cheaper than refusing to ever install again.
 * @param path - marker file path.
 * @returns the marker, or undefined.
 */
export declare function readAutoInstallMarker(path: string): AutoInstallMarker | undefined;
/**
 * Record an attempt. Written before the installer runs: if the shell is killed mid-install, the next
 * launch must still see that an attempt happened rather than starting another restart.
 * @param path - marker file path.
 * @param marker - what to record.
 * @returns nothing; failures are the caller's to log, and a failed write is not worth an exception.
 */
export declare function writeAutoInstallMarker(path: string, marker: AutoInstallMarker): void;
