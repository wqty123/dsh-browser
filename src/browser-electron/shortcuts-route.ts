/**
 * HTTP face of the shared start-page shortcut list.
 *
 * Three exact paths, deliberately minimal: the sidebar keeps editing the section
 * through the settings RPC (its own UI), while this face exists so an agent — which
 * has no sidebar and no settings form — can list, add and drop shortcuts on the same
 * data. Both writers go through `ctx.settings`, so there is exactly one list.
 * @module dsh-browser/browser-electron/shortcuts-route
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BrowserHttpHandler } from './authenticated-route.ts'
import { isDirectLoopback } from './authenticated-route.ts'
import { readJsonBody } from './http-body.ts'
import { replyJson } from './json-reply.ts'
import { sameOrigin } from './settings-route.ts'
import { ShortcutError, type createShortcutStore } from './startpage-shortcuts.ts'

/** Read the shared shortcut list. */
export const SHORTCUTS_ROUTE = '/dsh-builtin-browser/shortcuts'
/** Append one shortcut. */
export const SHORTCUT_ADD_ROUTE = '/dsh-builtin-browser/shortcuts/add'
/** Drop one shortcut by id. */
export const SHORTCUT_REMOVE_ROUTE = '/dsh-builtin-browser/shortcuts/remove'

type Store = ReturnType<typeof createShortcutStore>

/** The handlers, one per registered exact path. */
export interface ShortcutRouteHandlers {
  readonly list: BrowserHttpHandler
  readonly add: BrowserHttpHandler
  readonly remove: BrowserHttpHandler
}

function requireWrite(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'POST') { replyJson(response, 405, { ok: false, error: 'method-not-allowed' }); return false }
  if (!sameOrigin(request, true)) { replyJson(response, 403, { ok: false, error: 'not-same-origin' }); return false }
  if (!isDirectLoopback(request)) { replyJson(response, 403, { ok: false, error: 'local-request-required' }); return false }
  return true
}

/**
 * Turn a refusal into a status a caller can branch on.
 * @param error - anything a handler threw.
 * @param response - the response to write when it is a known refusal.
 * @returns true when the error was answered.
 */
function refuse(error: unknown, response: ServerResponse): boolean {
  if (!(error instanceof ShortcutError)) return false
  const status = error.code === 'unavailable' ? 503
    : error.code === 'conflict' ? 409
      : error.code === 'limit' ? 422
        : 400
  replyJson(response, status, { ok: false, error: error.code, message: error.message })
  return true
}

/** Build every shortcut handler over one store. */
export function createShortcutRouteHandlers(store: Store): ShortcutRouteHandlers {
  const list: BrowserHttpHandler = (request, response) => {
    if (request.method !== 'GET') { replyJson(response, 405, { ok: false, error: 'method-not-allowed' }); return }
    try {
      const reading = store.list()
      replyJson(response, 200, { ok: true, shortcuts: reading.shortcuts, revision: reading.revision })
    } catch (error) {
      if (refuse(error, response)) return
      replyJson(response, 500, { ok: false, error: String(error) })
    }
  }

  const add: BrowserHttpHandler = async (request, response) => {
    if (!requireWrite(request, response)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody<Record<string, unknown>>(request)
    } catch (error) {
      replyJson(response, 400, { ok: false, error: `unreadable body: ${String(error)}` })
      return
    }
    try {
      const result = await store.add({ title: body.title, url: body.url, iconKey: body.iconKey })
      replyJson(response, 200, { ok: true, shortcut: result.shortcut, shortcuts: result.shortcuts })
    } catch (error) {
      if (refuse(error, response)) return
      replyJson(response, 500, { ok: false, error: String(error) })
    }
  }

  const remove: BrowserHttpHandler = async (request, response) => {
    if (!requireWrite(request, response)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody<Record<string, unknown>>(request)
    } catch (error) {
      replyJson(response, 400, { ok: false, error: `unreadable body: ${String(error)}` })
      return
    }
    if (typeof body.id !== 'string' || body.id === '') {
      replyJson(response, 400, { ok: false, error: 'id is required' })
      return
    }
    try {
      const result = await store.remove(body.id)
      replyJson(response, result.removed ? 200 : 404, { ok: result.removed, shortcuts: result.shortcuts })
    } catch (error) {
      if (refuse(error, response)) return
      replyJson(response, 500, { ok: false, error: String(error) })
    }
  }

  return { list, add, remove }
}
