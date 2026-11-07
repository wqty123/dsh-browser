/**
 * Install, repair or remove the desktop bridge from the settings panel.
 *
 * Maintenance changes files after the target Desktop has exited. The installer checks this before
 * writing; the panel never asks it to close or restart its own host. The same packaged installer
 * owns identity checks, backups and patching for both the panel and an external terminal.
 * @module dsh-browser/browser-electron/bridge-install
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeConnection } from './bridge-connection.js';
import { bridgeEndpointPath } from './paths.js';
/**
 * Verify that the restarted process published a working authenticated bridge.
 * A previous shell's endpoint, a listening socket, or an authentication refusal is insufficient.
 */
export async function waitForRestartedBridge(pid, options = {}) {
    const path = options.endpointPath ?? bridgeEndpointPath();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const endpoint = JSON.parse(await readFile(path, 'utf8'));
            if (endpoint !== null && typeof endpoint === 'object' && endpoint.pid === pid
                && Number.isInteger(endpoint.port) && Number(endpoint.port) > 0 && Number(endpoint.port) <= 65535
                && typeof endpoint.token === 'string' && endpoint.token.trim() !== '') {
                const remaining = deadline - Date.now();
                if (remaining <= 0)
                    break;
                const connection = new BridgeConnection({ port: Number(endpoint.port), token: endpoint.token, pid });
                try {
                    const answer = await connection.call({ op: 'list' }, Math.min(1_000, remaining));
                    if (answer.ok === true && Array.isArray(answer.guests) && Array.isArray(answer.sidebar))
                        return;
                }
                finally {
                    connection.close();
                }
            }
        }
        catch {
            // Endpoint publication and the socket can race startup. Diagnostics deliberately exclude
            // the endpoint body and authentication token; the caller retains the installer's own log.
        }
        const remaining = deadline - Date.now();
        if (remaining > 0)
            await new Promise(resolve => setTimeout(resolve, Math.min(options.pollMs ?? 100, remaining)));
    }
    throw new Error(`the restarted DSH Desktop bridge did not become ready within ${String(timeoutMs)}ms`);
}
/**
 * Wait for completed file maintenance. The installer publishes this file by rename so a reader
 * cannot accept a partial result. A panel operation must report no Desktop restart.
 */
export async function waitForBridgeActionCompletion(path, action, timeoutMs = 180_000, pollMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let text;
        try {
            text = await readFile(path, 'utf8');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        if (text !== undefined) {
            let record;
            try {
                record = JSON.parse(text);
            }
            catch {
                throw new Error('the bridge installer wrote an unreadable completion record');
            }
            if (record === null || typeof record !== 'object'
                || record.action !== action || typeof record.ok !== 'boolean'
                || !Number.isSafeInteger(record.code) || record.restarted !== false
                || typeof record.completedAt !== 'string' || !Number.isFinite(Date.parse(record.completedAt))
                || record.pid !== undefined
                || (record.error !== undefined && typeof record.error !== 'string')
                || (record.ok !== (record.code === 0))) {
                throw new Error('the bridge installer wrote an invalid completion record');
            }
            return record;
        }
        if (Date.now() >= deadline)
            throw new Error(`the bridge installer did not report completion within ${String(timeoutMs)}ms`);
        await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
    }
}
/**
 * The argv the installer expects, in one place so the panel and a human run the same thing.
 *
 * The target Desktop must already be closed. In particular, the panel cannot grant its child
 * permission to terminate the process that owns the current tool call or settings request.
 * @param action - install/repair, or restore the pre-bridge state.
 * @param installRoot - the desktop install directory that was discovered.
 * @returns argv for the installer.
 */
export function bridgeActionArgv(action, installRoot) {
    const argv = [installRoot];
    if (action === 'uninstall')
        argv.push('--revert');
    return argv;
}
/** The packaged installer, resolved from this module rather than from a build-time path. */
export function defaultInstallerPath() {
    return fileURLToPath(new URL('../../desktop-bridge/install.mjs', import.meta.url));
}
/** One line from a long output: the tail is what names the failure. */
function tail(text, limit = 600) {
    const trimmed = text.trim();
    return trimmed.length > limit ? '…' + trimmed.slice(-limit) : trimmed;
}
/** Default runner: the host's own node, a bounded wait, and no shell (so a path with spaces is data). */
function defaultRun(command, argv, environment) {
    return new Promise(resolve => {
        const child = spawn(command, [...argv], {
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
            env: environment === undefined ? process.env : { ...process.env, ...environment },
        });
        let output = '';
        const collect = (chunk) => { output += String(chunk); if (output.length > 20_000)
            output = output.slice(-20_000); };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        const timer = setTimeout(() => { try {
            child.kill();
        }
        catch { /* already gone */ } }, 180_000);
        child.on('error', error => { clearTimeout(timer); resolve({ code: null, output: `${output}\nfailed to start: ${String(error)}` }); });
        child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
    });
}
/**
 * Run one bridge action.
 *
 * Never throws for an installer failure: the panel needs the exit code and the line that explains it,
 * and an exception would lose both.
 * @param action - install/repair or uninstall.
 * @param installRoot - the desktop install directory.
 * @param deps - effects; defaulted to this process's.
 * @returns the outcome, with the command line for reproduction.
 */
export async function runBridgeAction(action, installRoot, deps = {
    run: defaultRun, installer: defaultInstallerPath, node: () => process.execPath, trackResult: true,
}) {
    const command = deps.node();
    const argv = [deps.installer(), ...bridgeActionArgv(action, installRoot)];
    const printable = [command, ...argv].map(part => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
    let resultFile;
    let logFile;
    let installerOutput = '';
    const recordedOutput = async () => {
        if (logFile === undefined)
            return '';
        try {
            return (await readFile(logFile, 'utf8')).slice(-20_000);
        }
        catch (error) {
            console.error(`[dsh-browser] cannot read the installer log: ${String(error)}`);
            return '';
        }
    };
    try {
        // Ask the installer to check identity FIRST, without touching anything. It is the same preflight
        // a human can run, and it turns "the button did nothing" into a named reason.
        const preflight = await deps.run(command, [argv[0], installRoot, '--preflight']);
        const verdict = (() => {
            try {
                return JSON.parse(preflight.output.trim().split('\n').at(-1) ?? '{}');
            }
            catch {
                return {};
            }
        })();
        if (preflight.code !== 0 || verdict.ok !== true) {
            return {
                ok: false,
                code: preflight.code,
                output: tail(String(verdict.reason ?? preflight.output)),
                command: printable,
            };
        }
        let environment;
        const deadline = Date.now() + (deps.resultTimeoutMs ?? 180_000);
        if (deps.trackResult === true) {
            const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-action-'));
            resultFile = join(directory, 'result.json');
            logFile = join(directory, 'installer.log');
            environment = { DSH_BRIDGE_ACTION_RESULT_FILE: resultFile, DSH_BRIDGE_ACTION_LOG_FILE: logFile };
        }
        const result = await deps.run(command, argv, environment);
        installerOutput = result.output;
        if (result.code !== 0 || resultFile === undefined) {
            return { ok: result.code === 0, code: result.code, output: tail(result.output), command: printable, restarted: false,
                ...resultFile === undefined ? {} : { resultFile, logFile } };
        }
        const final = await waitForBridgeActionCompletion(resultFile, action, Math.max(0, deadline - Date.now()), deps.resultPollMs);
        const output = [installerOutput, await recordedOutput(), final.error].filter(Boolean).join('\n');
        return { ok: final.ok, code: final.code, output: tail(output), command: printable, resultFile, logFile,
            restarted: final.restarted, ...final.pid === undefined ? {} : { pid: final.pid } };
    }
    catch (error) {
        return { ok: false, code: null,
            output: tail([installerOutput, await recordedOutput(), String(error)].filter(Boolean).join('\n')),
            command: printable, ...resultFile === undefined ? {} : { resultFile, logFile } };
    }
}
