/**
 * Session-scoped draft adapter: append captured reference groups WITHOUT
 * disturbing the user's typed question or caret, and only report success once
 * the group (and its full frozen snapshot) is durably saved.
 *
 * The host owns the editor (`SessionInputShell`): `setDraft` would replace the
 * whole document and move the caret, so it is structurally absent from
 * `HostInputFace`. Instead we
 *   - `captureInsertion()` (caret span + `draftRev`) and `readText()` before,
 *   - append the group to OUR OWN session-scoped store via `insertGroup` CAS,
 *   - call `persistDraft()` + our own `persist()`,
 *   - verify the host text/caret were not touched (`preservationIntact`).
 * The only editor write available is `insertText` with a `draftRev` CAS span,
 * exposed as `insertMarkerAtCaret` for an optional visible marker. Nothing here
 * ever auto-submits: the face has no `submit`/`prompt` method (§12 "user sends").
 *
 * Persistence keys are `dsh.browser-reference.draft.<sessionId>` — disjoint
 * from the host's `dsh.conversation.<sessionId>` — so cross-session isolation
 * is structural and a restart restores every fragment via `restore()`.
 *
 * @module dsh-browser-reference/production/draft-adapter
 */
import type { DraftReferenceState, KeyValueStorage, OrderedReferenceGroup, ReferenceChipInsert } from '../types.ts'
import {
  insertGroup,
  isOrderedReferenceGroup,
  removeGroup,
} from '../draft-reference.ts'
import type { DeliveryFailure, DeliveryRecord, FrozenSnapshot } from './protocol.ts'

export const DRAFT_STORE_PREFIX = 'dsh.browser-reference.draft.'

/** Same bound the plugin and its page bar enforce (three-state §3). */
export const MAX_DRAFT_COMMENT = 2000

export function draftStoreKey(sessionId: string): string {
  return `${DRAFT_STORE_PREFIX}${sessionId}`
}

/**
 * The subset of the host's `SessionInput.actions` we are allowed to touch.
 * `setDraft` is intentionally missing: using it would erase the question.
 */
export interface HostInputFace {
  /** `captureInsertion()` -> collapsed caret span + current `draftRev`. */
  captureInsertion(): { readonly start: number; readonly end: number; readonly draftRev: number }
  /** `insertText(span, text)` with a `draftRev` compare-and-set guard. */
  insertText(span: { readonly start: number; readonly end: number; readonly draftRev: number }, text: string): boolean
  /** Flush the host's own semantic draft (its `persistDraft`). */
  persistDraft(): void
  /** Live plain text of the editor (for preservation checks only, never written). */
  readText(): string
  /**
   * The editor's own reference-chip insertion. Absent on hosts that predate it; when present this is
   * the ONLY way a reference should enter the draft, because the editor then owns content, persistence
   * and send gating exactly as it does for a built-in quote.
   */
  insertReference?(ref: ReferenceChipInsert, span: { readonly start: number; readonly end: number; readonly draftRev: number }): boolean
  /**
   * 编辑器原生的「原子引用」插入（rc.3 的 `InputActions.insertQuote`）。
   *
   * 这是 rc.3 唯一可用的门径：`InputActions` 里没有 `insertReference`（那是 scoped 事件
   * `slash/input-insert-reference` 的 `InputTarget` 面）。用 `insertQuote` 后编辑器把它当内置引用
   * 对待——`InputState.draft` 会展开成引文、`occurrences` 随之增加，上游的发送闸门因此不再判空，
   * 「只有引用也能发」在没有改上游的前提下成立。
   */
  insertQuote?(text: string, summary?: string): boolean
  /** 把光标放回编辑器（确认按钮在侧栏里点击时焦点不在输入框）。 */
  focusEditor?(): void
}

export interface PreservationSnapshot {
  readonly text: string
  readonly span: { readonly start: number; readonly end: number; readonly draftRev: number }
}

/** Snapshot the user's question + caret before any reference work. */
export function capturePreservation(host: HostInputFace): PreservationSnapshot {
  return { text: host.readText(), span: host.captureInsertion() }
}

/** True only when text and caret/rev are byte-for-byte unchanged. */
export function preservationIntact(host: HostInputFace, before: PreservationSnapshot): boolean {
  const after = capturePreservation(host)
  // The user's TEXT and CARET must be untouched; the revision is allowed to move.
  //
  // Requiring an unchanged `draftRev` looked stricter but was wrong: persisting the draft is itself an
  // edit to the host document, so `persistDraft()` may legitimately bump the revision. The old check
  // therefore failed on every surface whose persist increments it — the reference stayed a pending
  // card, never entered the draft groups, and sending produced an EMPTY content array, which the Host
  // reported as "generation continuation is unavailable (session/agent-busy)".
  return after.text === before.text
    && after.span.start === before.span.start
    && after.span.end === before.span.end
}

/**
 * Optional CAS-safe marker insertion at the caret (the host's real mechanism).
 * Returns false when a stale `draftRev` rejects the edit; the caller may retry.
 */
export function insertMarkerAtCaret(
  host: HostInputFace,
  marker: string,
): { readonly ok: boolean; readonly span: PreservationSnapshot['span'] } {
  const span = host.captureInsertion()
  return { ok: host.insertText(span, marker), span }
}

/** A full, restorable reference: contract group + frozen snapshot + state. */
export interface StoredReflection {
  readonly referenceId: string
  readonly intentId: string
  readonly browserSessionId: string
  readonly deliveryState: 'prepared' | 'draft-applied' | 'acknowledged'
  readonly group: OrderedReferenceGroup
  readonly snapshot: FrozenSnapshot
  readonly failures: readonly DeliveryFailure[]
  readonly addedAt: number
  /**
   * The draft's own copy of the user's note. Editing it here never rewrites the
   * frozen page snapshot, so the quoted original keeps its provenance
   * (three-state §5: 快照保留来源身份).
   */
  readonly comment?: string
}

export interface SessionDraftState {
  readonly version: 1
  readonly draftRev: number
  /** Contract draft text; kept empty because the host owns the real question. */
  readonly text: string
  readonly groups: readonly OrderedReferenceGroup[]
  readonly reflections: readonly StoredReflection[]
  /**
   * Snapshots of references a send already carried.
   *
   * They are no longer draft cards, but the sent message still cites them: the
   * reveal link and the "where did this come from" answer must keep working
   * after the draft clears (a sent message's provenance is not draft state).
   */
  readonly sent: readonly StoredReflection[]
  /**
   * Snapshots retired from the draft but not yet durably written into `sent`.
   *
   * An accepted send moves its references here in one light, atomic step; the
   * archive is completed (and this marker cleared) by a separate, retryable
   * write. Keeping the marker means a full localStorage quota never loses the
   * sent message's provenance, and never leaves the reference in the draft to
   * be attached to the NEXT message.
   */
  readonly pendingArchive: readonly StoredReflection[]
  readonly tombstones: readonly string[]
  /**
   * 已经往编辑器里插过引文的引用 id。
   *
   * 必须持久化：dock 重挂载（切会话、热替换）会重建运行时实例，内存里的记账随之清空，
   * 于是同一条投递被反复插进草稿——界面上一整屏引号就是这么来的。
   */
  readonly inserted: readonly string[]
  /** Incremental `/deliveries` cursor, persisted per session. */
  readonly since: number
}

export type AppendStatus = 'appended' | 'duplicate' | 'invalid-group' | 'stale-revision'

export interface AppendResult {
  readonly status: AppendStatus
  readonly draftRev: number
}

export interface SessionDraftStore {
  state(): Readonly<SessionDraftState>
  /** CAS append via the contract's `insertGroup` (idempotent per referenceId). */
  append(reflection: StoredReflection): AppendResult
  /** Add a reflection for rendering when its group already exists (recovery). */
  ensureReflection(reflection: StoredReflection): void
  /** Remove + tombstone so a late retry cannot resurrect the reference. */
  remove(referenceId: string): boolean
  isTombstoned(referenceId: string): boolean
  /** 该引用是否已经插过引文（持久化，跨运行时实例）。 */
  hasInserted(referenceId: string): boolean
  /** 记下「这条引用已经插过引文」；立即持久化。 */
  markInserted(referenceId: string): void
  hasReference(referenceId: string): boolean
  /** Flip one reflection's delivery state (e.g. -> 'acknowledged' after ACK). */
  setDeliveryState(referenceId: string, state: StoredReflection['deliveryState']): void
  /** Edit the user's note for one reference; persisted immediately. */
  setComment(referenceId: string, comment: string): boolean
  /**
   * Phase 1 of an accepted send: atomically MOVE the submitted references out
   * of the draft (groups + reflections) into `pendingArchive` and tombstone
   * them. The full snapshots are moved, never copied, so this write is no
   * larger than the draft it replaces and succeeds even at a tight quota. The
   * in-memory state is updated before persisting, so even a failed write cannot
   * leave a reference in the draft. Returns the ids actually moved (empty on a
   * repeated call), which makes the operation idempotent.
   */
  retire(referenceIds: readonly string[], recovered?: readonly StoredReflection[]): readonly string[]
  /**
   * Phase 2 of an accepted send: durably write `pendingArchive` into `sent`,
   * deduplicated by referenceId. The durable write is attempted on a candidate
   * state and committed to memory only on success — a quota failure leaves the
   * pending marker intact for the next retry. Idempotent.
   */
  flushPendingArchive(): void
  /** A retired-but-not-yet-archived reference, for source reveal / provenance. */
  pendingReflection(referenceId: string): StoredReflection | undefined
  /** An archived (already sent) reference, for source reveal / provenance. */
  sentReflection(referenceId: string): StoredReflection | undefined
  setSince(since: number): void
  /** Contract draft state for `createSubmissionProjector`. */
  draftState(): DraftReferenceState
  persist(): void
  restore(): void
  dispose(): void
}

function emptyState(): SessionDraftState {
  return { version: 1, draftRev: 0, text: '', groups: [], reflections: [], sent: [], pendingArchive: [], tombstones: [], inserted: [], since: 0 }
}

/** Keep the archive bounded; the newest sends are the ones a reader follows. */
const MAX_SENT_REFLECTIONS = 200

function isStoredReflection(value: unknown): value is StoredReflection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.referenceId === 'string' && record.referenceId !== ''
    && typeof record.intentId === 'string'
    && typeof record.browserSessionId === 'string'
    && (record.deliveryState === 'prepared' || record.deliveryState === 'draft-applied' || record.deliveryState === 'acknowledged')
    && isOrderedReferenceGroup(record.group)
    && typeof record.snapshot === 'object' && record.snapshot !== null
    && Array.isArray(record.failures)
    && typeof record.addedAt === 'number' && Number.isFinite(record.addedAt)
    && (record.comment === undefined || typeof record.comment === 'string')
}

function parseState(raw: string): SessionDraftState | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    if (record.version !== 1) return undefined
    if (typeof record.draftRev !== 'number' || !Number.isInteger(record.draftRev) || record.draftRev < 0) return undefined
    if (typeof record.text !== 'string') return undefined
    if (!Array.isArray(record.groups) || !record.groups.every(isOrderedReferenceGroup)) return undefined
    if (!Array.isArray(record.reflections) || !record.reflections.every(isStoredReflection)) return undefined
    // Absent on state written before the archive existed; an old draft simply
    // has no already-sent snapshots yet.
    const sent: unknown = record.sent
    if (sent !== undefined && (!Array.isArray(sent) || !sent.every(isStoredReflection))) return undefined
    // Absent on state written before the two-phase retirement existed.
    const pendingArchive: unknown = record.pendingArchive
    if (pendingArchive !== undefined
      && (!Array.isArray(pendingArchive) || !pendingArchive.every(isStoredReflection))) return undefined
    if (!Array.isArray(record.tombstones) || !record.tombstones.every(entry => typeof entry === 'string')) return undefined
    if (typeof record.since !== 'number' || !Number.isFinite(record.since)) return undefined
    // Absent on state written before the durable insert ledger existed.
    const inserted: unknown = record.inserted
    if (inserted !== undefined && (!Array.isArray(inserted) || !inserted.every(entry => typeof entry === 'string'))) return undefined
    return {
      version: 1,
      draftRev: record.draftRev,
      text: record.text,
      groups: record.groups,
      reflections: record.reflections,
      sent: (sent ?? []) as readonly StoredReflection[],
      pendingArchive: (pendingArchive ?? []) as readonly StoredReflection[],
      tombstones: record.tombstones,
      inserted: (inserted ?? []) as readonly string[],
      since: record.since,
    }
  } catch {
    return undefined
  }
}

/** Build the store for ONE session; construction restores any persisted state. */
export function createSessionDraftStore(storage: KeyValueStorage, sessionId: string): SessionDraftStore {
  const key = draftStoreKey(sessionId)
  let state: SessionDraftState = emptyState()
  let disposed = false

  const load = (): void => {
    const raw = storage.getItem(key)
    state = raw === null ? emptyState() : parseState(raw) ?? emptyState()
  }

  const contractDraft = (): DraftReferenceState => ({
    draftRev: state.draftRev,
    text: state.text,
    groups: state.groups,
  })

  const persist = (): void => {
    storage.setItem(key, JSON.stringify(state))
  }

  load()

  return {
    state: () => state,
    append(reflection) {
      if (disposed) throw new Error('session draft store is disposed')
      if (state.tombstones.includes(reflection.referenceId)) {
        return { status: 'duplicate', draftRev: state.draftRev }
      }
      const result = insertGroup(contractDraft(), reflection.group, state.draftRev)
      if (!result.ok) {
        const status: AppendStatus = result.reason === 'duplicate'
          ? 'duplicate'
          : result.reason === 'invalid-group' ? 'invalid-group' : 'stale-revision'
        return { status, draftRev: state.draftRev }
      }
      state = {
        ...state,
        draftRev: result.value.draftRev,
        groups: result.value.groups,
        reflections: [...state.reflections, reflection],
      }
      persist()
      return { status: 'appended', draftRev: state.draftRev }
    },
    ensureReflection(reflection) {
      if (disposed || state.reflections.some(existing => existing.referenceId === reflection.referenceId)) return
      state = { ...state, reflections: [...state.reflections, reflection] }
      persist()
    },
    remove(referenceId) {
      if (disposed) throw new Error('session draft store is disposed')
      const result = removeGroup(contractDraft(), referenceId, state.draftRev)
      const tombstones = state.tombstones.includes(referenceId)
        ? state.tombstones
        : [...state.tombstones, referenceId]
      state = {
        ...state,
        draftRev: result.ok ? result.value.draftRev : state.draftRev,
        groups: result.ok ? result.value.groups : state.groups,
        reflections: state.reflections.filter(reflection => reflection.referenceId !== referenceId),
        tombstones,
      }
      persist()
      return result.ok
    },
    isTombstoned: referenceId => state.tombstones.includes(referenceId),
    hasInserted: referenceId => state.inserted.includes(referenceId),
    markInserted(referenceId) {
      if (state.inserted.includes(referenceId)) return
      state = { ...state, inserted: [...state.inserted, referenceId] }
      persist()
    },
    hasReference: referenceId => state.reflections.some(reflection => reflection.referenceId === referenceId),
    setDeliveryState(referenceId, deliveryState) {
      const index = state.reflections.findIndex(reflection => reflection.referenceId === referenceId)
      if (index < 0) return
      const reflections = [...state.reflections]
      reflections[index] = { ...reflections[index]!, deliveryState }
      state = { ...state, reflections }
      persist()
    },
    setComment(referenceId, comment) {
      if (disposed) throw new Error('session draft store is disposed')
      const index = state.reflections.findIndex(reflection => reflection.referenceId === referenceId)
      if (index < 0) return false
      const trimmed = comment.trim().slice(0, MAX_DRAFT_COMMENT)
      const reflections = [...state.reflections]
      const next = { ...reflections[index]! } as { -readonly [K in keyof StoredReflection]: StoredReflection[K] }
      // An emptied note removes the field entirely (§5.4: no note -> no block).
      if (trimmed === '') delete next.comment
      else next.comment = trimmed
      reflections[index] = next
      state = { ...state, reflections }
      persist()
      return true
    },
    setSince(since) {
      // A steady-state poll computes the SAME cursor every 1.5 s. Skip the
      // whole-state JSON.stringify + localStorage write when nothing changed.
      if (state.since === since) return
      state = { ...state, since }
      persist()
    },
    retire(referenceIds, recovered = []) {
      if (disposed) return []
      const wanted = new Set(referenceIds)
      const moving = state.reflections.filter(reflection => wanted.has(reflection.referenceId))
      const present = new Set(moving.map(reflection => reflection.referenceId))
      for (const reflection of recovered) {
        if (wanted.has(reflection.referenceId) && !present.has(reflection.referenceId)) {
          moving.push(reflection)
          present.add(reflection.referenceId)
        }
      }
      if (moving.length === 0) return []
      const known = new Set(state.pendingArchive.map(entry => entry.referenceId))
      const freshPending = moving.filter(reflection => !known.has(reflection.referenceId))
      // CAS-remove each carried group on a working draft; a repeated id is a
      // no-op, so a second call finds nothing to move and returns [].
      let draft = contractDraft()
      for (const reflection of moving) {
        const result = removeGroup(draft, reflection.referenceId, draft.draftRev)
        if (result.ok) draft = result.value
      }
      const next: SessionDraftState = {
        ...state,
        draftRev: draft.draftRev,
        groups: draft.groups,
        reflections: state.reflections.filter(reflection => !wanted.has(reflection.referenceId)),
        pendingArchive: [...state.pendingArchive, ...freshPending],
        tombstones: [...new Set([...state.tombstones, ...moving.map(reflection => reflection.referenceId)])],
      }
      // Commit in memory FIRST: even a failed durable write must not leave the
      // reference in the draft to be attached to the next message. The pending
      // marker is flushed (and the whole state re-persisted) by phase 2.
      state = next
      try { persist() } catch { /* full quota: the in-memory retirement still holds */ }
      return [...new Set(moving.map(reflection => reflection.referenceId))]
    },
    flushPendingArchive() {
      if (disposed || state.pendingArchive.length === 0) return
      const known = new Set(state.sent.map(entry => entry.referenceId))
      const fresh = state.pendingArchive.filter(entry => !known.has(entry.referenceId))
      const sent = [...state.sent, ...fresh]
      const next: SessionDraftState = {
        ...state,
        sent: sent.length > MAX_SENT_REFLECTIONS ? sent.slice(sent.length - MAX_SENT_REFLECTIONS) : sent,
        pendingArchive: [],
      }
      // Atomic: only commit the new state when the durable write succeeds. A
      // quota failure keeps `pendingArchive` for the next retry and never
      // resurrects a draft card.
      storage.setItem(key, JSON.stringify(next))
      state = next
    },
    pendingReflection: referenceId => state.pendingArchive.find(entry => entry.referenceId === referenceId),
    sentReflection: referenceId => state.sent.find(entry => entry.referenceId === referenceId),
    draftState: contractDraft,
    persist,
    restore: load,
    dispose() { disposed = true; state = emptyState() },
  }
}

/** Build a restorable reflection from one delivery + its projected group. */
export function reflectionFromDelivery(
  delivery: DeliveryRecord,
  group: OrderedReferenceGroup,
  addedAt: number,
): StoredReflection {
  return {
    referenceId: delivery.referenceId,
    intentId: delivery.intentId,
    browserSessionId: delivery.browserSessionId,
    deliveryState: delivery.state === 'consumed' ? 'acknowledged' : delivery.state,
    group,
    snapshot: delivery.snapshot,
    failures: delivery.failures,
    addedAt,
    ...delivery.snapshot.comment === undefined ? {} : { comment: delivery.snapshot.comment },
  }
}

export interface PreserveAppendOptions {
  readonly host: HostInputFace
  readonly store: SessionDraftStore
  readonly makeReflection: () => StoredReflection
}

export interface PreserveAppendResult {
  /** True only when the group was durably saved AND the host text/caret survived. */
  readonly ok: boolean
  readonly status: AppendStatus
  readonly draftRev: number
  readonly preserved: boolean
  /** Persist threw -> caller MUST NOT ACK. */
  readonly saveSucceeded: boolean
}

/**
 * The "append only after a durable save" transaction. Returns `ok` only when
 * the store persisted the group and the user's text/caret are intact. Callers
 * gate the ACK on `ok && saveSucceeded` AND on all assets being bound.
 * This function NEVER submits and NEVER calls `setDraft`.
 */
export function preserveAndAppend(options: PreserveAppendOptions): PreserveAppendResult {
  const { host, store } = options
  const before = capturePreservation(host)
  const result = store.append(options.makeReflection())
  const appended = result.status === 'appended'
  let saveSucceeded = false
  try {
    // Flush the host's own text draft and our group store; both must complete.
    host.persistDraft()
    store.persist()
    saveSucceeded = true
  } catch {
    saveSucceeded = false
  }
  const preserved = preservationIntact(host, before)
  return {
    ok: appended && saveSucceeded && preserved,
    status: result.status,
    draftRev: result.draftRev,
    preserved,
    saveSucceeded,
  }
}
