// Test-only process discovery: installer fixtures see a closed Desktop without querying the user's
// machine. Keep the production installer's process checks intact and forward every other command.
if (process.env.DSH_BROWSER_TEST === '1') {
  const fs = require('node:fs')
  const path = require('node:path')
  const cp = require('node:child_process')
  const { syncBuiltinESMExports } = require('node:module')
  const markerBody = 'dsh-browser-installer-test-root-v1\n'
  function assertPrivateRoot() {
    const root = process.env.DSH_BRIDGE_TEST_ROOT
    try {
      if (typeof root !== 'string' || !path.isAbsolute(root) || fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) throw Error('invalid root')
      const actual = fs.realpathSync(root)
      const marker = path.join(actual, '.dsh-bridge-test-root')
      if (fs.lstatSync(marker).isSymbolicLink() || !fs.lstatSync(marker).isFile() || fs.readFileSync(marker, 'utf8') !== markerBody) throw Error('invalid marker')
    } catch {
      throw Error('test isolation refused: closed-desktop preload requires a valid private installer sandbox marker')
    }
  }
  assertPrivateRoot()
  const query = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); '
    + 'Get-CimInstance Win32_Process -ErrorAction Stop | '
    + 'Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
  const original = cp.execFileSync
  cp.execFileSync = function (command, args, options) {
    if (command !== 'powershell.exe' || !Array.isArray(args) || args.length !== 4
      || args[0] !== '-NoProfile' || args[1] !== '-NonInteractive' || args[2] !== '-Command' || args[3] !== query) {
      return Reflect.apply(original, this, arguments)
    }
    assertPrivateRoot()
    const text = JSON.stringify([{
      ProcessId: process.pid,
      ParentProcessId: 1,
      Name: path.basename(process.execPath),
      ExecutablePath: process.execPath,
      CommandLine: JSON.stringify([process.execPath, ...process.argv.slice(1)]),
    }])
    return typeof options?.encoding === 'string' && options.encoding !== 'buffer' ? text : Buffer.from(text)
  }
  syncBuiltinESMExports()
}
