/**
 * Transport for the desktop shell's browser bridge: one long-lived connection to a
 * loopback TCP service.
 *
 * WHY THIS IS ITS OWN MODULE
 * The bridge used to be reached with a fresh connection per request, which measured
 * at ~25ms per call (TCP handshake + token exchange) against ~0.2ms when the socket
 * is reused. A single browser action issues several CDP commands, so that cost was
 * multiplied on every tool call — the difference between a snappy agent and a
 * visibly sluggish one. Reuse is therefore a property of the transport, and keeping
 * it here means the view host above does not have to think about sockets at all.
 *
 * PROTOCOL
 * The first line on a connection carries the token; the service marks the socket
 * authenticated and ignores that line as a command. Requests and answers are then
 * newline-delimited JSON, one answer per request, in order.
 *
 * @module dsh-browser/browser-electron/bridge-connection
 */
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
    private readonly endpoint;
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
     */
    constructor(endpoint: BridgeEndpoint);
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
