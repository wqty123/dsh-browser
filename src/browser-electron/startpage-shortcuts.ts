/**
 * Sidebar start-page shortcuts, written through the shared settings section.
 *
 * WHY THIS LIVES HERE
 * The start page belongs to `@deepseek-ai/dsh-client-ui-sidebar-browser`, and its
 * preferences are a volatile settings section (`browser-startpage`). A human edits
 * them in the sidebar; an agent has no sidebar, so without a seam of its own it can
 * never add a shortcut. This module is that seam: it reads and writes the SAME
 * section through `ctx.settings`, so both callers see one list — no second store,
 * no file of our own, no drift.
 *
 * The section is validated by its owning entry's schema, so the bounds below exist
 * to give a caller a clear error BEFORE the settings layer rejects an opaque one;
 * they mirror `startpage-settings.ts` and must stay in step with it.
 * @module dsh-browser/browser-electron/startpage-shortcuts
 */

/** Settings entry id of the start page (its Host companion's plugin id). */
export const STARTPAGE_NAMESPACE = 'browser-startpage'

/** Maximum stored shortcut entries; mirrors the start page schema. */
export const MAX_SHORTCUTS = 48
/** Maximum shortcut display title length. */
export const MAX_TITLE = 80
/** Maximum stored URL length. */
export const MAX_URL = 2048
/** Maximum icon key length. */
export const MAX_ICON_KEY = 32

/** One stored shortcut. */
export interface ShortcutRecord {
  readonly id: string
  readonly title: string
  readonly url: string
  readonly iconKey?: string
}

/** The outcome of one list/add/remove call. */
export interface ShortcutList {
  readonly shortcuts: readonly ShortcutRecord[]
  readonly revision: number | undefined
}

/** A refusal a caller can act on, rather than a stack trace. */
export class ShortcutError extends Error {
  readonly code: string

  /** @param code - stable machine-readable reason. @param message - human sentence. */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ShortcutError'
    this.code = code
  }
}

/** The slice of `ctx.settings` this module needs. */
export interface ShortcutSettings {
  describe(): readonly { readonly ns: string; readonly revision: number; readonly value: unknown }[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/u
const URL_PATTERN = /^https?:\/\/\S+$/u

/** Validate one stored record; a malformed row is dropped rather than rendered. */
export function isShortcutRecord(value: unknown): value is ShortcutRecord {
  if (value === null || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && ID_PATTERN.test(row.id)
    && typeof row.title === 'string' && row.title.trim() !== '' && row.title.length <= MAX_TITLE
    && typeof row.url === 'string' && URL_PATTERN.test(row.url) && row.url.length <= MAX_URL
    && (row.iconKey === undefined || (typeof row.iconKey === 'string' && row.iconKey.length <= MAX_ICON_KEY))
}

/**
 * Normalise one caller-supplied shortcut.
 * @param draft - untrusted input from a tool call or an HTTP body.
 * @returns the record to store.
 */
export function normalizeShortcut(draft: { title?: unknown; url?: unknown; iconKey?: unknown; id?: unknown }): ShortcutRecord {
  const title = typeof draft.title === 'string' ? draft.title.trim() : ''
  const url = typeof draft.url === 'string' ? draft.url.trim() : ''
  if (title === '') throw new ShortcutError('title', 'a shortcut needs a title')
  if (title.length > MAX_TITLE) throw new ShortcutError('title', `a title may hold at most ${MAX_TITLE} characters`)
  if (url === '') throw new ShortcutError('url', 'a shortcut needs an http(s) URL')
  if (!URL_PATTERN.test(url)) throw new ShortcutError('url', 'the URL must start with http:// or https:// and contain no spaces')
  if (url.length > MAX_URL) throw new ShortcutError('url', `a URL may hold at most ${MAX_URL} characters`)
  const iconKey = typeof draft.iconKey === 'string' ? draft.iconKey.trim() : ''
  if (iconKey.length > MAX_ICON_KEY) throw new ShortcutError('icon', `an icon key may hold at most ${MAX_ICON_KEY} characters`)
  // Milliseconds alone collide when two adds land in the same tick, so a random
  // suffix keeps the generated id unique without depending on the clock.
  const id = typeof draft.id === 'string' && ID_PATTERN.test(draft.id)
    ? draft.id
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return { id, title, url, ...iconKey === '' ? {} : { iconKey } }
}

/**
 * Compare addresses by their parsed form, not their literal spelling:
 * `https://x.com` and `https://x.com/` (or a differently cased host, or an
 * explicit default port) are the same destination. A malformed value falls
 * back to its literal form, so the duplicate check can never reject an add.
 */
function canonicalUrl(value: string): string {
  try { return new URL(value).href } catch { return value }
}

/**
 * Read and write the shared shortcut list.
 * @param settings - current settings service, resolved lazily so a late service still works.
 */
export function createShortcutStore(settings: () => ShortcutSettings | undefined): {
  list: () => ShortcutList
  add: (draft: { title?: unknown; url?: unknown; iconKey?: unknown }) => Promise<{ shortcut: ShortcutRecord; shortcuts: readonly ShortcutRecord[] }>
  remove: (id: string) => Promise<{ removed: boolean; shortcuts: readonly ShortcutRecord[] }>
} {
  const read = (): ShortcutList & { raw: readonly unknown[]; revisionNumber: number } => {
    const service = settings()
    if (service === undefined) throw new ShortcutError('unavailable', 'the settings service is not available in this host')
    const row = service.describe().find(entry => entry.ns === STARTPAGE_NAMESPACE)
    if (row === undefined) {
      throw new ShortcutError('unavailable', `the "${STARTPAGE_NAMESPACE}" settings entry is not loaded in this profile`)
    }
    const value = (row.value ?? {}) as { shortcuts?: unknown }
    // Keep the RAW array as well as the filtered one. The sidebar deliberately
    // keeps rows whose `target` is still being repaired (they fail
    // isShortcutRecord but are NOT ours to delete). Writes must be derived from
    // `raw` with an id-level edit; `shortcuts` is only for duplicate checks and
    // for what a caller sees.
    const raw: readonly unknown[] = Array.isArray(value.shortcuts) ? value.shortcuts : []
    const shortcuts = raw.filter(isShortcutRecord)
    return { raw, shortcuts, revision: row.revision, revisionNumber: row.revision }
  }

  /**
   * Apply one edit, recomputing it from the CURRENT list on a stale revision.
   *
   * Retrying with the previously computed array would write a snapshot taken
   * before the other writer's change and silently drop it (last writer wins).
   * Rebuilding from the fresh list instead re-runs the edit — including its
   * limit and duplicate checks — so a concurrent add survives this one.
   * @param apply - turns the current list into the next list plus its result.
   * @returns the result computed by the attempt that was accepted.
   */
  interface MutateContext {
    /** The raw, UNFILTERED section array — the only safe base for a write. */
    readonly raw: readonly unknown[]
    /** Filtered records, for duplicate/limit checks and for the returned view. */
    readonly shortcuts: readonly ShortcutRecord[]
  }
  interface MutateEdit<T> {
    /** The value to write back, derived from `raw` (never from `shortcuts`). */
    readonly next: readonly unknown[]
    readonly result: T
  }

  const mutate = async <T>(apply: (context: MutateContext) => MutateEdit<T>): Promise<T> => {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const service = settings()
      if (service === undefined) throw new ShortcutError('unavailable', 'the settings service is not available in this host')
      const { raw, shortcuts, revisionNumber } = read()
      const { next, result } = apply({ raw, shortcuts })
      // `apply` returns the SAME `raw` reference when there is nothing to write
      // (a remove for an already-absent id); writing would bump the revision
      // for no change. The equality is against raw, not the filtered view.
      if (next === raw) return result
      try {
        await service.update(STARTPAGE_NAMESPACE, { shortcuts: next }, revisionNumber)
        return result
      } catch (error) {
        // Two writers (the sidebar and an agent) can race between read and write.
        // Only a revision conflict is retried; anything else is a real failure.
        if (!/conflict|revision/iu.test(String(error))) throw error
        lastError = error
      }
    }
    throw new ShortcutError('conflict', `the shortcut list kept changing while it was edited: ${String(lastError)}`)
  }

  const idOf = (entry: unknown): unknown =>
    entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>).id : undefined

  return {
    list: () => {
      const { shortcuts, revision } = read()
      return { shortcuts, revision }
    },
    async add(draft) {
      const shortcut = normalizeShortcut(draft)
      return mutate(({ raw, shortcuts }) => {
        if (shortcuts.length >= MAX_SHORTCUTS) {
          throw new ShortcutError('limit', `the start page holds at most ${MAX_SHORTCUTS} shortcuts`)
        }
        if (shortcuts.some(entry => canonicalUrl(entry.url) === canonicalUrl(shortcut.url))) {
          throw new ShortcutError('conflict', `a shortcut to ${shortcut.url} already exists`)
        }
        // id-level minimal edit: push onto a COPY of the raw array, so rows the
        // sidebar is still repairing are carried through untouched.
        const next = [...raw, shortcut]
        return { next, result: { shortcut, shortcuts: next.filter(isShortcutRecord) } }
      })
    },
    async remove(id) {
      return mutate<{ removed: boolean; shortcuts: readonly ShortcutRecord[] }>(({ raw, shortcuts }) => {
        // Filter a COPY of raw by id; every other row — valid or not — survives.
        const next = raw.filter(entry => idOf(entry) !== id)
        if (next.length === raw.length) return { next: raw, result: { removed: false, shortcuts } }
        return { next, result: { removed: true, shortcuts: next.filter(isShortcutRecord) } }
      })
    },
  }
}
