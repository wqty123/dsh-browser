import type { BridgeStatus } from './bridge-status.js';
import type { BrowserChannel } from './system-browser.js';
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
    /** The launcher's current profile name, rather than an installed Desktop found on disk. */
    readonly profile: string | undefined;
    /** Only sidebar and automatic selection need the desktop bridge. */
    readonly channel: BrowserChannel;
    /** Quiet mode preserves the current desktop session instead of restarting it implicitly. */
    readonly quiet: boolean;
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
/** Historical attempt-record interval, retained for compatibility with existing diagnostics. */
export declare const AUTO_INSTALL_COOLDOWN_MS: number;
/**
 * Report that runtime bridge installation is deferred to explicit maintenance.
 *
 * @param input - the readings described by {@link AutoInstallInput}.
 * @returns whether to run, and why.
 */
export declare function autoInstallDecision(_input: AutoInstallInput): AutoInstallDecision;
/**
 * Read the profile identity supplied by DSH's launcher before plugins mount.
 * A Desktop installation or Electron executable can also belong to a Web/CLI invocation,
 * so neither is used to infer the current surface.
 * @param ctx - plugin context; older or custom compositions may omit the profile service.
 * @returns the current profile name, or undefined when the launcher did not provide it.
 */
export declare function readAutoInstallProfile(ctx: unknown): string | undefined;
/** A manual uninstall could not record the operator's automatic-install opt-out. */
export declare class BridgeAutoInstallPreferenceError extends Error {
    constructor(cause: unknown);
}
/**
 * Preserve an explicit uninstall as an automatic-install opt-out in historical settings.
 * The preference is written before the installer starts, so a failed write cannot launch maintenance.
 * A failed uninstall retains the opt-out; an explicit install leaves an existing opt-out unchanged.
 * @param action - the authenticated user's selected action.
 * @param update - persist the operator's bridge preference.
 * @param run - perform the installer action after its preference is durable.
 * @returns the installer's result.
 */
export declare function runWithManualBridgePreference<T>(action: 'install' | 'uninstall', update: (patch: {
    readonly bridge: {
        readonly autoInstall: false;
    };
}) => unknown, run: () => Promise<T>): Promise<T>;
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
 * @returns whether the record was saved; callers skip automatic restarts without a durable guard.
 */
export declare function writeAutoInstallMarker(path: string, marker: AutoInstallMarker): boolean;
