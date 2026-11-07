/**
 * One shared definition of process liveness.
 *
 * Signal 0 performs the permission and existence checks and delivers nothing, so it is safe to
 * call on a pid we only read from a file. `EPERM` means the process exists and belongs to
 * someone else, which is still "alive" for the endpoint reader and the profile sweeper alike.
 * @module dsh-browser/browser-electron/process
 */
/**
 * Whether a process with this pid exists, without signalling it.
 * @param pid - the process id to test; a non-integer or non-positive value is never alive.
 * @returns whether that process exists.
 */
export declare function pidAlive(pid: number): boolean;
