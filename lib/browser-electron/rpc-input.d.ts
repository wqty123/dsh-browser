import type { Socket } from 'node:net';
import { type Interface } from 'node:readline';
/** Read RPC lines while keeping transport errors owned by the socket. */
export declare function createRpcLineReader(socket: Socket, onError: (error: Error) => void): Interface;
