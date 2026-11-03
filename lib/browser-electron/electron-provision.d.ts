/** How long a background provision may run before it is abandoned. */
export declare const PROVISION_TIMEOUT_MS = 180000;
/** What happened, in terms a log line can carry. */
export interface ProvisionResult {
    /** `present` — nothing to do; `ready` — provisioned now; `skipped` — opted out; `failed`. */
    readonly status: 'present' | 'ready' | 'skipped' | 'failed';
    /** One line for the log; never contains a stack trace a user has to decode. */
    readonly detail: string;
}
/** Everything this module touches from the outside, so a test can drive it without Electron. */
export interface ProvisionDeps {
    /** Whether a spawnable binary already exists. */
    readonly hasBinary: () => boolean;
    /** The installed electron package's own installer script, or undefined when it is not there. */
    readonly installerScript: () => string | undefined;
    /** Runs the installer; resolves to an exit code, or rejects/returns null on failure. */
    readonly run: (script: string) => Promise<{
        code: number | null;
        detail?: string;
    }>;
    /** Where the outcome goes. */
    readonly log: (message: string) => void;
    /** Opt-out honoured exactly like the install script honours it. */
    readonly skip: () => boolean;
    /** Budget for one provision. */
    readonly timeoutMs: number;
}
/**
 * Whether a spawnable Electron binary is already available.
 *
 * Resolved through the same probe the host uses, so this can never disagree with what a launch
 * would find: a second, cheaper-looking check would be the classic way to report "ready" and then
 * fail at spawn time.
 * @returns true when a launch would find a binary.
 */
export declare function hasElectronRuntime(): boolean;
/** The real dependencies: this process's spawn, fs and logger. */
export declare function defaultDeps(log?: (message: string) => void): ProvisionDeps;
/**
 * Provision the runtime once per process, when it is missing.
 *
 * Concurrent callers share the first attempt: two tool calls arriving together must not start two
 * downloads into the same directory.
 * @param deps - the effects, defaulted to this process's.
 * @returns what happened. Never throws.
 */
export declare function ensureElectronRuntime(deps?: ProvisionDeps): Promise<ProvisionResult>;
/**
 * Start (or join) the single background attempt.
 *
 * Returns immediately with the shared promise, so a caller that does not care can ignore it and one
 * that does can await it — the returned promise never rejects.
 * @param log - where the outcome goes.
 * @param deps - the effects; defaulted to this process's, overridable so a test can drive it.
 * @returns the shared attempt.
 */
export declare function provisionElectronInBackground(log: (message: string) => void, deps?: ProvisionDeps): Promise<ProvisionResult>;
/** Forget the attempt. Tests only: a real process provisions at most once. */
export declare function resetProvisionStateForTest(): void;
