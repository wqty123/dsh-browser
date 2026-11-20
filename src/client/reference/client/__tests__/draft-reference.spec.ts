import { describe, expect, it } from 'vitest'
import type { OrderedReferenceGroup, DraftReferenceState, CasResult } from '../types.ts'
import { createMemoryStorage } from '../types.ts'
import {
  emptyDraftState,
  insertGroup,
  removeGroup,
  insertText,
  serializeDraft,
  deserializeDraft,
  persistDraft,
  isBrowserReferencePart,
  isOrderedReferenceGroup,
} from '../draft-reference.ts'

const group: OrderedReferenceGroup = {
  referenceId: 'g1',
  parts: [
    { kind: 'text', partId: 't1', referenceId: 'g1', text: '文A' },
    { kind: 'image', partId: 'i1', referenceId: 'g1', assetKey: 'asset-1' },
    { kind: 'table', partId: 'tb1', referenceId: 'g1', text: '|a|b|' },
    { kind: 'image', partId: 'i2', referenceId: 'g1', assetKey: 'asset-2' },
    { kind: 'text', partId: 't2', referenceId: 'g1', text: '文B' },
  ],
}

function unwrap(result: CasResult<DraftReferenceState>): DraftReferenceState {
  if (!result.ok) throw new Error(`unexpected CAS rejection: ${result.reason}`)
  return result.value
}

describe('draft ordered groups', () => {
  it('insertGroup preserves the captured interleaved order (B18 draft side)', () => {
    const state = unwrap(insertGroup(emptyDraftState(), group, 0))
    expect(state.draftRev).toBe(1)
    expect(state.groups[0]!.parts.map(part => part.partId)).toEqual(['t1', 'i1', 'tb1', 'i2', 't2'])
  })

  it('rejects every edit made against a stale draftRev (CAS)', () => {
    const state = unwrap(insertGroup(emptyDraftState(), group, 0))
    expect(removeGroup(state, 'g1', 0)).toEqual({ ok: false, reason: 'stale-revision', expectedRev: 1 })
    expect(insertText(state, { start: 0, end: 0, text: 'x' }, 0).ok).toBe(false)
    expect(insertGroup(state, { referenceId: 'g2', parts: [] }, 0).ok).toBe(false)
  })

  it('removes a whole group and keeps the remaining order stable', () => {
    const s1 = unwrap(insertGroup(emptyDraftState(), group, 0))
    const s2 = unwrap(insertGroup(s1, { referenceId: 'g2', parts: [] }, 1))
    const s3 = unwrap(removeGroup(s2, 'g1', 2))
    expect(s3.groups.map(entry => entry.referenceId)).toEqual(['g2'])
    expect(s3.draftRev).toBe(3)
  })

  it('rejects duplicate groups, mismatched part owners and missing targets', () => {
    const s1 = unwrap(insertGroup(emptyDraftState(), group, 0))
    expect(insertGroup(s1, group, 1)).toMatchObject({ ok: false, reason: 'duplicate' })
    expect(insertGroup(s1, { referenceId: 'g2', parts: [{ kind: 'text', partId: 'x', referenceId: 'other' }] }, 1))
      .toMatchObject({ ok: false, reason: 'invalid-group' })
    expect(removeGroup(s1, 'missing', 1)).toMatchObject({ ok: false, reason: 'not-found' })
  })

  it('insertText applies a bounded span edit and rejects invalid spans', () => {
    const s1 = unwrap(insertGroup(emptyDraftState(), group, 0))
    const s2 = unwrap(insertText(s1, { start: 0, end: 0, text: 'hello' }, 1))
    expect(s2.text).toBe('hello')
    const s3 = unwrap(insertText(s2, { start: 1, end: 3, text: 'ELLO' }, 2))
    expect(s3.text).toBe('hELLOlo')
    expect(insertText(s3, { start: -1, end: 0, text: 'x' }, 3)).toMatchObject({ ok: false, reason: 'invalid-span' })
    expect(insertText(s3, { start: 0, end: 99, text: 'x' }, 3)).toMatchObject({ ok: false, reason: 'invalid-span' })
  })
})

describe('draft serialization and restart recovery', () => {
  it('persistDraft round-trips every fragment and asset binding (B23)', () => {
    const state = unwrap(insertGroup(emptyDraftState(), group, 0))
    const withText = unwrap(insertText(state, { start: 0, end: 0, text: '草稿文字' }, 1))
    const raw = serializeDraft(withText)
    expect(deserializeDraft(raw)).toEqual(withText)
    const storage = createMemoryStorage()
    persistDraft(storage, 'draft', withText)
    const restored = deserializeDraft(storage.getItem('draft'))!
    expect(restored).toEqual(withText)
    expect(restored.groups[0]!.parts).toHaveLength(5)
    expect(restored.groups[0]!.parts.find(part => part.partId === 'i1')!.assetKey).toBe('asset-1')
  })

  it('deserializeDraft is strict about the shape it accepts', () => {
    expect(deserializeDraft('not json')).toBeUndefined()
    expect(deserializeDraft(JSON.stringify({ version: 2, draftRev: 0, text: '', groups: [] }))).toBeUndefined()
    expect(deserializeDraft(JSON.stringify({ version: 1, draftRev: -1, text: '', groups: [] }))).toBeUndefined()
    expect(deserializeDraft(JSON.stringify({ version: 1, draftRev: 0, text: 42, groups: [] }))).toBeUndefined()
    expect(deserializeDraft(JSON.stringify({
      version: 1, draftRev: 0, text: '',
      groups: [{ referenceId: 'g1', parts: [{ kind: 'image', partId: 'x', referenceId: 'g2' }] }],
    }))).toBeUndefined()
    expect(deserializeDraft(JSON.stringify({
      version: 1, draftRev: 0, text: '',
      groups: [{ referenceId: 'g1', parts: [{ kind: 'bogus', partId: 'x', referenceId: 'g1' }] }],
    }))).toBeUndefined()
    expect(deserializeDraft('{bad')).toBeUndefined()
  })

  it('validators reject duplicate part ids and mismatched owners', () => {
    expect(isBrowserReferencePart({ kind: 'text', partId: 'p', referenceId: 'g' })).toBe(true)
    expect(isBrowserReferencePart({ kind: 'bogus', partId: 'p', referenceId: 'g' })).toBe(false)
    expect(isOrderedReferenceGroup({
      referenceId: 'g',
      parts: [
        { kind: 'text', partId: 'p', referenceId: 'g' },
        { kind: 'text', partId: 'p', referenceId: 'g' },
      ],
    })).toBe(false)
  })
})
