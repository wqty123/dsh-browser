/**
 * Draft-side behaviour of the three-state interaction:
 *
 *   1. the note lives on the DRAFT copy and survives a restart (the frozen
 *      snapshot is never rewritten);
 *   2. the note reaches the model immediately before its own reference and is
 *      labelled apart from the quote.
 *
 * The rail itself (one collapsed pill per reference, the hover card, the
 * remove/edit actions) is covered against the real React component in
 * `reference-dock-ui.client.spec.tsx`.
 */
import { describe, expect, it } from 'vitest'
import { createSessionDraftStore, reflectionFromDelivery } from '../production/draft-adapter.ts'
import { toOrderedGroup } from '../production/snapshot-adapter.ts'
import { COMMENT_LABEL, wireSubmissionContent } from '../production/production-submission.ts'
import {
  LONG_TEXT,
  TAIL_TEXT,
  makeDelivery,
  makeSnapshot,
  memoryKV,
} from './production.fixtures.ts'

describe('图三 — the draft keeps its own note', () => {
  it('persists an edited note across a restart without touching the snapshot', () => {
    const storage = memoryKV()
    const snapshot = { ...makeSnapshot('sess-A'), referenceId: 'ref-A' }
    const delivery = makeDelivery({
      referenceId: 'ref-A',
      intentId: 'intent-A',
      snapshot: { ...snapshot, comment: '原始评论' },
    })
    const store = createSessionDraftStore(storage, 'sess-A')
    store.append(reflectionFromDelivery(delivery, toOrderedGroup(delivery.snapshot), 1))
    expect(store.state().reflections[0]!.comment).toBe('原始评论')

    expect(store.setComment('ref-A', '改过的评论')).toBe(true)
    expect(store.setComment('missing', 'x')).toBe(false)

    const reopened = createSessionDraftStore(storage, 'sess-A')
    expect(reopened.state().reflections[0]!.comment).toBe('改过的评论')
    // The frozen page snapshot still holds the original capture, unchanged.
    expect(reopened.state().reflections[0]!.snapshot.parts).toEqual(delivery.snapshot.parts)

    // Emptying the note removes the block rather than keeping an empty one.
    expect(reopened.setComment('ref-A', '   ')).toBe(true)
    expect(reopened.state().reflections[0]!.comment).toBeUndefined()
  })
})

describe('§6 — the note reaches the model, labelled apart from the quote', () => {
  it('puts each note immediately before its own reference and leaves the rest in order', () => {
    const anchor = (value: string) => ({ exact: value, prefix: '', suffix: '' })
    const groups = [
      { referenceId: 'ref-1', parts: [{ referenceId: 'ref-1', partId: 'p1', kind: 'text' as const, text: LONG_TEXT, anchor: anchor(LONG_TEXT) }] },
      { referenceId: 'ref-2', parts: [{ referenceId: 'ref-2', partId: 'p2', kind: 'text' as const, text: TAIL_TEXT, anchor: anchor(TAIL_TEXT) }] },
    ]
    const content = wireSubmissionContent({
      uploaded: [],
      text: '这两个说法冲突吗？',
      groups,
      admitImage: () => undefined,
      comments: new Map([['ref-2', '只看第二段']]),
      sourceLinks: false,
    })
    const texts = content.map(part => (part.type === 'text' ? part.text : `<${part.type}>`))
    // Each block carries its own trailing newline: the host renders adjacent text
    // blocks as a single run, so without it the note, the quote and the question
    // arrive glued together (measured on the desktop before this was added).
    expect(texts).toEqual([
      `${LONG_TEXT}\n`,
      `${COMMENT_LABEL}：只看第二段\n`,
      `${TAIL_TEXT}\n`,
      '这两个说法冲突吗？',
    ])
    // The note is never merged into the quoted text.
    expect(texts[2]).toBe(`${TAIL_TEXT}\n`)
  })

  it('without any note the content is byte-identical to the pre-note projection', () => {
    const anchor = { exact: '正文', prefix: '', suffix: '' }
    const groups = [
      { referenceId: 'ref-1', parts: [{ referenceId: 'ref-1', partId: 'p1', kind: 'text' as const, text: '正文', anchor }] },
    ]
    const withEmptyMap = wireSubmissionContent({
      uploaded: [], text: '问题', groups, admitImage: () => undefined, comments: new Map(), sourceLinks: false,
    })
    const withoutMap = wireSubmissionContent({
      uploaded: [], text: '问题', groups, admitImage: () => undefined, sourceLinks: false,
    })
    expect(withEmptyMap).toEqual(withoutMap)
    // Every projected text block now ends with its own newline (B10); the
    // user's own question keeps its exact text (no newline added).
    expect(withEmptyMap.map(part => (part.type === 'text' ? part.text : ''))).toEqual(['正文\n', '问题'])
  })
})
