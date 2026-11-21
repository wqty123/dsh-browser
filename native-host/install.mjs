import { mkdirSync, chmodSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join, resolve, dirname, isAbsolute, posix } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { saveConfiguration } from './host.mjs'
import { readConfiguration } from './client.mjs'

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
const literal = value => JSON.stringify(value)

export function registration(browser, manifest, { platform = process.platform, home = homedir(), xdg = process.env.XDG_CONFIG_HOME } = {}) {
  const name = `com.dsh.browser.${browser}`
  if (platform === 'win32') return { registry: `HKCU\\Software\\${browser === 'edge' ? 'Microsoft\\Edge' : 'Google\\Chrome'}\\NativeMessagingHosts\\${name}`, manifest }
  if (platform === 'darwin') return { file: posix.join(home, 'Library', 'Application Support', browser === 'edge' ? 'Microsoft Edge' : 'Google/Chrome', 'NativeMessagingHosts', `${name}.json`) }
  if (platform === 'linux') return { file: posix.join(xdg || posix.join(home, '.config'), browser === 'edge' ? 'microsoft-edge' : 'google-chrome', 'NativeMessagingHosts', `${name}.json`) }
  throw Error('native messaging is unsupported on this platform')
}

export function install({ browser, extensionId, directory, label, register = true, revoke = false }) {
  if (!['edge', 'chrome'].includes(browser) || !/^[a-p]{32}$/.test(extensionId ?? '') || !isAbsolute(directory ?? '')) throw Error('--browser edge|chrome, --extension-id (32 a-p letters), and an absolute --directory are required')
  directory = resolve(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
  else {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference='Stop'
      $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl=New-Object System.Security.AccessControl.DirectorySecurity
      $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
      $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:DSH_NATIVE_DIR -AclObject $acl
    `], { env: { ...process.env, DSH_NATIVE_DIR: directory }, stdio: 'pipe', windowsHide: true })
  }
  const configPath = join(directory, 'config.json'), previous = readConfiguration(directory)
  const token = revoke ? undefined : randomBytes(24).toString('base64url')
  const config = { browser, extensionId, label: String(label ?? `${browser === 'edge' ? 'Edge' : 'Chrome'} personal profile`).slice(0, 120),
    secret: randomBytes(32).toString('hex'), ...(revoke ? {} : { pairDigest: createHash('sha256').update(token).digest('hex'), pairExpires: Date.now() + 5 * 60 * 1000 }) }
  if (previous && (previous.browser !== browser || previous.extensionId !== extensionId)) throw Error('directory belongs to a different browser/extension; use a separate directory')
  saveConfiguration(configPath, config)
  try { unlinkSync(join(directory, 'relay.json')) } catch {}
  if (revoke) return { revoked: true, detail: 'Pairing revoked. Disconnect the extension to release any existing control connection immediately.' }
  const name = `com.dsh.browser.${browser}`
  const launcher = join(directory, process.platform === 'win32' ? 'dsh-browser-native.exe' : 'dsh-browser-native')
  const hostScript = fileURLToPath(new URL('./host.mjs', import.meta.url))
  if (process.platform === 'win32') {
    const source = `using System; using System.Diagnostics; using System.Threading.Tasks;
      class NativeHost { static int Main(string[] args) {
        if(args.Length<1) return 1;
        var info=new ProcessStartInfo(${literal(process.execPath)});
        info.Arguments="\\\""+${literal(hostScript)}+"\\\" --config \\\""+${literal(configPath)}+"\\\" \\\""+args[0].Replace("\\\"", "")+"\\\"";
        info.UseShellExecute=false; info.CreateNoWindow=true;
        info.RedirectStandardInput=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true;
        using(var process=Process.Start(info)) {
          Task.Run(()=>{try{Console.OpenStandardInput().CopyTo(process.StandardInput.BaseStream);}catch{}finally{try{process.StandardInput.Close();}catch{}}});
          var output=Task.Run(()=>process.StandardOutput.BaseStream.CopyTo(Console.OpenStandardOutput()));
          Task.Run(()=>process.StandardError.BaseStream.CopyTo(System.IO.Stream.Null));
          process.WaitForExit(); output.Wait(); return process.ExitCode;
        }
      }}
    `
    if (existsSync(launcher)) unlinkSync(launcher)
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; Add-Type -TypeDefinition $env:DSH_NATIVE_SOURCE -OutputAssembly $env:DSH_NATIVE_EXE -OutputType ConsoleApplication'],
    { env: { ...process.env, DSH_NATIVE_SOURCE: source, DSH_NATIVE_EXE: launcher }, windowsHide: true, stdio: 'pipe' })
  } else {
    writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(hostScript)} --config ${shellQuote(configPath)} "$@"\n`, { mode: 0o700 })
    chmodSync(launcher, 0o700)
  }
  const manifestPath = join(directory, `${name}.json`)
  const manifest = { name, description: 'DSH paired browser bridge', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }
  saveConfiguration(manifestPath, manifest)
  const target = registration(browser, manifestPath)
  if (register) {
    if (target.registry) execFileSync('reg.exe', ['add', target.registry, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', '/reg:64'], { stdio: 'pipe', windowsHide: true })
    else { mkdirSync(dirname(target.file), { recursive: true, mode: 0o700 }); saveConfiguration(target.file, manifest) }
  }
  return { browser, directory, manifestPath, registration: target, registered: register, token, expiresInSeconds: 300,
    extensionDirectory: fileURLToPath(new URL('../browser-extension/', import.meta.url)),
    next: 'Enter this one-time token in extension Options in the intended profile. Keep this extracted package and Node installation in place.' }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), get = name => args[args.indexOf(name) + 1]
  try {
    const browser = get('--browser')
    const result = install({ browser, extensionId: get('--extension-id'), directory: get('--directory'), label: args.includes('--label') ? get('--label') : undefined,
      register: !args.includes('--no-register'), revoke: args.includes('--revoke') })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) { console.error(`Native-host installation failed: ${error.message}`); process.exitCode = 1 }
}
