/** Shared start-page preferences over the settings mirror, with id-based edits. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { OmniboxPreferences } from '../browser/omnibox.ts'
import {
  MAX_STARTPAGE_ENGINES, MAX_STARTPAGE_SHORTCUTS,
} from '../../startpage-settings.ts'
import type { BrowserShortcut, BrowserStartPagePreferences } from '../../startpage-settings.ts'
import {
  engineIndex, nextEngineId, nextShortcutId, normalizeSearchEngineDraft, normalizeShortcutDraft,
  normalizeStartPage, reorderShortcuts, sameShortcutOrder, searchEnginePreferences, shortcutIndex,
} from './model.ts'
import type {
  SearchEngineDraft, ShortcutDraft, StartPageData, StartPageFailure,
} from './model.ts'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

type StartPageOp =
  | { op: 'set'; path: string[]; value: JsonValue }
  | { op: 'unset'; path: string[] }

const setOp = (path: readonly string[], value: unknown): StartPageOp =>
  ({ op: 'set', path: [...path], value: value as JsonValue })
const unsetOp = (path: readonly string[]): StartPageOp => ({ op: 'unset', path: [...path] })

type Plan =
  | { readonly kind: 'write'; readonly ops: readonly StartPageOp[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'fail'; readonly reason: StartPageFailure }

/** Render-facing shared preference state. */
export interface StartPageSnapshot extends StartPageData {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly writable: boolean
  readonly revision: number | undefined
}

/** Result of one start-page edit. */
export type StartPageWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: StartPageFailure }

const EMPTY: StartPageSnapshot = {
  status: 'loading', writable: false, revision: undefined,
  defaultSearchEngineId: '', engines: [], shortcuts: [],
}

const OK: StartPageWriteResult = { ok: true }
const fail = (reason: StartPageFailure): StartPageWriteResult => ({ ok: false, reason })

/**
 * One plugin-wide controller: the shared section is Host-scoped, not
 * Session-scoped. Writes are serialized, fenced by the read revision, and
 * recomputed from item ids after a conflict.
 */
export class StartPageController implements HostObservable<StartPageSnapshot> {
  private readonly store: SnapshotStore<StartPageSnapshot> = createSnapshotStore(EMPTY)
  private readonly unsubscribe: () => void
  private tail: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly createId: () => string
  private readonly applicationOrigin: string

  /**
   * @param form - the shared `browser-startpage` configuration form.
   * @param options - current application origin and an optional id source.
   */
  constructor(private readonly form: ConfigForm<BrowserStartPagePreferences>,
    options: { readonly applicationOrigin: string; readonly createId?: () => string }) {
    this.applicationOrigin = options.applicationOrigin
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID())
    this.unsubscribe = form.subscribe(() => { this.publish() })
    this.publish()
  }

  /** @returns immutable state for the start page and address-bar hints. */
  getSnapshot = (): StartPageSnapshot => this.store.getSnapshot()
  /** @param listener - state invalidation. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** @returns engines and selection read at manual-submission time. */
  preferences(): OmniboxPreferences {
    const snapshot = this.getSnapshot()
    return {
      defaultSearchEngineId: snapshot.defaultSearchEngineId,
      searchEngines: searchEnginePreferences(snapshot),
    }
  }

  /** @returns the selected engine when it exists and can search. */
  selectedEngine(): StartPageData['engines'][number] | undefined {
    const snapshot = this.getSnapshot()
    return snapshot.engines.find(engine => engine.id === snapshot.defaultSearchEngineId && engine.valid)
  }

  /** @param draft - typed shortcut form. @returns write settlement. */
  async addShortcut(draft: ShortcutDraft): Promise<StartPageWriteResult> {
    const normalized = normalizeShortcutDraft(draft, this.applicationOrigin)
    if (!normalized.ok) return fail(normalized.reason)
    return this.enqueue(() => this.commit(current => {
      if (current.shortcuts.length >= MAX_STARTPAGE_SHORTCUTS) return { kind: 'fail', reason: 'limit' }
      const id = nextShortcutId(current.shortcuts, this.createId)
      return {
        kind: 'write',
        ops: [setOp(['shortcuts', String(current.shortcuts.length)], { id, ...normalized.value })],
      }
    }))
  }

  /**
   * @param id - stable shortcut id.
   * @param draft - typed replacement fields.
   * @returns write settlement; missing means another client deleted it.
   */
  async updateShortcut(id: string, draft: ShortcutDraft): Promise<StartPageWriteResult> {
    const normalized = normalizeShortcutDraft(draft, this.applicationOrigin)
    if (!normalized.ok) return fail(normalized.reason)
    return this.enqueue(() => this.commit(current => {
      const index = shortcutIndex(current.shortcuts, id)
      if (index === -1) return { kind: 'fail', reason: 'missing' }
      const existing = current.shortcuts[index]!
      return {
        kind: 'write',
        ops: [setOp(['shortcuts', String(index)], { ...existing, ...normalized.value, id })],
      }
    }))
  }

  /** @param id - stable shortcut id; already absent is a successful no-op. */
  async removeShortcut(id: string): Promise<StartPageWriteResult> {
    return this.enqueue(() => this.commit(current => {
      const index = shortcutIndex(current.shortcuts, id)
      if (index === -1) return { kind: 'none' }
      return { kind: 'write', ops: [unsetOp(['shortcuts', String(index)])] }
    }))
  }

  /**
   * Re-insert a removed shortcut at its previous position, based on the latest
   * stored order rather than the order the card was rendered in.
   * @param shortcut - removed entry.
   * @param index - position it occupied.
   */
  async restoreShortcut(shortcut: BrowserShortcut, index: number): Promise<StartPageWriteResult> {
    return this.enqueue(() => this.commit(current => {
      if (current.shortcuts.some(entry => entry.id === shortcut.id)) return { kind: 'none' }
      if (current.shortcuts.length >= MAX_STARTPAGE_SHORTCUTS) return { kind: 'fail', reason: 'limit' }
      const entries = [...current.shortcuts]
      entries.splice(Math.max(0, Math.min(index, entries.length)), 0, shortcut)
      return { kind: 'write', ops: [setOp(['shortcuts'], entries)] }
    }))
  }

  /**
   * Move one shortcut across its nearest neighbour.
   * @param id - stable shortcut id.
   * @param offset - negative moves earlier, positive later.
   */
  async moveShortcut(id: string, offset: -1 | 1): Promise<StartPageWriteResult> {
    return this.enqueue(() => this.commit(current => {
      const index = shortcutIndex(current.shortcuts, id)
      if (index === -1) return { kind: 'fail', reason: 'missing' }
      const target = index + offset
      if (target < 0 || target >= current.shortcuts.length) return { kind: 'none' }
      const entries = [...current.shortcuts]
      const [moved] = entries.splice(index, 1)
      entries.splice(target, 0, moved!)
      return { kind: 'write', ops: [setOp(['shortcuts'], entries)] }
    }))
  }

  /**
   * Apply a drag result; ids the latest section no longer holds are ignored and
   * their surviving neighbours keep their stored relative order.
   * @param orderedIds - requested id order.
   */
  async reorderShortcuts(orderedIds: readonly string[]): Promise<StartPageWriteResult> {
    return this.enqueue(() => this.commit(current => {
      const next = reorderShortcuts(current.shortcuts, orderedIds)
      if (sameShortcutOrder(current.shortcuts, next)) return { kind: 'none' }
      return { kind: 'write', ops: [setOp(['shortcuts'], [...next])] }
    }))
  }

  /** @param id - engine that must exist and be usable. */
  async setDefaultSearchEngine(id: string): Promise<StartPageWriteResult> {
    return this.enqueue(() => this.commit(current => {
      const data = normalizeStartPage(current, this.applicationOrigin)
      const engine = data.engines.find(candidate => candidate.id === id)
      if (engine === undefined) return { kind: 'fail', reason: 'missing' }
      if (!engine.valid) return { kind: 'fail', reason: 'invalid' }
      if (current.defaultSearchEngineId === id) return { kind: 'none' }
      return { kind: 'write', ops: [setOp(['defaultSearchEngineId'], id)] }
    }))
  }

  /** @param draft - validated engine form. */
  async addSearchEngine(draft: SearchEngineDraft): Promise<StartPageWriteResult> {
    const normalized = normalizeSearchEngineDraft(draft, this.applicationOrigin)
    if (!normalized.ok) return fail(normalized.reason)
    return this.enqueue(() => this.commit(current => {
      if (current.searchEngines.length >= MAX_STARTPAGE_ENGINES) return { kind: 'fail', reason: 'limit' }
      const id = nextEngineId(current.searchEngines, this.createId)
      return {
        kind: 'write',
        ops: [setOp(['searchEngines', String(current.searchEngines.length)], { id, ...normalized.value })],
      }
    }))
  }

  /** @param id - stable engine id. @param draft - validated replacement fields. */
  async updateSearchEngine(id: string, draft: SearchEngineDraft): Promise<StartPageWriteResult> {
    const normalized = normalizeSearchEngineDraft(draft, this.applicationOrigin)
    if (!normalized.ok) return fail(normalized.reason)
    return this.enqueue(() => this.commit(current => {
      const index = engineIndex(current.searchEngines, id)
      if (index === -1) return { kind: 'fail', reason: 'missing' }
      return {
        kind: 'write',
        ops: [setOp(['searchEngines', String(index)], { id, ...normalized.value })],
      }
    }))
  }

  /**
   * Remove an engine; removing the selected one must name a usable replacement
   * in the same atomic write.
   * @param id - engine to remove.
   * @param replacementId - engine selected afterwards when `id` was the default.
   */
  async removeSearchEngine(id: string, replacementId?: string): Promise<StartPageWriteResult> {
    return this.enqueue(() => this.commit(current => {
      const index = engineIndex(current.searchEngines, id)
      if (index === -1) return { kind: 'none' }
      const ops: StartPageOp[] = [unsetOp(['searchEngines', String(index)])]
      if (current.defaultSearchEngineId === id) {
        if (replacementId === undefined || replacementId === id) return { kind: 'fail', reason: 'missing' }
        const data = normalizeStartPage(current, this.applicationOrigin)
        const replacement = data.engines.find(candidate => candidate.id === replacementId)
        if (replacement === undefined) return { kind: 'fail', reason: 'missing' }
        if (!replacement.valid) return { kind: 'fail', reason: 'invalid' }
        ops.push(setOp(['defaultSearchEngineId'], replacementId))
      }
      return { kind: 'write', ops }
    }))
  }

  /** Stop publishing; the shared form stays owned by the settings provider. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
  }

  private publish(): void {
    if (this.disposed) return
    const snapshot = this.form.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.value === undefined) {
      this.store.set({
        status: snapshot.status, writable: snapshot.writable, revision: snapshot.revision,
        defaultSearchEngineId: '', engines: [], shortcuts: [],
      })
      return
    }
    this.store.set({
      status: 'ready',
      writable: snapshot.writable,
      revision: snapshot.revision,
      ...normalizeStartPage(snapshot.value, this.applicationOrigin),
    })
  }

  private enqueue(operation: () => Promise<StartPageWriteResult>): Promise<StartPageWriteResult> {
    if (this.disposed) return Promise.resolve(fail('unavailable'))
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private async commit(build: (current: BrowserStartPagePreferences) => Plan): Promise<StartPageWriteResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.disposed) return fail('unavailable')
      const snapshot = this.form.getSnapshot()
      if (snapshot.status !== 'ready' || snapshot.value === undefined || snapshot.revision === undefined) {
        return fail('unavailable')
      }
      if (!snapshot.writable) return fail('readonly')
      const plan = build(snapshot.value)
      if (plan.kind === 'fail') return fail(plan.reason)
      if (plan.kind === 'none') return OK
      let accepted: boolean
      try {
        accepted = await this.form.mutate(plan.ops, snapshot.revision)
      } catch {
        return fail('failed')
      }
      if (accepted) return OK
    }
    return fail('conflict')
  }
}
