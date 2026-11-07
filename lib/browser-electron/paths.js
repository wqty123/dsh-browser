/**
 * Where DSH keeps the plugin's per-user state.
 *
 * Every reader — settings, history, the profile root, the maintenance plan and the desktop
 * bridge endpoint — must resolve DSH_HOME the same way. The expression used to be inlined in
 * each module, which let one of them drift to a different directory and produced two
 * half-profiles that never met (see the note in entry.ts).
 * @module dsh-browser/browser-electron/paths
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Absolute path of the DSH home directory; DSH_HOME overrides the per-user default. */
export function dshHome() {
    return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
/** Absolute path of the endpoint file the running desktop shell publishes. */
export function bridgeEndpointPath() {
    return join(dshHome(), 'dsh-builtin-browser-bridge.json');
}
