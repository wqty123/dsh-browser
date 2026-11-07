/** What the panel may ask for. */
export type BridgeAction = 'install' | 'uninstall';
/** Everything this module touches from outside, so a test can drive it without spawning. */
export interface BridgeActionDeps {
    /** Runs the installer; resolves with an exit code and the tail of its output. */
    readonly run: (command: string, argv: readonly string[], environment?: Readonly<Record<string, string>>) => Promise<{
        readonly code: number | null;
        readonly output: string;
    }>;
    /** Absolute path of the packaged installer. */
    readonly installer: () => string;
    /** Node executable used to run it (the host's own, so no PATH surprises). */
    readonly node: () => string;
    /** Follow the installer's atomic completion file. */
    readonly trackResult?: boolean;
    /** Completion budget, injectable for a fast failure test. */
    readonly resultTimeoutMs?: number;
    /** Poll interval for the installer's atomic completion file. */
    readonly resultPollMs?: number;
}
/** What the panel is told. */
export interface BridgeActionResult {
    /** Whether the requested file maintenance completed successfully. */
    readonly ok: boolean;
    /** Its exit code, or null when it was killed. */
    readonly code: number | null;
    /** The tail of its output, for the one line the panel shows. */
    readonly output: string;
    /** The exact command line, so a failure can be reproduced by hand. */
    readonly command: string;
    /** Persisted completion and installer output, retained for diagnosis. */
    readonly resultFile?: string;
    readonly logFile?: string;
    readonly restarted?: boolean;
    readonly pid?: number;
}
/** Final record written by the installer that actually performed the operation. */
export interface BridgeActionCompletion {
    readonly action: BridgeAction;
    readonly ok: boolean;
    readonly code: number;
    readonly restarted: boolean;
    readonly pid?: number;
    readonly error?: string;
    readonly completedAt: string;
}
/** Read-only startup verification, with a private endpoint path available to isolated tests. */
export interface BridgeReadyOptions {
    readonly endpointPath?: string;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
}
/**
 * Verify that the restarted process published a working authenticated bridge.
 * A previous shell's endpoint, a listening socket, or an authentication refusal is insufficient.
 */
export declare function waitForRestartedBridge(pid: number, options?: BridgeReadyOptions): Promise<void>;
/**
 * Wait for completed file maintenance. The installer publishes this file by rename so a reader
 * cannot accept a partial result. A panel operation must report no Desktop restart.
 */
export declare function waitForBridgeActionCompletion(path: string, action: BridgeAction, timeoutMs?: number, pollMs?: number): Promise<BridgeActionCompletion>;
/**
 * The argv the installer expects, in one place so the panel and a human run the same thing.
 *
 * The target Desktop must already be closed. In particular, the panel cannot grant its child
 * permission to terminate the process that owns the current tool call or settings request.
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
