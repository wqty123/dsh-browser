import { createInterface } from 'node:readline';
/** Read RPC lines while keeping transport errors owned by the socket. */
export function createRpcLineReader(socket, onError) {
    socket.on('error', onError);
    const reader = createInterface({ input: socket });
    // readline forwards input errors as its own 'error' event. The socket
    // listener above already reports that same error; receive the forwarded
    // event too so a transport failure does not become uncaughtException.
    reader.on('error', () => { });
    return reader;
}
