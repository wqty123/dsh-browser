import { extensionMessages } from '../../assets/browser-messages.mjs'
import { EXTENSION_PROBE_TIMEOUT_MS, NATIVE_REGISTRATION_TIMEOUT_MS, NATIVE_REGISTRATION_MAX_BUFFER, extensionPageUrl, folderOpener } from '../../assets/browser-policy.mjs'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { extensionDirectory, extensionInstallHelp } from './extension-browser.ts'
import { detectBrowser } from './system-browser.ts'
import { EXTENSION_ID, EXTENSION_STORE_URL } from '../../assets/browser-extension-identity.mjs'

export { EXTENSION_ID }
export const registrationStatus = new Map<string, { registered: boolean; detail: string }>()
const pending = new Map<string, Promise<void>>()

export function registerExtensionHosts(): Promise<void> {
  return Promise.all((['edge', 'chrome'] as const).map(browser => {
    const directory = extensionDirectory(browser)
    let task = pending.get(directory)
    if (!task) {
      task = new Promise<void>(resolve => {
        execFile(process.execPath, [fileURLToPath(new URL('../../native-host/install.mjs', import.meta.url)), '--browser', browser, '--directory', directory],
          { windowsHide: true, timeout: NATIVE_REGISTRATION_TIMEOUT_MS, maxBuffer: NATIVE_REGISTRATION_MAX_BUFFER }, error => {
            registrationStatus.set(browser, { registered: !error, detail: error ? `Native host registration failed: ${error.message}` : 'Native host registered automatically.' })
            resolve()
          })
      }).finally(() => pending.delete(directory))
      pending.set(directory, task)
    }
    return task
  })).then(() => {})
}

export const nativeRegistration = { ensure: registerExtensionHosts }

export async function probeExtension(browser: 'edge' | 'chrome'): Promise<boolean> {
  let client: import('../../native-host/client.mjs').NativeBrowserClient | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const { NativeBrowserClient } = await import('../../native-host/client.mjs')
    client = new NativeBrowserClient(extensionDirectory(browser), browser)
    return await Promise.race([client.connect().then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), EXTENSION_PROBE_TIMEOUT_MS) })])
  } catch { return false }
  finally { clearTimeout(timer); client?.dispose() }
}

function launch(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export async function installExtension(browser: 'edge' | 'chrome', connected: boolean, deps = {
  register: nativeRegistration.ensure, detect: detectBrowser, launch, platform: process.platform, storeUrl: EXTENSION_STORE_URL,
}) {
  await deps.register()
  if (connected) return { ok: true, connected: true, detail: extensionMessages.zh.connected }
  const status = registrationStatus.get(browser)
  if (status?.registered === false) return { ok: false, connected: false, detail: status.detail }
  const executable = deps.detect(browser)
  if (!executable) return { ok: false, connected: false, detail: `${browser} is not installed` }
  await deps.launch(executable.path, [deps.storeUrl || extensionPageUrl(browser)])
  if (!deps.storeUrl) {
    const folder = extensionInstallHelp(browser).extensionDirectory
    await deps.launch(folderOpener(deps.platform), [folder])
  }
  return { ok: true, connected: false, store: !!deps.storeUrl, detail: deps.storeUrl ? extensionMessages.zh.storeHint : extensionMessages.zh.loadHint }
}
