/**
 * Install, repair or remove the desktop bridge from the settings panel.
 *
 * The panel used to print a command and leave the user to copy it into a terminal. That is a defect
 * for this plugin specifically: the command closes and reopens the desktop app, so a half-done manual
 * run (wrong cwd, wrong node, wrong quoting on a path with spaces) leaves the shell in a state the
 * user has to diagnose. The installer already knows how to do the whole dance unattended
 * (`--restart --yes`), so the panel calls it and reports what happened.
 *
 * What this deliberately does NOT do: invent its own patching. Every path, backup and identity check
 * stays inside `desktop-bridge/install.mjs`, which is the same file a human would run.
 * @module dsh-browser/browser-electron/bridge-install
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** What the panel may ask for. */
export type BridgeAction = 'install' | 'uninstall'

/** Everything this module touches from outside, so a test can drive it without spawning. */
export interface BridgeActionDeps {
  /** Runs the installer; resolves with an exit code and the tail of its output. */
  readonly run: (command: string, argv: readonly string[]) => Promise<{ readonly code: number | null; readonly output: string }>
  /** Absolute path of the packaged installer. */
  readonly installer: () => string
  /** Node executable used to run it (the host's own, so no PATH surprises). */
  readonly node: () => string
}

/** What the panel is told. */
export interface BridgeActionResult {
  /** Whether the installer exited 0. */
  readonly ok: boolean
  /** Its exit code, or null when it was killed. */
  readonly code: number | null
  /** The tail of its output, for the one line the panel shows. */
  readonly output: string
  /** The exact command line, so a failure can be reproduced by hand. */
  readonly command: string
}

/**
 * The argv the installer expects, in one place so the panel and a human run the same thing.
 *
 * `--restart --yes` is not a convenience: the shell holds `app.asar` open, so an install with the
 * app running fails with EBUSY, and a prompt would block an unattended click.
 * @param action - install/repair, or restore the pre-bridge state.
 * @param installRoot - the desktop install directory that was discovered.
 * @returns argv for the installer.
 */
export function bridgeActionArgv(action: BridgeAction, installRoot: string): string[] {
  const argv = [installRoot]
  if (action === 'uninstall') argv.push('--revert')
  argv.push('--restart', '--yes')
  return argv
}

/** The packaged installer, resolved from this module rather than from a build-time path. */
export function defaultInstallerPath(): string {
  return fileURLToPath(new URL('../../desktop-bridge/install.mjs', import.meta.url))
}

/** One line from a long output: the tail is what names the failure. */
function tail(text: string, limit = 600): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? '…' + trimmed.slice(-limit) : trimmed
}

/** Default runner: the host's own node, a bounded wait, and no shell (so a path with spaces is data). */
function defaultRun(command: string, argv: readonly string[]): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn(command, [...argv], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    const collect = (chunk: unknown): void => { output += String(chunk); if (output.length > 20_000) output = output.slice(-20_000) }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 180_000)
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, output: `${output}\nfailed to start: ${String(error)}` }) })
    child.on('exit', code => { clearTimeout(timer); resolve({ code, output }) })
  })
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
export async function runBridgeAction(
  action: BridgeAction,
  installRoot: string,
  deps: BridgeActionDeps = { run: defaultRun, installer: defaultInstallerPath, node: () => process.execPath },
): Promise<BridgeActionResult> {
  const command = deps.node()
  const argv = [deps.installer(), ...bridgeActionArgv(action, installRoot)]
  const printable = [command, ...argv].map(part => (/\s/.test(part) ? `"${part}"` : part)).join(' ')
  try {
    // Ask the installer to check identity FIRST, without touching anything. It is the same preflight
    // a human can run, and it turns "the button did nothing" into a named reason.
    const preflight = await deps.run(command, [argv[0] as string, installRoot, '--preflight'])
    const verdict = (() => {
      try { return JSON.parse(preflight.output.trim().split('\n').at(-1) ?? '{}') as { ok?: boolean; reason?: string } }
      catch { return {} as { ok?: boolean; reason?: string } }
    })()
    if (preflight.code !== 0 || verdict.ok !== true) {
      return {
        ok: false,
        code: preflight.code,
        output: tail(String(verdict.reason ?? preflight.output)),
        command: printable,
      }
    }
    const result = await deps.run(command, argv)
    return { ok: result.code === 0, code: result.code, output: tail(result.output), command: printable }
  } catch (error) {
    return { ok: false, code: null, output: tail(String(error)), command: printable }
  }
}
