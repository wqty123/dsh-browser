import { spawn } from 'node:child_process'

export interface ForegroundEvent {
  /** Process that owns the foreground window. */
  readonly pid: number
  /** Whether that window lies off every display (a minimized window does not count). */
  readonly offscreen: boolean
  /** That window's top-left corner, in DIPs like CDP window bounds. */
  readonly left?: number
  readonly top?: number
  /** The browser took the foreground off every display with no input from the person, and the watcher gave it back. */
  readonly yielded?: boolean
}
export interface ForegroundWatch { stop(): void }
/** `onFail` runs at most once, when the watcher cannot start or dies; `stop()` never triggers it. */
export type ForegroundWatcher = (onChange: (event: ForegroundEvent) => void, onFail: (reason: string) => void, browserPid?: number) => ForegroundWatch | undefined

const POLL_MS = 500
const PARENT_CHECK_MS = 4000

/*
 * A foreground hook reports each activation within a millisecond; the poll only catches the
 * foreground window moving on or off the displays, and a Stopwatch checks parent liveness
 * every 4 s regardless of foreground event frequency.
 */
const script = (parent: number, browserPid: number): string => [
  `$parent = ${parent}; $browser = ${browserPid}`,
  'try {',
  'Add-Type -TypeDefinition @"',
  'using System; using System.Diagnostics; using System.Runtime.InteropServices;',
  'public static class DshForeground {',
  '  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct InputInfo { public uint Size, Time; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct Msg { public IntPtr Hwnd; public uint Message; public IntPtr W, L; public uint Time; public int X, Y; }',
  '  public delegate void Hook(IntPtr hook, uint e, IntPtr h, int o, int c, uint t, uint time);',
  '  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, Hook f, uint pid, uint tid, uint flags);',
  '  [DllImport("user32.dll")] static extern uint MsgWaitForMultipleObjects(uint n, IntPtr[] h, bool all, uint ms, uint mask);',
  '  [DllImport("user32.dll")] static extern bool PeekMessage(out Msg m, IntPtr h, uint a, uint b, uint remove);',
  '  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Msg m);',
  '  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Msg m);',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
  '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);',
  '  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);',
  '  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);',
  '  [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref Rect r, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool f);',
  '  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref InputInfo i);',
  '  static uint LastInput() { var i = new InputInfo(); i.Size = 8; GetLastInputInfo(ref i); return i.Time; }',
  '  static Hook keep; static string last = ""; static uint input, prevPid, browser; static IntPtr prev;',
  '  static void Sample() {',
  '    uint before = LastInput(), p; IntPtr h = GetForegroundWindow();',
  // Transient null foreground (lock screen, UAC, window switch): keep prev intact instead of clearing it.
  '    if (h == IntPtr.Zero) { input = before; return; }',
  '    uint thread = GetWindowThreadProcessId(h, out p);',
  '    Rect r; GetWindowRect(h, out r);',
  // Physical pixels from GetWindowRect, so dividing by the window DPI gives DIPs at any scaling.
  '    int off = IsIconic(h) || r.Right <= r.Left || MonitorFromRect(ref r, 0) != IntPtr.Zero ? 0 : 1;',
  '    uint dpi = GetDpiForWindow(h); if (dpi == 0) dpi = 96;',
  '    string line = p + " " + off + " " + Math.Round(r.Left * 96.0 / dpi) + " " + Math.Round(r.Top * 96.0 / dpi);',
  // Chrome activates its own window for a tab a click opens; with no input since before the last read, no person did it.
  // Always mark yielded even if SetForegroundWindow(prev) fails (e.g. elevated prev window under UIPI),
  // and keep prev/prevPid unchanged so follow-up samples before focus settles cannot bypass the guard.
  '    bool yielded = false;',
  '    if (p == browser && off == 1 && prevPid != browser && prev != IntPtr.Zero && LastInput() == input) {',
  '      yielded = true; line += " 1";',
  '      uint me = GetCurrentThreadId(); AttachThreadInput(me, thread, true);',
  '      SetForegroundWindow(prev);',
  '      AttachThreadInput(me, thread, false);',
  '    }',
  '    if (line != last) { Console.Out.WriteLine(line); Console.Out.Flush(); last = line; }',
  '    if (!yielded) { prev = h; prevPid = p; }',
  '    input = before;',
  '  }',
  '  public static void Run(int parent, uint browserPid) {',
  '    browser = browserPid; input = LastInput(); keep = (a, e, h, o, c, t, time) => Sample();',
  '    SetWinEventHook(3, 3, IntPtr.Zero, keep, 0, 0, 0);',
  '    var parentClock = Stopwatch.StartNew();',
  '    Sample(); Msg m;',
  '    for (;;) {',
  `      if (MsgWaitForMultipleObjects(0, null, false, ${POLL_MS}, 0x4FF) == 0x102) Sample();`,
  '      while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref m); DispatchMessage(ref m); }',
  `      if (parentClock.ElapsedMilliseconds >= ${PARENT_CHECK_MS}) {`,
  '        parentClock.Restart();',
  '        try { Process.GetProcessById(parent).Dispose(); } catch (ArgumentException) { return; }',
  '      }',
  '    }',
  '  }',
  '}',
  '"@',
  '} catch { exit 3 }',
  'if (-not [DshForeground]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][DshForeground]::SetProcessDPIAware() }',
  'try { [DshForeground]::Run($parent, $browser) } catch { exit 4 }',
].join('\n')

/** One line of the watcher's output, `<pid> <0|1> [<left> <top> [1]]`, the last `1` when it gave the foreground back. */
export function parseForegroundLine(line: string): ForegroundEvent | undefined {
  const match = /^(\d+) ([01])(?: (-?\d+) (-?\d+)( 1)?)?$/u.exec(line.trim())
  if (match === null) return undefined
  const event = { pid: Number(match[1]), offscreen: match[2] === '1' }
  if (match[3] === undefined) return event
  return { ...event, left: Number(match[3]), top: Number(match[4]), ...match[5] === undefined ? {} : { yielded: true } }
}

/**
 * Report the foreground window's process, and whether that window is off every display, each time
 * either changes. Windows only: CDP cannot tell a person activating a window from Chrome activating
 * it for a tab an agent's click opened, but only the person's leaves input. The watcher exits with this process.
 */
export const watchForeground: ForegroundWatcher = (onChange, onFail, browserPid = 0) => {
  if (process.platform !== 'win32') return undefined
  let child
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      Buffer.from(script(process.pid, browserPid), 'utf16le').toString('base64')], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
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
