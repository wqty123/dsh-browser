/** How long a background provision may run before it is abandoned. */
export declare const PROVISION_TIMEOUT_MS = 180000;
/** What happened, in terms a log line can carry. */
export interface ProvisionResult {
    /** `present` — nothing to do; `ready` — provisioned now; `skipped` — opted out; `failed`. */
    readonly status: 'present' | 'ready' | 'skipped' | 'failed';
    /** One line for the log; never contains a stack trace a user has to decode. */
    readonly detail: string;
}
/**
 * The state a settings panel shows, which is one state wider than {@link ProvisionResult}.
 *
 * `idle` and `preparing` are the two a log line never needs and a user always does: "nothing has
 * been asked for yet" and "a ~100 MB download is running right now" are the states in which a first
 * browser call is slow, and until this existed neither was visible anywhere in the product — the
 * only trace was a log line the panel cannot read.
 */
export interface ProvisionSnapshot {
    /** `idle` and `preparing` are provisional; the rest are terminal for this attempt. */
    readonly state: 'idle' | 'preparing' | 'present' | 'ready' | 'skipped' | 'failed';
    /** One line, already user-facing: never a stack trace. */
    readonly detail: string;
    /** When the state last changed, ISO. */
    readonly at: string;
}
/**
 * The current provisioning state, for a readiness report.
 *
 * Deliberately a snapshot rather than a promise: a panel polling this must be able to answer in one
 * synchronous read, without awaiting (and thereby echoing) the download it is reporting on.
 * @returns the last state written, or the idle state before anything ran.
 */
export declare function provisionSnapshot(): ProvisionSnapshot;
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
 *
 * `force` is the second half of the settings panel's retry button. Without it the memoised attempt
 * made a failed download permanent for the life of the process: the panel could offer a button, the
 * button could call this, and the answer would be the failure it was trying to replace. An attempt
 * still IN FLIGHT is always joined, never restarted — two downloads into one directory is the one
 * outcome worth refusing.
 * @param log - where the outcome goes.
 * @param deps - the effects; defaulted to this process's, overridable so a test can drive it.
 * @param options - `force` discards a settled attempt so a new one may start.
 * @returns the shared attempt.
 */
export declare function provisionElectronInBackground(log: (message: string) => void, deps?: ProvisionDeps, options?: {
    readonly force?: boolean;
}): Promise<ProvisionResult>;
/** Forget the attempt. Tests only: a real process provisions at most once. */
export declare function resetProvisionStateForTest(): void;
