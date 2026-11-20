import type { BrowserSessionId, BrowserTab } from './types.ts'

export interface BrowserOwnerHandle {
  readonly owner: string
}

export interface BrowserSessionHandle extends BrowserOwnerHandle {
  readonly session: BrowserSessionId
}

export interface BrowserTabHandle extends BrowserSessionHandle {
  readonly tab: string
}

export type BrowserSessionWireId = string & { readonly __browserSessionWireId: unique symbol }
export type BrowserTabWireId = string & { readonly __browserTabWireId: unique symbol }

function identity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('browser: handle identity must be a nonempty string')
}

export function browserSessionHandle(owner: string, session: BrowserSessionId): BrowserSessionHandle {
  identity(owner)
  identity(session)
  return { owner, session }
}

export function sessionWireId(scope: BrowserSessionHandle): BrowserSessionWireId {
  identity(scope.owner)
  identity(scope.session)
  return `dsh-session:v1:${encodeURIComponent(JSON.stringify([scope.owner, scope.session]))}` as BrowserSessionWireId
}

export function tabWireId(handle: BrowserTabHandle): BrowserTabWireId {
  identity(handle.owner)
  identity(handle.session)
  identity(handle.tab)
  return `dsh-tab:v1:${encodeURIComponent(JSON.stringify([handle.owner, handle.session, handle.tab]))}` as BrowserTabWireId
}

export function scopedTabs(scope: BrowserSessionHandle, tabs: readonly BrowserTab[]): readonly (Omit<BrowserTab, 'id'> & { readonly id: BrowserTabWireId })[] {
  return tabs.map(tab => ({ ...tab, id: tabWireId({ ...scope, tab: tab.id }) }))
}

export function resolveTabHandle(scope: BrowserSessionHandle, wire: string): BrowserTabHandle {
  let values: unknown
  try {
    if (!wire.startsWith('dsh-tab:v1:')) throw new Error()
    values = JSON.parse(decodeURIComponent(wire.slice('dsh-tab:v1:'.length)))
    if (!Array.isArray(values) || values.length !== 3) throw new Error()
    for (const value of values) identity(value)
  } catch {
    throw new Error('browser: invalid tab handle; use the id returned by dsh_browser_list_tabs')
  }
  const [owner, session, tab] = values as [string, string, string]
  const handle = { owner, session, tab }
  if (tabWireId(handle) !== wire) throw new Error('browser: noncanonical tab handle')
  if (owner !== scope.owner || session !== scope.session) throw new Error('browser: tab handle is not open in this owner/session; list tabs again')
  return handle
}
