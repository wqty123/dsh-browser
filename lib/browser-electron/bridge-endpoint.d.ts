/** What the panel needs to know about the running shell. */
export interface BridgeEndpointState {
    /** Whether a published endpoint file exists at all. */
    readonly present: boolean;
    /** Whether the shell behind it looks alive right now: a fresh stamp AND a live pid. */
    readonly alive: boolean;
    /** One line, already user-facing. */
    readonly detail: string;
    /** When the shell said it last refreshed the file, ISO, when the file carries a stamp. */
    readonly updatedAt?: string;
}
/**
 * Read the endpoint the shell publishes.
 *
 * Never throws: a settings panel must get an answer even when the file is mid-write, unreadable, or
 * belongs to a shell that exited an hour ago.
 * @param path - the endpoint file; defaults to the one location the shell writes.
 * @param now - the clock, injected so a test can age a stamp without sleeping.
 * @returns what the panel shows.
 */
export declare function readBridgeEndpoint(path?: string, now?: number): BridgeEndpointState;
/**
 * The endpoint file's mtime, for diagnostics that want to say "written at".
 *
 * Separate and optional: the readiness report does not need it, and a caller that does can fail
 * without disturbing anything else.
 * @param path - the endpoint file.
 * @returns the mtime as ISO, or undefined.
 */
export declare function bridgeEndpointWrittenAt(path?: string): string | undefined;
