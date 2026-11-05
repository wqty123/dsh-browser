/** What the panel may ask for. */
export type BridgeAction = 'install' | 'uninstall';
/** Everything this module touches from outside, so a test can drive it without spawning. */
export interface BridgeActionDeps {
    /** Runs the installer; resolves with an exit code and the tail of its output. */
    readonly run: (command: string, argv: readonly string[]) => Promise<{
        readonly code: number | null;
        readonly output: string;
    }>;
    /** Absolute path of the packaged installer. */
    readonly installer: () => string;
    /** Node executable used to run it (the host's own, so no PATH surprises). */
    readonly node: () => string;
}
/** What the panel is told. */
export interface BridgeActionResult {
    /** Whether the installer exited 0. */
    readonly ok: boolean;
    /** Its exit code, or null when it was killed. */
    readonly code: number | null;
    /** The tail of its output, for the one line the panel shows. */
    readonly output: string;
    /** The exact command line, so a failure can be reproduced by hand. */
    readonly command: string;
}
/**
 * The argv the installer expects, in one place so the panel and a human run the same thing.
 *
 * `--restart --yes` is not a convenience: the shell holds `app.asar` open, so an install with the
 * app running fails with EBUSY, and a prompt would block an unattended click.
 * @param action - install/repair, or restore the pre-bridge state.
 * @param installRoot - the desktop install directory that was discovered.
 * @returns argv for the installer.
 */
export declare function bridgeActionArgv(action: BridgeAction, installRoot: string): string[];
/** The packaged installer, resolved from this module rather than from a build-time path. */
export declare function defaultInstallerPath(): string;
/**
 * Run one bridge action.
 *
 * Never throws for an installer failure: the panel needs the exit code and the line that explains it,
 * and an exception would lose both.
 * @param action - install/repair or uninstall.
 * @param installRoot - the desktop install directory.
 * @param deps - effects; defaulted to this process's.
 * @returns the outcome, with the command line for reproduction.
 */
export declare function runBridgeAction(action: BridgeAction, installRoot: string, deps?: BridgeActionDeps): Promise<BridgeActionResult>;
