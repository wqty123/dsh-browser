/** Authenticated explicit maintenance protocol; older hosts cannot mistake it for direct install. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sameOrigin } from './settings-route.js'
import { isDirectLoopback } from './authenticated-route.js'
import { replyJson } from './json-reply.js'
import { readJsonBody } from './http-body.js'
import type { BridgeAction } from './bridge-install.js'
import type { AutomaticMaintenanceJob } from './automatic-maintenance.js'

export const AUTOMATIC_MAINTENANCE_ROUTE = '/dsh-builtin-browser/bridge-maintenance'
export interface AutomaticMaintenanceRouteDeps {
  readonly supported: () => boolean
  readonly read: () => AutomaticMaintenanceJob | undefined
  readonly start: (action: BridgeAction, options?: { readonly locale?: 'zh' | 'en' }) => Promise<AutomaticMaintenanceJob>
  /** Commit only after the accepted response has been flushed to the client. */
  readonly commit?: (id: string) => Promise<void>
  /** True while the legacy bridge-action route is running an installer. */
  readonly busy?: () => boolean
}

/** Register behind the host's signed-session authentication, as with settings writes. */
export function createAutomaticMaintenanceHandler(deps: AutomaticMaintenanceRouteDeps): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  let starting = false
  return async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'POST') { replyJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
    if (!sameOrigin(request, request.method === 'POST')) { replyJson(response, 403, { ok: false, error: 'not-same-origin' }); return }
    if (!isDirectLoopback(request)) { replyJson(response, 403, { ok: false, error: 'local-request-required' }); return }
    if (request.method === 'GET') {
      const job = deps.read()
      replyJson(response, 200, { ok: true, protocol: 1, supported: deps.supported(), ...job === undefined ? {} : { job } })
      return
    }
    if (!deps.supported()) { replyJson(response, 409, { ok: false, error: 'automatic bridge maintenance requires Windows Desktop' }); return }
    let action: BridgeAction
    let locale: 'zh' | 'en' | undefined
    try {
      const value = await readJsonBody<{ action?: unknown; locale?: unknown }>(request, 4096)
      if (value?.action !== 'install' && value?.action !== 'uninstall') throw new Error('action must be install or uninstall')
      if (value.locale !== undefined && value.locale !== 'zh' && value.locale !== 'en') throw new Error('locale must be zh or en')
      action = value.action
      locale = value.locale
    } catch (error) { replyJson(response, 400, { ok: false, error: String(error) }); return }
    if (starting || deps.busy?.() === true) { replyJson(response, 409, { ok: false, error: 'bridge maintenance is already starting' }); return }
    starting = true
    try {
      const job = await deps.start(action, locale === undefined ? undefined : { locale })
      if (deps.commit !== undefined) {
        let fired = false
        const commitOnce = (): void => {
          if (fired) return
          fired = true
          void deps.commit?.(job.id).catch(error => { console.error('dsh-builtin-browser: bridge maintenance commit failed:', String(error)) })
        }
        // A client that refreshes or disconnects may fire `close` without `finish`; the worker
        // must be committed (or explicitly cancelled) on either path, exactly once.
        response.once('finish', commitOnce)
        response.once('close', commitOnce)
      }
      replyJson(response, 202, { ok: true, accepted: true, protocol: 1, job })
    } catch (error) {
      replyJson(response, 409, { ok: false, error: String(error) })
    } finally { starting = false }
  }
}
