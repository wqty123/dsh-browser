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
import { connect } from 'node:net';
/**
 * Safety cap on one un-answered reply line. CDP answers from the sidebar (a screenshot's
 * base64 is the big one) cross this socket, so the cap is generous; what it exists for is a
 * peer that never sends a newline — `this.buffer += chunk` grew without bound, unlike the
 * same buffer in remote-host.ts, which caps at 512 MiB.
 */
const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
/**
 * Field this client adds to every request so the shell can echo it back and never relies on
 * byte order to pair an answer with its request. Loosely named, and additive on purpose: a
 * bridge that does not know it simply ignores it (the current shipped shell does), and the
 * client then falls back to arrival order, which is what the protocol guaranteed before.
 */
const REQUEST_ID_FIELD = 'bridgeRequestId';
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
export class BridgeConnection {
    endpoint;
    socket;
    buffer = '';
    /** Outstanding requests by id. */
    pending = new Map();
    /** Ids of the requests sent on the current socket, oldest first. */
    queue = [];
    nextId = 1;
    /** True once any reply arrived without an id: this bridge does not echo request ids. */
    idLessBridge = false;
    /** True once this connection may only have one request in flight at a time. */
    serialisable = false;
    /**
     * @param endpoint - the shell's published bridge endpoint.
     */
    constructor(endpoint) {
        this.endpoint = endpoint;
    }
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
    async call(request, timeoutMs = 20_000) {
        // One re-dial, and only for the case this exists for: a socket that has already carried
        // an id-less answer cannot have a second request in flight, because two outstanding
        // requests would be matched by position — the swap this correlation prevents. It is a
        // straight-line re-dial rather than a retry loop: an earlier revision re-entered call()
        // from inside its own promise executor, which left an orphaned pending entry behind and,
        // when the condition could not clear, spun until the process ran out of heap.
        let socket = this.ensureSocket();
        if (this.serialisable && this.queue.length > 0) {
            this.reset(new Error('dsh-builtin-browser: bridge connection reopened so replies stay attributable'));
            socket = this.ensureSocket();
        }
        const id = this.nextId++;
        return await new Promise((resolve, reject) => {
            this.pending.set(id, {
                resolve: answer => { clearTimeout(timer); resolve(answer); },
                reject: error => { clearTimeout(timer); reject(error); },
            });
            this.queue.push(id);
            const timer = setTimeout(() => {
                const error = new Error(`dsh-builtin-browser: bridge timed out after ${timeoutMs}ms`);
                // An unanswered request desynchronises the stream for an id-less bridge, and leaves one
                // outstanding for one that echoes ids — either way the next call should start on a
                // fresh socket. Only when THIS request's socket is still the live one: tearing down the
                // REPLACEMENT because an abandoned request timed out would break whatever is using it.
                //
                // This test used to read `this.pending.has(id) && this.socket === socket`, with
                // `forget(id)` on the line above it — and forget() is what removes the entry that `has`
                // was looking for, so the condition was false every single time and the rebuild never
                // ran. A timed-out call therefore left the desynchronised socket in place, and every
                // later call inherited exactly the ambiguity this reset exists to clear. Deciding
                // before forgetting is the whole fix; the `else` still drops the stale entry.
                if (this.socket === socket)
                    this.reset(error);
                else
                    this.forget(id);
                // reset() already rejected this entry through its wrapper when it ran, so this is
                // either the only rejection or a no-op that guarantees the caller settles.
                reject(error);
            }, timeoutMs);
            try {
                // The id is added LAST so a request body can never shadow it, and the token is
                // added here rather than by the caller.
                socket.write(JSON.stringify({ token: this.endpoint.token, ...request, [REQUEST_ID_FIELD]: id }) + '\n');
            }
            catch (error) {
                clearTimeout(timer);
                this.forget(id);
                const failure = error instanceof Error ? error : new Error(String(error));
                if (this.socket === socket)
                    this.reset(failure);
                reject(failure);
            }
        });
    }
    /** Close the socket and fail anything still waiting on it. */
    close() {
        this.reset(new Error('dsh-builtin-browser: bridge closed'));
    }
    /** The live socket, connecting and authenticating it on first use. */
    ensureSocket() {
        if (this.socket !== undefined)
            return this.socket;
        const socket = connect({ host: '127.0.0.1', port: this.endpoint.port });
        socket.setEncoding('utf8');
        socket.on('data', chunk => this.onData(String(chunk)));
        // Both handlers pass the socket they belong to, so a late event from a socket that was
        // already replaced cannot tear down its successor: 'close' still fires for a socket that
        // was removed mid-recycle, and acting on it there would kill a perfectly good connection.
        socket.on('error', error => this.socketFailed(socket, error));
        socket.on('close', () => this.socketFailed(socket, new Error('dsh-builtin-browser: bridge connection closed')));
        this.buffer = '';
        this.socket = socket;
        socket.write(JSON.stringify({ token: this.endpoint.token }) + '\n');
        return socket;
    }
    /** Tear the connection down for an event raised by `source`, unless it is already gone. */
    socketFailed(source, error) {
        if (this.socket !== source)
            return;
        this.reset(error);
    }
    /** Resolve queued requests by id, or in order when the bridge does not echo one. */
    onData(chunk) {
        this.buffer += chunk;
        // A peer that never sends a newline must not grow this buffer without bound. Failing
        // the connection is the honest outcome: the caller gets an error naming the cap, while
        // the next call dials a fresh socket.
        if (this.buffer.length > MAX_BUFFER_BYTES) {
            this.buffer = '';
            this.reset(new Error(`dsh-builtin-browser: bridge reply exceeded ${String(MAX_BUFFER_BYTES)} bytes`));
            return;
        }
        let newline = this.buffer.indexOf('\n');
        while (newline !== -1) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            newline = this.buffer.indexOf('\n');
            if (line === '')
                continue;
            const echoed = echoOf(line);
            const id = echoed ?? this.queue[0];
            if (id === undefined) {
                // Nothing is waiting for this answer: the peer is answering something this socket
                // never asked (or answered twice). Drop the socket rather than trust the stream.
                this.reset(new Error('dsh-builtin-browser: bridge answered with no request outstanding'));
                return;
            }
            const index = this.queue.indexOf(id);
            if (index !== -1)
                this.queue.splice(index, 1);
            const entry = this.pending.get(id);
            if (entry === undefined)
                continue;
            this.pending.delete(id);
            // Id-less bridges pair by order, so a reply for the WRONG request cannot be told apart
            // from the right one. Remember that this bridge does not echo ids, and serialise every
            // later call so the ambiguity cannot arise again.
            if (echoed === undefined) {
                this.idLessBridge = true;
                this.serialisable = true;
            }
            try {
                const answer = JSON.parse(line);
                // A rejected token means the shell restarted with a new one, so this socket
                // can never succeed again: answer (the caller needs the error) and drop it,
                // so the next call dials afresh instead of retrying a doomed credential.
                if (answer.ok === false && answer.error === 'bad token') {
                    entry.resolve(answer);
                    this.reset(new Error('dsh-builtin-browser: the bridge rejected our token'));
                    continue;
                }
                entry.resolve(answer);
            }
            catch (error) {
                entry.reject(new Error(`dsh-builtin-browser: malformed bridge answer (${String(error)})`));
            }
        }
    }
    /** Forget one request (its answer can no longer be matched). */
    forget(id) {
        this.pending.delete(id);
        const index = this.queue.indexOf(id);
        if (index !== -1)
            this.queue.splice(index, 1);
    }
    /** Tear the socket down, failing pending work. */
    reset(error) {
        if (this.socket !== undefined) {
            const socket = this.socket;
            this.socket = undefined;
            socket.removeAllListeners();
            socket.destroy();
        }
        this.buffer = '';
        this.queue.length = 0;
        const pending = [...this.pending.values()];
        this.pending.clear();
        for (const entry of pending)
            entry.reject(error);
    }
}
/** The request id a raw answer line echoes back, when it carries one. */
function echoOf(line) {
    try {
        const answer = JSON.parse(line);
        const value = answer[REQUEST_ID_FIELD];
        return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
    }
    catch {
        // A malformed line cannot be matched by id; the caller consumes it in order and
        // reports the parse failure itself.
        return undefined;
    }
}
