/** Where the shell publishes its bridge endpoint. */
export interface BridgeEndpoint {
    readonly port: number;
    readonly token: string;
    readonly pid: number;
    readonly updatedAt?: string;
}
/**
 * A reusable connection to the bridge.
 *
 * Requests may be in flight CONCURRENTLY, so answers are correlated by id rather than by
 * position: `call()` stamps a unique {@link REQUEST_ID_FIELD} on the request and `onData()`
 * resolves the entry that carries the echoed id. A bridge that does not echo it is still
 * supported — its answer is handed to the oldest outstanding request, which is the
 * arrival-order rule the protocol states. Once such an answer has been seen, the connection
 * stops keeping two requests in flight (a second one re-dials), so position can never be the
 * only thing distinguishing two callers' answers. An answer that matches nothing is never
 * handed to whichever request happens to be first: the socket is dropped instead.
 *
 * A broken socket is discarded so the next call dials again — a dead connection must never
 * become a dead plugin.
 */
export declare class BridgeConnection {
    private endpoint;
    private readonly endpointPath?;
    private socket;
    private buffer;
    /** Outstanding requests by id. */
    private readonly pending;
    /** Ids of the requests sent on the current socket, oldest first. */
    private readonly queue;
    private nextId;
    /** True once any reply arrived without an id: this bridge does not echo request ids. */
    private idLessBridge;
    /** True once this connection may only have one request in flight at a time. */
    private serialisable;
    /**
     * @param endpoint - the shell's published bridge endpoint.
     * @param endpointPath - where that endpoint is republished, so a moved port can be followed.
     */
    constructor(endpoint: BridgeEndpoint, endpointPath?: string | undefined);
    /**
     * Re-read the published endpoint, and adopt it if the shell has moved.
     *
     * The bridge binds an ephemeral port and picks a NEW one whenever its server is recreated. The
     * endpoint file is rewritten every fifteen seconds, but a host that adopted the old one keeps
     * dialling a dead port forever: measured here as `connect ECONNREFUSED 127.0.0.1:52276` while
     * the live bridge sat on 52411. Discarding the socket is not enough — the comment below says a
     * dead connection must never become a dead plugin, and a stale PORT makes exactly that happen.
     *
     * Cheap and safe: one small file read per call, no socket work.
     *
     * @returns true when a different endpoint was adopted.
     */
    private refreshEndpoint;
    /**
     * Send one request, reusing the socket if it is still healthy.
     *
     * Requests may overlap: the request is written as soon as it is queued, so two concurrent
     * callers have two requests in flight. Each carries a unique {@link REQUEST_ID_FIELD}, and
     * `onData()` resolves the entry that carries the echoed id — which is what makes
     * correlation independent of arrival order. A bridge that does not echo the field (the
     * shipped shell today) still works by arrival order; see {@link onData}.
     * @param request - the request body (the token and the request id are added here).
     * @param timeoutMs - how long to wait for the answer before dropping the socket.
     * @returns the bridge's answer.
     */
    call(request: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
    /** Close the socket and fail anything still waiting on it. */
    close(): void;
    /** The live socket, connecting and authenticating it on first use. */
    private ensureSocket;
    /** Tear the connection down for an event raised by `source`, unless it is already gone. */
    private socketFailed;
    /** Resolve queued requests by id, or in order when the bridge does not echo one. */
    private onData;
    /** Forget one request (its answer can no longer be matched). */
    private forget;
    /** Tear the socket down, failing pending work. */
    private reset;
}
