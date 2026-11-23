/** Explicit Web maintenance for the sidebar bundle selected by DSH's client module registry. */
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostPatchResult } from './bridge-install.ts'
import { sameOrigin } from './settings-route.ts'
import { isDirectLoopback } from './authenticated-route.ts'
import { readJsonBody } from './http-body.ts'
import { replyJson } from './json-reply.ts'

export const HOST_PATCH_ROUTE = '/dsh-builtin-browser/host-patch-maintenance'
const sidebar = '@deepseek-ai/dsh-client-ui-sidebar-right'

/** The registry owns the exact npm or source-checkout bundle served by this Host. */
export interface ServedClientModules {
  clientPath(id: string): string | undefined
  rebuilt?(id: string): unknown
}

interface PatchState extends HostPatchResult {
  readonly surface: 'web' | 'desktop' | 'tauri'
  readonly canInstall: boolean
  readonly canRestore: boolean
  readonly restartRequired: boolean
}

/** Bind to the live optional service, never resolve a second copy relative to the plugin. */
export function servedClientModules(value: unknown): ServedClientModules | undefined {
  if (value !== null && typeof value === 'object' && 'clientPath' in value && typeof value.clientPath === 'function') {
    return value as ServedClientModules
  }
  return undefined
}

/** Locate only the package whose lib/client.js the running registry actually advertises. */
export function servedSidebarPackage(modules: ServedClientModules | undefined): string {
  const path = modules?.clientPath(sidebar)
  if (path === undefined) throw new Error('The running DSH client registry has no sidebar bundle; host patch maintenance is unavailable.')
  const file = realpathSync(path)
  const directory = dirname(dirname(file))
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== sidebar || realpathSync(join(directory, 'lib/client.js')) !== file) {
    throw new Error('The served sidebar bundle is not the supported package lib/client.js.')
  }
  return directory
}

/** Same authenticated, same-origin, local-only maintenance admission as Desktop settings. */
export function createHostPatchMaintenance(deps: {
  readonly modules: () => ServedClientModules | undefined
  readonly desktop: () => boolean
  /** The electron-rs runtime directory of the DSH Tauri hosting this process, if any. */
  readonly tauri?: () => string | undefined
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  let running = false
  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'POST') { replyJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
    if (!sameOrigin(request, request.method === 'POST') || !isDirectLoopback(request)) {
      replyJson(response, 403, { ok: false, error: 'same-origin-local-request-required' }); return
    }
    const tauri = deps.tauri?.()
    if (tauri === undefined && deps.desktop()) {
      replyJson(response, request.method === 'GET' ? 200 : 409, { ok: request.method === 'GET', hostPatch: { surface: 'desktop', status: 'absent', canInstall: false, canRestore: false,
        restartRequired: false, reason: 'Use Desktop bridge maintenance to change host files after Desktop exits.' } }); return
    }
    let directory: string
    const modules = deps.modules()
    const surface = tauri === undefined ? 'web' : 'tauri'
    const target = tauri === undefined ? 'lib/client.js' : 'runtime/browser.cjs'
    try { directory = tauri ?? servedSidebarPackage(modules) }
    catch (error) {
      replyJson(response, request.method === 'GET' ? 200 : 409, { ok: request.method === 'GET', hostPatch: {
        surface: 'web', status: 'anchors mismatch', canInstall: false, canRestore: false, restartRequired: false, reason: String(error),
      } }); return
    }
    const patcher = await import(new URL('../../dsh-host-patch/apply.mjs', import.meta.url).href)
    const read = (): PatchState => {
      const result: HostPatchResult = patcher.hostPatchStatus(directory)
      let writable = true
      let reason = result.reason
      try {
        for (const path of [dirname(join(directory, target)), join(directory, target)]) {
          if ((statSync(path).mode & 0o222) === 0) throw new Error('read-only permissions')
          accessSync(path, constants.W_OK)
        }
      } catch (error) { writable = false; reason = `The ${surface === 'web' ? 'served sidebar package' : 'DSH Tauri runtime'} is not writable: ` + String(error) }
      return { ...result, ...(reason === undefined ? {} : { reason }), surface,
        canInstall: writable && result.status === 'absent',
        canRestore: writable && result.status === 'applied' && existsSync(join(directory, `${target}.before-dsh-host-patch`)),
        restartRequired: false }
    }
    if (request.method === 'GET') { replyJson(response, 200, { ok: true, hostPatch: read() }); return }
    if (running) { replyJson(response, 409, { ok: false, error: 'host patch maintenance is already running' }); return }
    let action: 'install' | 'restore'
    try {
      const input = await readJsonBody<{ action?: unknown }>(request, 4096)
      if (input?.action !== 'install' && input?.action !== 'restore') throw new Error('action must be install or restore')
      action = input.action
    } catch (error) { replyJson(response, 400, { ok: false, error: String(error) }); return }
    const before = read()
    if (action === 'install' ? !before.canInstall : !before.canRestore) {
      replyJson(response, 409, { ok: false, hostPatch: before, error: before.reason ?? 'This action is not available for the served sidebar package.' }); return
    }
    running = true
    try {
      const result: HostPatchResult = action === 'install' ? patcher.applyHostPatch(directory) : patcher.restoreHostPatch(directory)
      const ok = result.status === (action === 'install' ? 'applied' : 'absent')
      let restartRequired = ok && result.changed === true
      let reason = result.reason
      if (restartRequired && surface === 'web' && typeof modules?.rebuilt === 'function') {
        try { modules.rebuilt(sidebar); restartRequired = false }
        catch (error) { reason = 'Files changed, but DSH could not refresh its bundle cache: ' + String(error) }
      }
      replyJson(response, ok ? 200 : 409, { ok, hostPatch: { ...read(), ...result, ...(reason === undefined ? {} : { reason }), restartRequired } })
    } finally { running = false }
  }
}
