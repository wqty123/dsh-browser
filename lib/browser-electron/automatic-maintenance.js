/** User-requested Windows maintenance, coordinated outside the Desktop process tree. */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat as statAsync, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareBridgeMaintenance } from './bridge-maintenance.js';
import { launchMaintenanceBroker } from './maintenance-broker.js';
import { runMaintenanceLifecycle } from './maintenance-lifecycle.js';
import { defaultInstallerPath, runBridgeAction, waitForRestartedBridge } from './bridge-install.js';
import { readDesktopIdentity } from './desktop-identity.js';
import { dshHome } from './paths.js';
import { encodePowerShellScript, windowsPowerShellPath } from './windows-system.js';
const terminal = new Set(['completed', 'failed', 'cancelled']);
const workerPath = fileURLToPath(new URL('./automatic-maintenance.js', import.meta.url));
const quitPath = fileURLToPath(new URL('../../desktop-bridge/request-desktop-quit.ps1', import.meta.url));
const progressPath = fileURLToPath(new URL('../../desktop-bridge/maintenance-progress.ps1', import.meta.url));
const delay = async (ms) => await new Promise(resolve => setTimeout(resolve, ms));
/** A swallowed maintenance write still deserves one line of diagnostics; it never changes the answer. */
function reportMaintenanceFailure(label, error) {
    console.error(`[dsh-browser maintenance] ${label}: ${String(error)}`);
}
function homePath() { return resolve(dshHome()); }
function basePath(home = homePath()) { return join(home, 'dsh-builtin-browser-host', 'maintenance'); }
function inside(base, path) {
    const part = relative(base, path);
    return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../');
}
function requireLiveWindows() {
    if (process.platform !== 'win32')
        throw new Error('automatic bridge maintenance requires Windows Desktop');
    if (process.env.DSH_BROWSER_TEST === '1' || process.env.NODE_TEST_CONTEXT !== undefined) {
        throw new Error('automatic Desktop maintenance is forbidden in a test process');
    }
}
async function execute(command, args, timeout = 15_000, environment) {
    return await new Promise(resolve => {
        execFile(command, [...args], { windowsHide: true, shell: false, encoding: 'utf8', timeout, maxBuffer: 1_048_576,
            ...(environment === undefined ? {} : { env: environment }) }, (error, stdout, stderr) => {
            resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, output: `${stdout}\n${stderr}`.trim(), stdout });
        });
    });
}
async function desktopProcesses(root) {
    const script = "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $rows = @((Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" -ErrorAction Stop) | ForEach-Object { @{pid=[int]$_.ProcessId;path=$_.ExecutablePath;command=$_.CommandLine;started=$_.CreationDate.ToUniversalTime().ToString('o')} }); ConvertTo-Json -InputObject $rows -Compress";
    const r = await execute(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellScript(script)]);
    if (r.code !== 0)
        throw new Error('cannot inspect running DSH Desktop processes');
    let value;
    try {
        value = JSON.parse(r.stdout.replace(/^\uFEFF/, '').trim());
    }
    catch {
        throw new Error('Desktop process inspection returned invalid data');
    }
    const rows = Array.isArray(value) ? value : value === null ? [] : [value];
    const expected = resolve(root, 'DeepSeek Harness.exe').toLowerCase();
    return rows.filter((row) => {
        if (row === null || typeof row !== 'object')
            throw new Error('Desktop process inspection was incomplete');
        const p = row;
        if (typeof p.path !== 'string' || p.path === '' || typeof p.command !== 'string' || !Number.isSafeInteger(p.pid) || typeof p.started !== 'string') {
            throw new Error('cannot identify a running DSH Desktop process');
        }
        if (resolve(p.path).toLowerCase() !== expected)
            return false;
        // The Desktop also ships a Node-mode CLI under this exe; it is not a GUI to close.
        return !/(?:^|\s)--expose-internals(?:\s|$)|\.[cm]?js(?:"|\s|$)|(?:^|\s)(?:--eval|--print|--input-type)(?:=|\s|$)|(?:^|\s)-(?:e|p)(?:\s|$)/i.test(p.command);
    });
}
async function atomicJson(path, value, exclusive = false) {
    if (exclusive && existsSync(path)) {
        const error = new Error(`EEXIST: ${path} already exists`);
        error.code = 'EEXIST';
        throw error;
    }
    const temp = `${path}.${String(process.pid)}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, path);
}
/** Data-only argv for the independent, read-only progress window. This function starts nothing. */
export function maintenanceProgressLaunchOptions(jobId, directory, locale = 'zh', powershellPath = windowsPowerShellPath()) {
    if (typeof jobId !== 'string' || !/^(?:install|uninstall)-[A-Za-z0-9]+$/.test(jobId)
        || typeof directory !== 'string' || !isAbsolute(directory) || basename(directory) !== jobId
        || !['zh', 'en'].includes(locale))
        throw new Error('invalid maintenance progress request');
    return {
        runtimePath: powershellPath,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', progressPath,
            '-StatePath', join(directory, 'state.json'), '-JobId', jobId, '-Locale', locale],
        cwd: directory,
        environment: { ELECTRON_RUN_AS_NODE: undefined },
    };
}
/**
 * Attempt the optional window once per job, after commit and before requesting normal Desktop quit.
 * A missing helper, denied broker or diagnostic write cannot change the maintenance outcome.
 */
export async function startMaintenanceProgressNotification(options, deps = {}) {
    let directory;
    let result;
    try {
        const request = maintenanceProgressLaunchOptions(options.jobId, options.directory, options.locale ?? 'zh', (deps.powershellPath ?? windowsPowerShellPath)());
        directory = options.directory;
        try {
            const claim = await open(join(directory, 'progress-notification.claim'), 'wx', 0o600);
            await claim.close();
        }
        catch (error) {
            if (error.code === 'EEXIST')
                return { started: false, skipped: true, at: new Date().toISOString() };
            throw error;
        }
        if (!(deps.helperExists ?? existsSync)(progressPath))
            throw new Error('the packaged maintenance progress window is unavailable');
        const launched = await (deps.launch ?? launchMaintenanceBroker)(request);
        result = { started: true, at: new Date().toISOString(), pid: launched.pid };
    }
    catch (error) {
        result = { started: false, at: new Date().toISOString(), error: String(error) };
    }
    if (directory !== undefined) {
        await atomicJson(join(directory, 'progress-notification.json'), { ...result, jobId: options.jobId })
            .catch(error => reportMaintenanceFailure('cannot write the progress notification', error));
    }
    return result;
}
/** Last durable outcome survives both the settings page and the HTTP host restarting. */
export function readAutomaticMaintenance(home = homePath()) {
    try {
        const base = basePath(home);
        const pointer = JSON.parse(readFileSync(join(base, 'latest.json'), 'utf8'));
        if (typeof pointer.id !== 'string' || typeof pointer.directory !== 'string' || !inside(base, pointer.directory)
            || basename(pointer.directory) !== pointer.id)
            return undefined;
        const state = JSON.parse(readFileSync(join(pointer.directory, 'state.json'), 'utf8'));
        if (state.id !== pointer.id || !['armed', 'closing', 'installing', 'restarting', 'verifying', ...terminal].includes(state.phase)
            || !['install', 'uninstall'].includes(state.action) || !Number.isFinite(Date.parse(state.at)))
            return undefined;
        return state;
    }
    catch {
        return undefined;
    }
}
/** A lock left behind by a killed worker never releases itself; clear only clearly stale ones. */
async function clearStaleLock(lockPath, home) {
    try {
        const info = await statAsync(lockPath);
        // Never touch a lock another request may still be preparing (concurrent start window).
        if (Date.now() - info.mtimeMs < 5 * 60_000)
            return false;
        const id = (await readFile(lockPath, 'utf8')).trim();
        if (!/^(?:install|uninstall)-[A-Za-z0-9]+$/.test(id))
            return false;
        const prior = readAutomaticMaintenance(home);
        if (prior === undefined || prior.id !== id)
            return true;
        if (terminal.has(prior.phase))
            return true;
        const pid = Number(prior.workerPid);
        if (Number.isSafeInteger(pid) && pid > 0) {
            try {
                process.kill(pid, 0);
            }
            catch (error) {
                if (error.code === 'ESRCH')
                    return true;
            }
        }
        return false;
    }
    catch (error) {
        reportMaintenanceFailure('cannot inspect a stale maintenance lock', error);
        return false;
    }
}
async function releaseLock(plan) {
    const lock = join(basePath(plan.home), 'active.lock');
    try {
        if ((await readFile(lock, 'utf8')).trim() === plan.id)
            await unlink(lock);
    }
    catch { /* no other job's lock is touched */ }
}
/** Validate the staged plan again in the independent process before it can request a quit. */
function validatePlan(value, path, now = Date.now()) {
    if (value === null || typeof value !== 'object')
        throw new Error('invalid automatic maintenance plan');
    const plan = value;
    const created = typeof plan.createdAt === 'string' ? Date.parse(plan.createdAt) : NaN;
    if (plan.version !== 1 || !['install', 'uninstall'].includes(plan.action)
        || typeof plan.id !== 'string' || !/^(?:install|uninstall)-[A-Za-z0-9]+$/.test(plan.id)
        || ![plan.root, plan.home, plan.nodePath, plan.directory].every(p => typeof p === 'string' && isAbsolute(p))
        || typeof plan.electronNode !== 'boolean' || !Number.isFinite(created) || created > now || now - created > 30_000
        || (plan.locale !== undefined && !['zh', 'en'].includes(plan.locale))) {
        throw new Error('invalid or expired automatic maintenance plan');
    }
    const checked = plan;
    if (!inside(basePath(checked.home), checked.directory) || dirname(checked.directory) !== basePath(checked.home)
        || basename(checked.directory) !== checked.id || checked.id.split('-')[0] !== checked.action
        || resolve(path) !== join(checked.directory, 'automatic.json') || !readDesktopIdentity(checked.root).ok) {
        throw new Error('invalid automatic maintenance plan paths or target');
    }
    const target = checked.target;
    if (target === null || typeof target !== 'object' || !Number.isSafeInteger(target.pid) || target.pid <= 0
        || typeof target.path !== 'string' || resolve(target.path).toLowerCase() !== join(checked.root, 'DeepSeek Harness.exe').toLowerCase()
        || typeof target.command !== 'string' || /(?:^|\s)--type(?:=|\s)/i.test(target.command)
        || typeof target.started !== 'string' || !Number.isFinite(Date.parse(target.started)) || Date.parse(target.started) > now) {
        throw new Error('invalid automatic maintenance target process');
    }
    return checked;
}
/** Commit only the armed job after its accepted HTTP response has finished writing. */
export async function commitAutomaticMaintenance(jobId, home = homePath()) {
    if (typeof jobId !== 'string' || !/^(?:install|uninstall)-[A-Za-z0-9]+$/.test(jobId))
        throw new Error('invalid bridge maintenance job id');
    const state = readAutomaticMaintenance(home);
    if (state?.id !== jobId || state.phase !== 'armed' || !Number.isSafeInteger(state.workerPid) || Number(state.workerPid) <= 0) {
        throw new Error('the bridge maintenance job is no longer armed');
    }
    const directory = join(basePath(home), jobId);
    const planPath = join(directory, 'automatic.json');
    const plan = validatePlan(JSON.parse(await readFile(planPath, 'utf8')), planPath);
    if (plan.home !== resolve(home) || plan.action !== state.action || existsSync(join(directory, 'cancel.json'))) {
        throw new Error('the bridge maintenance job cannot be committed');
    }
    try {
        await atomicJson(join(directory, 'commit.json'), { id: jobId, workerPid: state.workerPid, at: new Date().toISOString() }, true);
    }
    catch (error) {
        // The worker is polling this file; cancel it at once instead of leaving a successful-looking
        // 202 to turn into a generic "not committed" twenty seconds later. An EEXIST is a duplicate
        // commit of an already-approved job, not a failure: cancelling it would abort good work.
        if (error.code !== 'EEXIST') {
            await atomicJson(join(directory, 'cancel.json'), { at: new Date().toISOString(), reason: String(error) }).catch(() => { });
        }
        throw error;
    }
}
/** Only the new, authenticated explicit-click endpoint calls this function. */
export async function startAutomaticMaintenance(action, root, options = {}) {
    requireLiveWindows();
    if (!['install', 'uninstall'].includes(action))
        throw new Error('invalid bridge maintenance action');
    if (options.locale !== undefined && !['zh', 'en'].includes(options.locale))
        throw new Error('invalid bridge maintenance locale');
    if (!readDesktopIdentity(root).ok)
        throw new Error('the maintenance target is not a verified DSH Desktop installation');
    if (!existsSync(quitPath))
        throw new Error('the packaged Desktop quit helper is missing');
    const processes = await desktopProcesses(root);
    const mains = processes.filter(p => !/(?:^|\s)--type(?:=|\s)/i.test(p.command));
    if (mains.length !== 1)
        throw new Error('automatic maintenance requires one running DSH Desktop window');
    const home = homePath();
    const base = basePath(home);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const lockPath = join(base, 'active.lock');
    let lock;
    try {
        lock = await open(lockPath, 'wx', 0o600);
    }
    catch {
        if (!(await clearStaleLock(lockPath, home)))
            throw new Error('bridge maintenance is already in progress');
        await unlink(lockPath).catch(error => reportMaintenanceFailure('cannot remove a stale maintenance lock', error));
        lock = await open(lockPath, 'wx', 0o600);
    }
    let plan;
    try {
        const prepared = await prepareBridgeMaintenance(action, root, { directory: base });
        const original = JSON.parse(await readFile(prepared.planPath, 'utf8'));
        const id = basename(prepared.directory);
        await lock.writeFile(id + '\n');
        await lock.close();
        plan = { version: 1, id, action, root: resolve(root), nodePath: original.nodePath, electronNode: original.electronNode,
            home, directory: prepared.directory, target: mains[0], createdAt: new Date().toISOString(),
            ...options.locale === undefined ? {} : { locale: options.locale } };
        const path = join(prepared.directory, 'automatic.json');
        await writeFile(path, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await atomicJson(join(base, 'latest.json'), { id, directory: prepared.directory });
        const launched = await launchMaintenanceBroker({ runtimePath: plan.nodePath,
            args: [...plan.electronNode ? ['--expose-internals'] : [], workerPath, '--automatic-maintenance', path], cwd: prepared.directory,
            environment: { DSH_HOME: home, ELECTRON_RUN_AS_NODE: plan.electronNode ? '1' : undefined } });
        // WMI's return code proves creation only. The worker must actually load and publish its arm.
        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline) {
            const state = readAutomaticMaintenance(home);
            if (state?.id === id && state.workerPid === launched.pid) {
                if (state.phase !== 'armed')
                    throw new Error(state.error ?? 'the maintenance worker did not arm');
                return state;
            }
            await delay(100);
        }
        throw new Error('the independent maintenance worker did not become ready');
    }
    catch (error) {
        await lock.close().catch(error => reportMaintenanceFailure('cannot close the maintenance lock', error));
        if (plan !== undefined) {
            await atomicJson(join(plan.directory, 'cancel.json'), { at: new Date().toISOString() })
                .catch(error => reportMaintenanceFailure('cannot stage the maintenance cancellation', error));
            await atomicJson(join(plan.directory, 'state.json'), { id: plan.id, action, phase: 'failed', ok: false, restarted: false,
                at: new Date().toISOString(), startedAt: plan.createdAt, error: String(error) })
                .catch(writeError => reportMaintenanceFailure('cannot record the failed maintenance state', writeError));
            await releaseLock(plan);
        }
        else {
            await unlink(lockPath).catch(error => reportMaintenanceFailure('cannot remove the unused maintenance lock', error));
        }
        throw error;
    }
}
async function runWorker(path) {
    requireLiveWindows();
    const plan = validatePlan(JSON.parse(await readFile(path, 'utf8')), path);
    const checkCancelled = () => {
        if (existsSync(join(plan.directory, 'cancel.json')))
            throw new Error('bridge maintenance was cancelled before Desktop exited');
    };
    process.env.DSH_HOME = plan.home;
    const publish = async (state) => {
        // If the host gave up on this job (readiness timeout), its terminal state wins. Without this
        // a late worker flips "failed" back to "armed" and the settings page oscillates.
        const prior = readAutomaticMaintenance(plan.home);
        if (prior?.id === plan.id && terminal.has(prior.phase))
            return;
        await atomicJson(join(plan.directory, 'state.json'), { ...state, id: plan.id, workerPid: process.pid, startedAt: plan.createdAt });
    };
    try {
        checkCancelled();
        await runMaintenanceLifecycle(plan.action, {
            publish,
            requestQuit: async () => {
                // Arming proves the worker is independent and loaded. It grants no permission to quit
                // until the original request's response has finished and its host commits this exact job.
                const deadline = Date.now() + 20_000;
                let committed = false;
                while (Date.now() < deadline) {
                    checkCancelled();
                    try {
                        const record = JSON.parse(await readFile(join(plan.directory, 'commit.json'), 'utf8'));
                        if (record.id !== plan.id || record.workerPid !== process.pid || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) {
                            throw new Error('invalid bridge maintenance commit');
                        }
                        committed = true;
                        break;
                    }
                    catch (error) {
                        // An empty or half-written commit.json is a transient state, not a cancellation.
                        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError))
                            throw error;
                    }
                    await delay(100);
                }
                if (!committed)
                    throw new Error('the maintenance request was not committed; Desktop remains open');
                checkCancelled();
                await publish({ phase: 'closing', action: plan.action, at: new Date().toISOString() });
                await startMaintenanceProgressNotification({ jobId: plan.id, directory: plan.directory, locale: plan.locale ?? 'zh' });
                const result = await execute(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', quitPath,
                    '-TargetPid', String(plan.target.pid), '-ExpectedExecutable', plan.target.path,
                    '-ExpectedStartTimeUtc', plan.target.started, '-TimeoutSeconds', '20'], 25_000);
                checkCancelled();
                if (result.code !== 0)
                    throw new Error(result.output || 'the official Desktop Quit menu was not available');
            },
            waitUntilClosed: async () => {
                const deadline = Date.now() + 60_000;
                while (Date.now() < deadline) {
                    checkCancelled();
                    if ((await desktopProcesses(plan.root)).length === 0)
                        return;
                    await delay(1_000);
                }
                throw new Error('Desktop did not exit; maintenance was cancelled. Any running-task confirmation remains under your control.');
            },
            maintain: async () => {
                checkCancelled();
                if ((await desktopProcesses(plan.root)).length > 0)
                    throw new Error('DSH Desktop was reopened during maintenance; refusing to modify its files');
                return await runBridgeAction(plan.action, plan.root, {
                    node: () => plan.nodePath, installer: defaultInstallerPath, trackResult: true,
                    run: async (cmd, args, extra) => await execute(cmd, [...plan.electronNode ? ['--expose-internals'] : [], ...args], 180_000, { ...process.env, ...extra, ELECTRON_RUN_AS_NODE: plan.electronNode ? '1' : undefined }),
                });
            },
            restart: async () => {
                if ((await desktopProcesses(plan.root)).length > 0)
                    throw new Error('DSH Desktop is already running; not opening a second instance');
                const identity = readDesktopIdentity(plan.root);
                if (!identity.ok)
                    throw new Error(`Desktop cannot be safely reopened: ${identity.reason}`);
                const environment = { ...process.env };
                for (const key of Object.keys(environment))
                    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE' || key.toUpperCase().startsWith('DSH_BRIDGE_'))
                        delete environment[key];
                return await new Promise((resolve, reject) => {
                    const child = spawn(join(plan.root, 'DeepSeek Harness.exe'), [], { cwd: plan.root, env: environment, stdio: 'ignore', windowsHide: true, detached: true });
                    child.once('error', reject);
                    child.once('spawn', () => { child.unref(); resolve(child.pid); });
                });
            },
            verify: async (pid, action) => {
                if (action === 'install') {
                    await waitForRestartedBridge(pid, { timeoutMs: 45_000 });
                    return;
                }
                await delay(1_500);
                if (!(await desktopProcesses(plan.root)).some(p => p.pid === pid))
                    throw new Error('the reopened Desktop did not remain running');
            },
        });
    }
    catch (error) {
        await publish({ phase: 'cancelled', action: plan.action, at: new Date().toISOString(), ok: false, restarted: false, error: String(error) })
            .catch(writeError => reportMaintenanceFailure('cannot publish the cancelled maintenance state', writeError));
    }
    finally {
        await releaseLock(plan);
    }
}
// Importing this module only exposes functions. Execution requires the private staged plan.
if (process.argv[2] === '--automatic-maintenance' && process.argv[1] !== undefined && resolve(process.argv[1]) === workerPath) {
    void runWorker(resolve(process.argv[3] ?? '')).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
