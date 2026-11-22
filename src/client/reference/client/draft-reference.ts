/**
 * Pure, persisted draft-side ordered reference groups (§3.4, §12.2, B23).
 *
 * Every mutator is a compare-and-set (CAS) edit keyed by `draftRev`: a stale
 * revision is rejected instead of silently clobbering a concurrent edit.
 * Serialization is strict so an unsent draft survives a restart with every
 * fragment and asset binding intact.
 */
import { isReferenceTable, isReferenceText, MAX_REFERENCE_TEXT } from '../../../reference-text.ts'
import type {
  BrowserReferencePart,
  OrderedReferenceGroup,
  DraftReferenceState,
  CasResult,
  CasRejectReason,
  KeyValueStorage,
} from './types.ts'

export const DRAFT_FORMAT_VERSION = 1
export const DEFAULT_DRAFT_STORAGE_KEY = 'dsh.browser-reference.draft'

export class DraftReferenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DraftReferenceError'
  }
}

export interface TextInsertion {
  /** Start offset within the current plain text. */
  readonly start: number
  /** End offset within the current plain text (exclusive). */
  readonly end: number
  /** Replacement text. */
  readonly text: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isOptionalString(value: unknown, max = 2048): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= max)
}

/** Strict structural validation of one captured part. */
export function isBrowserReferencePart(value: unknown): value is BrowserReferencePart {
  if (!isRecord(value)) return false
  const kinds: readonly string[] = ['text', 'image', 'table']
  const statuses: readonly string[] = ['ready', 'failed']
  return typeof value.kind === 'string' && kinds.includes(value.kind)
    && isNonEmptyString(value.partId)
    && isNonEmptyString(value.referenceId)
    && isOptionalString(value.assetKey)
    && isOptionalString(value.text, MAX_REFERENCE_TEXT)
    && (value.content === undefined || isReferenceText(value.content))
    && (value.table === undefined || isReferenceTable(value.table))
    && isOptionalString(value.mimeType)
    && isOptionalString(value.label, MAX_REFERENCE_TEXT)
    && (value.status === undefined || (typeof value.status === 'string' && statuses.includes(value.status)))
}

/** Strict validation of a whole ordered group (unique part ids, matching owner). */
export function isOrderedReferenceGroup(value: unknown): value is OrderedReferenceGroup {
  if (!isRecord(value) || !isNonEmptyString(value.referenceId) || !Array.isArray(value.parts)) return false
  const seen = new Set<string>()
  for (const part of value.parts as readonly unknown[]) {
    if (!isBrowserReferencePart(part)) return false
    if (part.referenceId !== value.referenceId) return false
    if (seen.has(part.partId)) return false
    seen.add(part.partId)
  }
  return true
}

export function emptyDraftState(): DraftReferenceState {
  return { draftRev: 0, text: '', groups: [] }
}

function reject(state: DraftReferenceState, reason: CasRejectReason): CasResult<DraftReferenceState> {
  return { ok: false, reason, expectedRev: state.draftRev }
}

function commit(state: DraftReferenceState, text: string, groups: readonly OrderedReferenceGroup[]): CasResult<DraftReferenceState> {
  return { ok: true, value: { draftRev: state.draftRev + 1, text, groups } }
}

function current(state: DraftReferenceState, expectedRev: number): boolean {
  return state.draftRev === expectedRev
}

/** Append a whole ordered group. */
export function insertGroup(state: DraftReferenceState, group: OrderedReferenceGroup, expectedRev: number): CasResult<DraftReferenceState> {
  if (!current(state, expectedRev)) return reject(state, 'stale-revision')
  if (!isOrderedReferenceGroup(group)) return reject(state, 'invalid-group')
  if (state.groups.some(existing => existing.referenceId === group.referenceId)) return reject(state, 'duplicate')
  return commit(state, state.text, [...state.groups, group])
}

/** Remove a whole ordered group. */
export function removeGroup(state: DraftReferenceState, referenceId: string, expectedRev: number): CasResult<DraftReferenceState> {
  if (!current(state, expectedRev)) return reject(state, 'stale-revision')
  const index = state.groups.findIndex(group => group.referenceId === referenceId)
  if (index < 0) return reject(state, 'not-found')
  const groups = [...state.groups]
  groups.splice(index, 1)
  return commit(state, state.text, groups)
}

/** CAS text edit: replace `text[start, end)` only when the revision is current. */
export function insertText(state: DraftReferenceState, span: TextInsertion, expectedRev: number): CasResult<DraftReferenceState> {
  if (!current(state, expectedRev)) return reject(state, 'stale-revision')
  const { start, end, text } = span
  if (!Number.isInteger(start) || !Number.isInteger(end)
    || start < 0 || end < start || end > state.text.length || typeof text !== 'string') {
    return reject(state, 'invalid-span')
  }
  const nextText = state.text.slice(0, start) + text + state.text.slice(end)
  return commit(state, nextText, state.groups)
}

export interface SerializedDraft {
  readonly version: typeof DRAFT_FORMAT_VERSION
  readonly draftRev: number
  readonly text: string
  readonly groups: readonly OrderedReferenceGroup[]
}

export function serializeDraft(state: DraftReferenceState): string {
  const snapshot: SerializedDraft = {
    version: DRAFT_FORMAT_VERSION,
    draftRev: state.draftRev,
    text: state.text,
    groups: state.groups,
  }
  return JSON.stringify(snapshot)
}

/** Strict decode: any malformed field yields undefined instead of a partial draft. */
export function deserializeDraft(raw: unknown): DraftReferenceState | undefined {
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!isRecord(parsed) || parsed.version !== DRAFT_FORMAT_VERSION) return undefined
    if (typeof parsed.draftRev !== 'number' || !Number.isInteger(parsed.draftRev) || parsed.draftRev < 0) return undefined
    if (typeof parsed.text !== 'string') return undefined
    if (!Array.isArray(parsed.groups)) return undefined
    const groups: OrderedReferenceGroup[] = []
    const seen = new Set<string>()
    for (const group of parsed.groups as readonly unknown[]) {
      if (!isOrderedReferenceGroup(group)) return undefined
      if (seen.has(group.referenceId)) return undefined
      seen.add(group.referenceId)
      groups.push(group)
    }
    return { draftRev: parsed.draftRev, text: parsed.text, groups }
  } catch {
    return undefined
  }
}

export function persistDraft(storage: KeyValueStorage, key: string, state: DraftReferenceState): void {
  storage.setItem(key, serializeDraft(state))
}
