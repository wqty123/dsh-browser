import { spawn } from 'node:child_process'

export interface ForegroundEvent {
  /** Process that owns the foreground window. */
  readonly pid: number
  /** Whether that window lies off every display (a minimized window does not count). */
  readonly offscreen: boolean
}
export interface ForegroundWatch { stop(): void }
/** `onFail` runs at most once, when the watcher cannot start or dies; `stop()` never triggers it. */
export type ForegroundWatcher = (onChange: (event: ForegroundEvent) => void, onFail: (reason: string) => void) => ForegroundWatch | undefined

const POLL_MS = 500

const script = (parent: number): string => [
  `$parent = ${parent}`,
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -TypeDefinition @"',
  'using System; using System.Runtime.InteropServices;',
  'public static class DshForeground {',
  '  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
  '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '}',
  '"@',
  '$last = ""; $tick = 0',
  'while ($true) {',
  '  $tick++; if ($tick % 8 -eq 0 -and -not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }',
  '  $h = [DshForeground]::GetForegroundWindow(); $p = [uint32]0',
  '  [void][DshForeground]::GetWindowThreadProcessId($h, [ref]$p)',
  '  $r = New-Object DshForeground+Rect; [void][DshForeground]::GetWindowRect($h, [ref]$r)',
  '  $box = New-Object System.Drawing.Rectangle($r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))',
  '  $off = 1',
  '  if ([DshForeground]::IsIconic($h) -or $box.Width -le 0) { $off = 0 }',
  '  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) { if ($s.Bounds.IntersectsWith($box)) { $off = 0 } }',
  '  $line = "$p $off"',
  '  if ($line -ne $last) { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $last = $line }',
  `  Start-Sleep -Milliseconds ${POLL_MS}`,
  '}',
].join('\n')

/** One line of the watcher's output, `<pid> <0|1>`. */
export function parseForegroundLine(line: string): ForegroundEvent | undefined {
  const match = /^(\d+) ([01])$/u.exec(line.trim())
  return match === null ? undefined : { pid: Number(match[1]), offscreen: match[2] === '1' }
}

/**
 * Report the foreground window's process, and whether that window is off every display, each time
 * either changes. Windows only: CDP cannot tell a person activating a window from an agent's click,
 * which focuses the page without the window. The watcher exits with this process.
 */
export const watchForeground: ForegroundWatcher = (onChange, onFail) => {
  if (process.platform !== 'win32') return undefined
  let child
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      Buffer.from(script(process.pid), 'utf16le').toString('base64')], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  } catch (error) {
    onFail(String(error))
    return undefined
  }
  let stopped = false
  let failed = false
  const fail = (reason: string): void => { if (!stopped && !failed) { failed = true; onFail(reason) } }
  child.on('error', error => fail(String(error)))
  child.on('exit', (code, signal) => fail(`exited (${signal ?? code})`))
  child.unref()
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const event = parseForegroundLine(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
      if (event !== undefined) onChange(event)
    }
  })
  ;(child.stdout as { unref?: () => void } | null)?.unref?.()
  return { stop: () => { stopped = true; try { child.kill() } catch { /* already gone */ } } }
}
