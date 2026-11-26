import { NATIVE_PRODUCTS, WINDOWS_TOOLS } from '../assets/browser-products.mjs'
import { nativeHostName, LEGACY_PAIR_TTL_MS, NATIVE_FILES } from '../browser-extension/constants.mjs'
import { mkdirSync, chmodSync, writeFileSync, existsSync, unlinkSync, readFileSync, renameSync } from 'node:fs'
import { join, resolve, dirname, isAbsolute, posix } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { saveConfiguration } from './host.mjs'
import { readConfiguration } from './client.mjs'
import { EXTENSION_ID } from './identity.mjs'

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
const literal = value => JSON.stringify(value)

export function registration(browser, manifest, { platform = process.platform, home = homedir(), xdg = process.env.XDG_CONFIG_HOME } = {}) {
  const name = nativeHostName(browser)
  if (platform === 'win32') return { registry: `HKCU\\Software\\${NATIVE_PRODUCTS[browser].win32}\\NativeMessagingHosts\\${name}`, manifest }
  if (platform === 'darwin') return { file: posix.join(home, 'Library', 'Application Support', NATIVE_PRODUCTS[browser].darwin, 'NativeMessagingHosts', `${name}.json`) }
  if (platform === 'linux') return { file: posix.join(xdg || posix.join(home, '.config'), NATIVE_PRODUCTS[browser].linux, 'NativeMessagingHosts', `${name}.json`) }
  throw Error('native messaging is unsupported on this platform')
}

const LAUNCHER_BUFFER_BYTES = 8192

export function launcherSource(nodePath, hostScript, configPath) {
  return `using System; using System.Diagnostics; using System.Text; using System.Threading.Tasks;
      class NativeHost {
        static string QuoteArg(string arg) {
          var sb=new StringBuilder();
          sb.Append('"');
          int backslashes=0;
          for(int i=0;i<arg.Length;i++) {
            char c=arg[i];
            if(c=='\\\\') { backslashes++; }
            else if(c=='"') { sb.Append('\\\\',backslashes*2+1); sb.Append('"'); backslashes=0; }
            else { if(backslashes>0) { sb.Append('\\\\',backslashes); backslashes=0; } sb.Append(c); }
          }
          if(backslashes>0) sb.Append('\\\\',backslashes*2);
          sb.Append('"');
          return sb.ToString();
        }
        static void Relay(System.IO.Stream input, System.IO.Stream output) {
          var buffer=new byte[${LAUNCHER_BUFFER_BYTES}];
          int count;
          while((count=input.Read(buffer,0,buffer.Length))>0) {
            output.Write(buffer,0,count);
            output.Flush();
          }
        }
        static int Main(string[] args) {
        if(args.Length<1) return 1;
        var info=new ProcessStartInfo(${literal(nodePath)});
        info.Arguments=QuoteArg(${literal(hostScript)})+" --config "+QuoteArg(${literal(configPath)})+" "+QuoteArg(args[0]);
        info.UseShellExecute=false; info.CreateNoWindow=true;
        // nodePath is process.execPath, which is electron.exe inside DSH Desktop. Without this an
        // Electron binary starts as a GUI app: every Native Messaging connect spawned a window and
        // stole focus from whatever the user was doing (issue #129). A real node.exe ignores the
        // variable, so setting it unconditionally is safe for both.
        info.EnvironmentVariables["ELECTRON_RUN_AS_NODE"]="1";
        info.RedirectStandardInput=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true;
        using(var process=Process.Start(info)) {
          Task.Run(()=>{try{Relay(Console.OpenStandardInput(),process.StandardInput.BaseStream);}catch{}finally{try{process.StandardInput.Close();}catch{}}});
          var output=Task.Run(()=>Relay(process.StandardOutput.BaseStream,Console.OpenStandardOutput()));
          Task.Run(()=>process.StandardError.BaseStream.CopyTo(System.IO.Stream.Null));
          process.WaitForExit(); output.Wait(); return process.ExitCode;
        }
      }}
    `
}

export function secureWindowsDirectory(directory, execute = execFileSync) {
  execute(WINDOWS_TOOLS.powershell, ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop'
    $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $d=Get-Item -LiteralPath $env:DSH_NATIVE_DIR
    $acl=$d.GetAccessControl('Access')
    $acl.SetAccessRuleProtection($true,$false)
    foreach($existing in @($acl.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]))) {
      $acl.RemoveAccessRuleSpecific($existing)
    }
    $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
    $d.SetAccessControl($acl)
    $check=$d.GetAccessControl('Access')
    $rules=@($check.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
    if(!$check.AreAccessRulesProtected -or $rules.Count -ne 1) { throw 'Native-host directory DACL verification failed' }
    $actual=$rules[0]
    if($actual.IsInherited -or $actual.IdentityReference.Value -ne $sid.Value -or
       $actual.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
       $actual.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or
       $actual.InheritanceFlags -ne $rule.InheritanceFlags -or $actual.PropagationFlags -ne $rule.PropagationFlags) {
      throw 'Native-host directory DACL verification failed'
    }
  `], { env: { ...process.env, DSH_NATIVE_DIR: directory }, stdio: 'pipe', windowsHide: true })
}

export function publishLauncher(launcher, source, compile, io = { readFileSync, renameSync, unlinkSync }) {
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const sourceHash = digest(source), metadata = `${launcher}.build.json`
  try {
    const previous = JSON.parse(io.readFileSync(metadata, 'utf8'))
    if (previous.sourceHash === sourceHash && previous.binaryHash === digest(io.readFileSync(launcher))) return
  } catch {}
  const temporary = `${launcher}.${randomBytes(8).toString('hex')}.exe`
  try {
    compile(temporary)
    const bytes = io.readFileSync(temporary)
    let identical = false
    try { identical = bytes.equals(io.readFileSync(launcher)) } catch {}
    if (!identical) io.renameSync(temporary, launcher)
    saveConfiguration(metadata, { sourceHash, binaryHash: digest(bytes) })
  } finally { try { io.unlinkSync(temporary) } catch {} }
}

export function install({ browser, extensionId = EXTENSION_ID, directory, label, register = true, revoke = false }) {
  if (!['edge', 'chrome'].includes(browser) || !/^[a-p]{32}$/.test(extensionId ?? '') || !isAbsolute(directory ?? '')) throw Error('--browser edge|chrome, --extension-id (32 a-p letters), and an absolute --directory are required')
  directory = resolve(directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
  else secureWindowsDirectory(directory)
  const configPath = join(directory, NATIVE_FILES.config), previous = readConfiguration(directory)
  const token = revoke ? undefined : randomBytes(24).toString('base64url')
  let config = { browser, extensionId, label: String(label ?? `${browser === 'edge' ? 'Edge' : 'Chrome'} personal profile`).slice(0, 120),
    secret: randomBytes(32).toString('hex'), ...(revoke ? {} : { pairDigest: createHash('sha256').update(token).digest('hex'), pairExpires: Date.now() + LEGACY_PAIR_TTL_MS }) }
  if (previous && (previous.browser !== browser || (previous.extensionId !== extensionId && extensionId !== EXTENSION_ID))) throw Error('directory belongs to a different browser/extension; use a separate directory')
  if (extensionId === EXTENSION_ID) config = { browser, extensionId, label: config.label,
    secret: previous?.secret ?? config.secret, installId: EXTENSION_ID, disabled: revoke || previous?.disabled === true }
  if (JSON.stringify(previous) !== JSON.stringify(config)) saveConfiguration(configPath, config)
  if (revoke || extensionId !== EXTENSION_ID) { try { unlinkSync(join(directory, NATIVE_FILES.relay)) } catch {} }
  if (revoke) return { revoked: true, detail: 'Extension access disabled. Disconnect the extension to release any existing control connection immediately.' }
  const name = nativeHostName(browser)
  let launcher = join(directory, process.platform === 'win32' ? 'dsh-browser-native.exe' : 'dsh-browser-native')
  const hostScript = fileURLToPath(new URL('./host.mjs', import.meta.url))
  if (process.platform === 'win32') {
    const source = launcherSource(process.execPath, hostScript, configPath)
    launcher = join(directory, `dsh-browser-native-${createHash('sha256').update(source).digest('hex').slice(0, 24)}.exe`)
    publishLauncher(launcher, source, temporary => execFileSync(WINDOWS_TOOLS.powershell, ['-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference="Stop"; Add-Type -TypeDefinition $env:DSH_NATIVE_SOURCE -OutputAssembly $env:DSH_NATIVE_EXE -OutputType ConsoleApplication'],
    { env: { ...process.env, DSH_NATIVE_SOURCE: source, DSH_NATIVE_EXE: temporary }, windowsHide: true, stdio: 'pipe' }))
  } else {
    const bytes = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(hostScript)} --config ${shellQuote(configPath)} "$@"\n`
    let same = false
    try { same = readFileSync(launcher, 'utf8') === bytes } catch {}
    if (!same) {
      const temporary = `${launcher}.${randomBytes(8).toString('hex')}`
      try { writeFileSync(temporary, bytes, { mode: 0o700 }); renameSync(temporary, launcher) }
      finally { try { unlinkSync(temporary) } catch {} }
    }
    chmodSync(launcher, 0o700)
  }
  const manifestPath = join(directory, `${name}.json`)
  const manifest = { name, description: 'DSH browser bridge', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }
  saveConfiguration(manifestPath, manifest)
  const target = registration(browser, manifestPath)
  if (register) {
    if (target.registry) execFileSync(WINDOWS_TOOLS.registry, ['add', target.registry, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', '/reg:64'], { stdio: 'pipe', windowsHide: true })
    else { mkdirSync(dirname(target.file), { recursive: true, mode: 0o700 }); saveConfiguration(target.file, manifest) }
  }
  return { browser, directory, manifestPath, registration: target, registered: register, ...(extensionId === EXTENSION_ID ? {} : { token, expiresInSeconds: LEGACY_PAIR_TTL_MS / 1000 }),
    extensionDirectory: fileURLToPath(new URL('../browser-extension/', import.meta.url)),
    next: extensionId === EXTENSION_ID ? 'The bundled extension connects automatically. Keep this package and Node installation in place.' : 'Enter this one-time token in extension Options in the intended profile. Keep this extracted package and Node installation in place.' }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), get = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
  try {
    const browser = get('--browser')
    const result = install({ browser, extensionId: get('--extension-id'), directory: get('--directory'), label: args.includes('--label') ? get('--label') : undefined,
      register: !args.includes('--no-register'), revoke: args.includes('--revoke') })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) { console.error(`Native-host installation failed: ${error.message}`); process.exitCode = 1 }
}
