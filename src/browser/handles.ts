import type { BrowserTab } from './types.ts'

export interface BrowserOwnerHandle {
  readonly owner: string
}

export interface BrowserSessionHandle extends BrowserOwnerHandle {
  readonly session: string
}

export interface BrowserTabHandle extends BrowserSessionHandle {
  readonly tab: string
}

export type BrowserSessionWireId = string & { readonly __browserSessionWireId: unique symbol }
export type BrowserTabWireId = string & { readonly __browserTabWireId: unique symbol }

function identity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('browser: handle identity must be a nonempty string')
}

export function browserSessionHandle(owner: string, session: string): BrowserSessionHandle {
  identity(owner)
  identity(session)
  if (session.startsWith('dsh-session:')) {
    const handle = resolveSessionHandle(session)
    if (handle.owner !== owner) throw new Error('browser: session handle belongs to another owner')
    return handle
  }
  return { owner, session }
}

export function resolveSessionHandle(wire: string): BrowserSessionHandle {
  let values: unknown
  try {
    if (!wire.startsWith('dsh-session:v1:')) throw new Error()
    values = JSON.parse(decodeURIComponent(wire.slice('dsh-session:v1:'.length)))
    if (!Array.isArray(values) || values.length !== 2) throw new Error()
    for (const value of values) identity(value)
  } catch {
    throw new Error('browser: invalid session handle')
  }
  const [owner, session] = values as [string, string]
  const handle = { owner, session }
  if (sessionWireId(handle) !== wire) throw new Error('browser: noncanonical session handle')
  return handle
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
  return tabs.map(tab => ({ ...tab, id: tab.id.startsWith('dsh-tab:')
    ? tabWireId(resolveTabHandle(scope, tab.id))
    : tabWireId({ ...scope, tab: tab.id }) }))
}

export function readTabHandle(wire: string): BrowserTabHandle {
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
  return handle
}

export function resolveTabHandle(scope: BrowserSessionHandle, wire: string): BrowserTabHandle {
  const handle = readTabHandle(wire)
  const { owner, session } = handle
  if (owner !== scope.owner || session !== scope.session) throw new Error('browser: tab handle is not open in this owner/session; list tabs again')
  return handle
}
