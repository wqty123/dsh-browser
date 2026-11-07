/**
 * Prepare the Electron runtime *when it is needed*, instead of making installation depend on it.
 *
 * Reported as issue #41, from a real plugin-market install of 0.5.2:
 *
 *   [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: dsh-builtin-browser@0.5.2
 *
 * and, once the build script was allowed:
 *
 *   postinstall: Preparing Electron 44.10.1 … TypeError: fetch failed
 *   postinstall: Electron installation failed (exit 1). … [ELIFECYCLE] Command failed with exit code 1
 *
 * Two defects in one design, and both are about WHERE the download lives:
 *
 * 1. A `postinstall` puts a ~100 MB network download inside package installation. pnpm blocks
 *    install scripts by default (`strict-dep-builds`), so the plugin could not be installed at all
 *    on a default pnpm 11 profile; and if the download fails for any reason the *whole install*
 *    fails, which is a network condition reported as "the plugin is broken".
 * 2. Nothing forced the download to happen at install time. The carrier that needs Electron is one
 *    of four, and on the desktop the sidebar needs none.
 *
 * So installation is offline by construction now, and this module does the work later: on plugin
 * start when the operator explicitly asked for the bundled carrier, and never fatally — a failure
 * here is a log line plus the existing, actionable resolution error that names the command to run.
 *
 * Being non-fatal is the point, not a detail: this runs inside a request-serving process, and a
 * download that hangs must not be able to hold a browser tool call open.
 * @module dsh-browser/browser-electron/electron-provision
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { internals } from './remote-host.js';
/** How long a background provision may run before it is abandoned. */
export const PROVISION_TIMEOUT_MS = 180_000;
const IDLE = {
    state: 'idle',
    detail: 'the runtime has not been asked for yet',
    at: new Date(0).toISOString(),
};
let latest = IDLE;
/**
 * The current provisioning state, for a readiness report.
 *
 * Deliberately a snapshot rather than a promise: a panel polling this must be able to answer in one
 * synchronous read, without awaiting (and thereby echoing) the download it is reporting on.
 * @returns the last state written, or the idle state before anything ran.
 */
export function provisionSnapshot() {
    return latest;
}
/** Replace the reported state. Internal: every terminal result is recorded here. */
function record(result) {
    latest = { state: result.status, detail: result.detail, at: new Date().toISOString() };
    return result;
}
/**
 * Whether a spawnable Electron binary is already available.
 *
 * Resolved through the same probe the host uses, so this can never disagree with what a launch
 * would find: a second, cheaper-looking check would be the classic way to report "ready" and then
 * fail at spawn time.
 * @returns true when a launch would find a binary.
 */
export function hasElectronRuntime() {
    try {
        internals.resolveElectronPath();
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The installed electron package's installer script.
 *
 * `require.resolve('electron/package.json')` is used rather than `require('electron')`: inside an
 * Electron main process that module name is the built-in API, and requiring the package would
 * download the binary as a side effect of asking about it.
 * @returns the path to the dependency's own install script, or undefined.
 */
function electronInstallerScript() {
    try {
        const require = createRequire(import.meta.url);
        const manifestPath = require.resolve('electron/package.json');
        const script = join(dirname(manifestPath), 'install.js');
        return existsSync(script) ? script : undefined;
    }
    catch {
        return undefined;
    }
}
/** The Electron version the installed package asks for, for a log line that names the download. */
function electronVersion() {
    try {
        const require = createRequire(import.meta.url);
        const manifest = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8'));
        return typeof manifest.version === 'string' ? manifest.version : 'unknown';
    }
    catch {
        return 'unknown';
    }
}
let runningInstaller;
/** The real dependencies: this process's spawn, fs and logger. */
export function defaultDeps(log = () => { }) {
    return {
        hasBinary: hasElectronRuntime,
        installerScript: electronInstallerScript,
        run: (script, signal) => {
            if (runningInstaller !== undefined)
                return runningInstaller;
            const run = new Promise(resolve => {
                const child = spawn(process.execPath, [script], {
                    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                    stdio: ['ignore', 'ignore', 'ignore'],
                    windowsHide: true,
                });
                let failure;
                const abort = () => { child.kill('SIGKILL'); };
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted)
                    abort();
                child.once('error', error => { failure = String(error); });
                child.once('close', code => {
                    signal?.removeEventListener('abort', abort);
                    resolve({ code, detail: failure });
                });
            });
            runningInstaller = run;
            const clear = () => { if (runningInstaller === run)
                runningInstaller = undefined; };
            void run.then(clear, clear);
            return run;
        },
        log,
        skip: () => typeof process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === 'string'
            && process.env.ELECTRON_SKIP_BINARY_DOWNLOAD !== '',
        timeoutMs: PROVISION_TIMEOUT_MS,
    };
}
/**
 * Provision the runtime once per process, when it is missing.
 *
 * Concurrent callers share the first attempt: two tool calls arriving together must not start two
 * downloads into the same directory.
 * @param deps - the effects, defaulted to this process's.
 * @returns what happened. Never throws.
 */
export async function ensureElectronRuntime(deps = defaultDeps()) {
    if (deps.hasBinary())
        return record({ status: 'present', detail: 'an Electron runtime is already available' });
    if (deps.skip())
        return record({ status: 'skipped', detail: 'ELECTRON_SKIP_BINARY_DOWNLOAD is set' });
    const script = deps.installerScript();
    if (script === undefined) {
        return record({ status: 'failed', detail: 'the installed electron package has no install.js; reinstall the plugin in this profile' });
    }
    // Resolve the installed Electron version once: each call re-runs createRequire,
    // require.resolve and a synchronous package.json read + parse.
    const version = electronVersion();
    latest = {
        state: 'preparing',
        detail: `downloading Electron ${version} (one time, about a minute)`,
        at: new Date().toISOString(),
    };
    deps.log(`preparing Electron ${version} in the background (a missing runtime needs a download)`);
    // The bound has to be a REFERENCED timer, and it has to be cleared when the race finishes.
    //
    // A first version unref'd it — "do not keep the process alive for a download" — which is exactly
    // backwards: with nothing else on the loop the timer never fires, the promise never settles, and a
    // caller waiting on it hangs with no error at all. CI caught it before a user could: the test for
    // this path failed with "Promise resolution is still pending but the event loop has already
    // resolved". Keep it referenced, and clear it so a success does not leave a 180 s handle behind.
    let timer;
    const controller = new AbortController();
    const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
            controller.abort();
            resolve({ code: null, detail: `gave up after ${Math.round(deps.timeoutMs / 1000)}s` });
        }, deps.timeoutMs);
    });
    let outcome;
    try {
        outcome = await Promise.race([deps.run(script, controller.signal), timeout]);
    }
    catch (error) {
        return record({ status: 'failed', detail: `the download failed: ${String(error)}` });
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
    if (outcome.code !== 0) {
        return record({
            status: 'failed',
            detail: `Electron provisioning did not finish (${outcome.detail ?? `exit ${String(outcome.code)}`}); `
                + 'the browser still works through a sidebar, Chrome or Edge; retry from Settings → Browser → '
                + 'Readiness ("Prepare the bundled browser"), or run `npx --no dsh-browser-install-electron`',
        });
    }
    return record({ status: 'ready', detail: 'the Electron runtime is ready' });
}
/** One attempt per process, shared by every caller. */
let attempt;
/** Whether {@link attempt} has settled, which is what makes a retry possible. */
let settled = false;
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
export function provisionElectronInBackground(log, deps = defaultDeps(log), options = {}) {
    if (options.force === true && settled) {
        attempt = undefined;
        settled = false;
    }
    attempt ??= ensureElectronRuntime(deps).then(result => {
        settled = true;
        log(`electron runtime: ${result.status} — ${result.detail}`);
        return result;
    });
    return attempt;
}
/** Forget the attempt. Tests only: a real process provisions at most once. */
export function resetProvisionStateForTest() {
    attempt = undefined;
    settled = false;
    latest = IDLE;
}
