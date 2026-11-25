/** Prepare an Electron runtime in the plugin-owned runtime directory (or an explicit external package), never the plugin dependency closure. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { internals, managedElectronDir } from './remote-host.ts'

/** How long a background provision may run before it is abandoned. */
export const PROVISION_TIMEOUT_MS = 180_000

/** Default Electron package version fetched into the managed runtime directory when none is already installed. */
export const MANAGED_ELECTRON_VERSION = '44.10.0'

/** What happened, in terms a log line can carry. */
export interface ProvisionResult {
  /** `present` — nothing to do; `ready` — provisioned now; `skipped` — opted out; `failed`. */
  readonly status: 'present' | 'ready' | 'skipped' | 'failed'
  /** One line for the log; never contains a stack trace a user has to decode. */
  readonly detail: string
}

/**
 * The state a settings panel shows, which is one state wider than {@link ProvisionResult}.
 *
 * `idle` and `preparing` are the two a log line never needs and a user always does: "nothing has
 * been asked for yet" and "a ~100 MB download is running right now" are the states in which a first
 * browser call is slow, and until this existed neither was visible anywhere in the product — the
 * only trace was a log line the panel cannot read.
 */
export interface ProvisionSnapshot {
  /** `idle` and `preparing` are provisional; the rest are terminal for this attempt. */
  readonly state: 'idle' | 'preparing' | 'present' | 'ready' | 'skipped' | 'failed'
  /** One line, already user-facing: never a stack trace. */
  readonly detail: string
  /** When the state last changed, ISO. */
  readonly at: string
}

const IDLE: ProvisionSnapshot = {
  state: 'idle',
  detail: 'the runtime has not been asked for yet',
  at: new Date(0).toISOString(),
}

let latest: ProvisionSnapshot = IDLE

/**
 * The current provisioning state, for a readiness report.
 *
 * Deliberately a snapshot rather than a promise: a panel polling this must be able to answer in one
 * synchronous read, without awaiting (and thereby echoing) the download it is reporting on.
 * @returns the last state written, or the idle state before anything ran.
 */
export function provisionSnapshot(): ProvisionSnapshot {
  return latest
}

/** Replace the reported state. Internal: every terminal result is recorded here. */
function record(result: ProvisionResult): ProvisionResult {
  latest = { state: result.status, detail: result.detail, at: new Date().toISOString() }
  return result
}

/** Everything this module touches from the outside, so a test can drive it without Electron. */
export interface ProvisionDeps {
  /** Whether a spawnable binary already exists. */
  readonly hasBinary: () => boolean
  /** The electron package's own installer script, or undefined when it is not there yet. */
  readonly installerScript: () => string | undefined
  /**
   * Optional bootstrap step when `installerScript()` is not on disk yet (e.g. fetching the lightweight
   * `electron` npm wrapper package into `$DSH_HOME/dsh-builtin-browser-host/electron-runtime`).
   */
  readonly bootstrapPackage?: (signal?: AbortSignal) => Promise<{ ok: boolean; detail?: string }>
  /** Runs the installer; resolves to an exit code, or rejects/returns null on failure. */
  readonly run: (script: string, signal?: AbortSignal) => Promise<{ code: number | null; detail?: string }>
  /** Where the outcome goes. */
  readonly log: (message: string) => void
  /** Opt-out honoured exactly like the install script honours it. */
  readonly skip: () => boolean
  /** Budget for one provision. */
  readonly timeoutMs: number
}

/**
 * Whether a spawnable Electron binary is already available.
 *
 * Resolved through the same probe the host uses, so this can never disagree with what a launch
 * would find: a second, cheaper-looking check would be the classic way to report "ready" and then
 * fail at spawn time.
 * @returns true when a launch would find a binary.
 */
export function hasElectronRuntime(): boolean {
  try {
    internals.resolveElectronPath()
    return true
  } catch {
    return false
  }
}

/** Resolve the target `electron` package directory: explicit external override, else plugin-managed runtime dir. */
function targetPackageDir(): string | undefined {
  const override = process.env.DSH_BROWSER_ELECTRON_PACKAGE
  if (override !== undefined) {
    if (!override || !isAbsolute(override)) return undefined
    return override
  }
  return join(managedElectronDir(), 'node_modules', 'electron')
}

/**
 * @returns the electron package's `install.js` path when present and valid, or undefined.
 */
function electronInstallerScript(): string | undefined {
  try {
    const directory = targetPackageDir()
    if (!directory) return undefined
    const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown }
    if (metadata.name !== 'electron') return undefined
    const script = join(directory, 'install.js')
    return existsSync(script) ? script : undefined
  } catch {
    return undefined
  }
}

/** The Electron version the installed package asks for, for a log line that names the download. */
function electronVersion(): string {
  try {
    const directory = targetPackageDir()
    if (!directory) return MANAGED_ELECTRON_VERSION
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : MANAGED_ELECTRON_VERSION
  } catch {
    return MANAGED_ELECTRON_VERSION
  }
}

/**
 * Fetch the lightweight `electron` npm wrapper (`--ignore-scripts`, ~100 KB) into the managed runtime
 * directory so its `install.js` can subsequently download the platform binary with full mirror/proxy support.
 */
async function bootstrapManagedPackage(signal?: AbortSignal): Promise<{ ok: boolean; detail?: string }> {
  if (process.env.DSH_BROWSER_ELECTRON_PACKAGE !== undefined) {
    return { ok: false, detail: 'DSH_BROWSER_ELECTRON_PACKAGE is set; provide an existing absolute electron package directory' }
  }
  const runtimeDir = managedElectronDir()
  const targetPkg = join(runtimeDir, 'node_modules', 'electron')
  if (existsSync(join(targetPkg, 'install.js'))) return { ok: true }
  mkdirSync(runtimeDir, { recursive: true })
  const stagingDir = join(runtimeDir, `.staging-${process.pid}-${randomUUID()}`)
  mkdirSync(stagingDir, { recursive: true })
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const spec = `electron@${process.env.DSH_BROWSER_ELECTRON_VERSION || MANAGED_ELECTRON_VERSION}`
  try {
    const outcome = await new Promise<{ code: number | null; detail?: string }>(resolve => {
      const child = spawn(npm, ['install', '--no-save', '--no-package-lock', '--ignore-scripts', '--prefix', stagingDir, spec], {
        env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: process.platform === 'win32',
        windowsHide: true,
      })
      let stderr = ''
      child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2048) })
      let failure: string | undefined
      const abort = (): void => { try { child.kill('SIGKILL') } catch {} }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.once('error', error => { failure = String(error) })
      child.once('close', code => {
        signal?.removeEventListener('abort', abort)
        resolve({ code, detail: failure ?? (stderr.trim() || undefined) })
      })
    })
    if (outcome.code !== 0) {
      return { ok: false, detail: outcome.detail ?? `npm install ${spec} exited ${String(outcome.code)}` }
    }
    const stagedPkg = join(stagingDir, 'node_modules', 'electron')
    if (!existsSync(join(stagedPkg, 'install.js'))) {
      return { ok: false, detail: `downloaded ${spec} package is missing install.js` }
    }
    mkdirSync(join(runtimeDir, 'node_modules'), { recursive: true })
    rmSync(targetPkg, { recursive: true, force: true })
    renameSync(stagedPkg, targetPkg)
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: String(error) }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

let runningInstaller: Promise<{ code: number | null; detail?: string }> | undefined

/** The real dependencies: this process's spawn, fs and logger. */
export function defaultDeps(log: (message: string) => void = () => {}): ProvisionDeps {
  return {
    hasBinary: hasElectronRuntime,
    installerScript: electronInstallerScript,
    bootstrapPackage: bootstrapManagedPackage,
    run: (script, signal) => {
      if (runningInstaller !== undefined) return runningInstaller
      const run = new Promise<{ code: number | null; detail?: string }>(resolve => {
        const child = spawn(process.execPath, [script], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        })
        let stderr = ''
        child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2048) })
        let failure: string | undefined
        const abort = (): void => { child.kill('SIGKILL') }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
        child.once('error', error => { failure = String(error) })
        child.once('close', code => {
          signal?.removeEventListener('abort', abort)
          resolve({ code, detail: failure ?? (stderr.trim() || undefined) })
        })
      })
      runningInstaller = run
      const clear = (): void => { if (runningInstaller === run) runningInstaller = undefined }
      void run.then(clear, clear)
      return run
    },
    log,
    skip: () => typeof process.env.ELECTRON_SKIP_BINARY_DOWNLOAD === 'string'
      && process.env.ELECTRON_SKIP_BINARY_DOWNLOAD !== '',
    timeoutMs: PROVISION_TIMEOUT_MS,
  }
}

/**
 * Provision the runtime once per process, when it is missing.
 *
 * Concurrent callers share the first attempt: two tool calls arriving together must not start two
 * downloads into the same directory.
 * @param deps - the effects, defaulted to this process's.
 * @returns what happened. Never throws.
 */
export async function ensureElectronRuntime(deps: ProvisionDeps = defaultDeps()): Promise<ProvisionResult> {
  if (deps.hasBinary()) return record({ status: 'present', detail: 'an Electron runtime is already available' })
  if (deps.skip()) return record({ status: 'skipped', detail: 'ELECTRON_SKIP_BINARY_DOWNLOAD is set' })
  const version = electronVersion()
  latest = {
    state: 'preparing',
    detail: `downloading Electron ${version} (one time, about a minute)`,
    at: new Date().toISOString(),
  }
  deps.log(`preparing Electron ${version} in the background (a missing runtime needs a download)`)
  // The bound has to be a REFERENCED timer, and it has to be cleared when the race finishes.
  //
  // A first version unref'd it — "do not keep the process alive for a download" — which is exactly
  // backwards: with nothing else on the loop the timer never fires, the promise never settles, and a
  // caller waiting on it hangs with no error at all. CI caught it before a user could: the test for
  // this path failed with "Promise resolution is still pending but the event loop has already
  // resolved". Keep it referenced, and clear it so a success does not leave a 180 s handle behind.
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  const timeout = new Promise<{ code: number | null; detail: string }>(resolve => {
    timer = setTimeout(
      () => {
        controller.abort()
        resolve({ code: null, detail: `gave up after ${Math.round(deps.timeoutMs / 1000)}s` })
      },
      deps.timeoutMs,
    )
  })
  let outcome: { code: number | null; detail?: string }
  try {
    outcome = await Promise.race([
      (async (): Promise<{ code: number | null; detail?: string }> => {
        let script = deps.installerScript()
        if (script === undefined && deps.bootstrapPackage !== undefined) {
          const boot = await deps.bootstrapPackage(controller.signal)
          if (!boot.ok) return { code: 1, detail: boot.detail ?? 'could not fetch electron package' }
          script = deps.installerScript()
        }
        if (script === undefined) {
          return { code: 1, detail: 'the installed electron package has no install.js; retry from Settings → Browser → Readiness or run `npx --no dsh-browser-install-electron`' }
        }
        return await deps.run(script, controller.signal)
      })(),
      timeout,
    ])
  } catch (error) {
    return record({ status: 'failed', detail: `the download failed: ${String(error)}` })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (outcome.code !== 0) {
    return record({
      status: 'failed',
      detail: `Electron provisioning did not finish (${outcome.detail ?? `exit ${String(outcome.code)}`}); `
        + 'the browser still works through a sidebar, Chrome or Edge; retry from Settings → Browser → '
        + 'Readiness ("Prepare the bundled browser"), or run `npx --no dsh-browser-install-electron`',
    })
  }
  return record({ status: 'ready', detail: 'the Electron runtime is ready' })
}

/** One attempt per process, shared by every caller. */
let attempt: Promise<ProvisionResult> | undefined
/** Whether {@link attempt} has settled, which is what makes a retry possible. */
let settled = false

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
export function provisionElectronInBackground(
  log: (message: string) => void,
  deps: ProvisionDeps = defaultDeps(log),
  options: { readonly force?: boolean } = {},
): Promise<ProvisionResult> {
  if (options.force === true && settled) {
    attempt = undefined
    settled = false
  }
  attempt ??= ensureElectronRuntime(deps).then(result => {
    settled = true
    log(`electron runtime: ${result.status} — ${result.detail}`)
    return result
  })
  return attempt
}

/** Forget the attempt. Tests only: a real process provisions at most once. */
export function resetProvisionStateForTest(): void {
  attempt = undefined
  settled = false
  latest = IDLE
}
