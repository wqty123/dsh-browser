import { describe, expect, it } from 'vitest'
import {
  createAdmitImage,
  createSubmissionSeam,
  wireSubmissionContent as wireSubmissionContentImpl,
  type HostPromptContentPart,
  type WireSubmissionInput,
} from '../production/production-submission.ts'
import { createAssetStore } from '../production/asset-store.ts'
import { toOrderedGroup } from '../production/snapshot-adapter.ts'
import { LONG_TEXT, TAIL_TEXT, IMG1_KEY, CELL_IMG_KEY, assetOf, ASSET_MAP, makeSnapshot, memoryKV } from './production.fixtures.ts'

/**
 * These assertions pin the PRE-marker projection (sourceLinks:false), which is
 * also the documented rollback lever. The new default (source links ON) is
 * covered in production-source-link.client.spec.ts.
 */
const wireLegacy = (input: Omit<WireSubmissionInput, 'sourceLinks'>): readonly HostPromptContentPart[] =>
  wireSubmissionContentImpl({ ...input, sourceLinks: false })

function boundAssets() {
  const assets = createAssetStore(memoryKV(), 'sess-A')
  for (const [key, bytes] of Object.entries(ASSET_MAP)) assets.bind(assetOf(key, bytes))
  return assets
}

const group = toOrderedGroup(makeSnapshot())
const uploaded: readonly HostPromptContentPart[] = [
  { type: 'file', receiptId: 'receipt-existing' },
]

describe('wireSubmissionContent — ordered, real blocks for Session.prompt', () => {
  it('is byte-identical to service.ts:302 when there are no groups (compatibility)', () => {
    const result = wireLegacy({ uploaded, text: '用户补充', groups: [], admitImage: () => undefined })
    expect(result).toEqual([
      { type: 'file', receiptId: 'receipt-existing' },
      { type: 'text', text: '用户补充' },
    ])
    expect(wireLegacy({ uploaded, text: '', groups: [], admitImage: () => undefined })).toEqual(uploaded)
  })

  it('places host attachments first and the plain composer text LAST (附件在前文字在后)', () => {
    const result = wireLegacy({ uploaded, text: '用户补充', groups: [group], admitImage: createAdmitImage(boundAssets()) })
    expect(result[0]).toEqual({ type: 'file', receiptId: 'receipt-existing' })
    expect(result.at(-1)).toEqual({ type: 'text', text: '用户补充' })
  })

  it('interleaves group parts in capture order (text, image, table, image, text)', () => {
    const result = wireLegacy({ uploaded: [], text: '', groups: [group], admitImage: createAdmitImage(boundAssets()) })
    expect(result.map(part => part.type)).toEqual(['text', 'text', 'image', 'text', 'image', 'text'])
    expect(result[1]).toEqual({ type: 'text', text: 'Image: A quick fox\nFigure 1\n' })
    // Projected text blocks now end with their own newline (B10).
    expect(result[0]).toEqual({ type: 'text', text: `${LONG_TEXT}\n` })
    expect(result[5]).toEqual({ type: 'text', text: `${TAIL_TEXT}\n` })
  })

  it('image blocks carry REAL base64 bytes + mediaType from the durable asset store (not URL/alt)', () => {
    const assets = boundAssets()
    const result = wireLegacy({ uploaded: [], text: '', groups: [group], admitImage: createAdmitImage(assets) })
    const image1 = result[2] as Extract<HostPromptContentPart, { type: 'image' }>
    expect(image1.type).toBe('image')
    expect(image1.mediaType).toBe('image/png')
    expect(image1.name).toBe('i-1')
    expect(image1.data).toBe(assets.get(IMG1_KEY)?.data)
    expect(image1.data).not.toContain('https://')
    expect((result[4] as Extract<HostPromptContentPart, { type: 'image' }>).name).toBe('i-2')
  })

  it('maps a table part to a text block that keeps every cell verbatim', () => {
    const result = wireLegacy({ uploaded: [], text: '', groups: [group], admitImage: createAdmitImage(boundAssets()) })
    const tableText = (result[3] as { type: 'text'; text: string }).text
    expect(tableText).toContain('姓名 / Name')
    expect(tableText).toContain('1,234')
    expect(tableText).toContain('含图片的单元格')
    expect(tableText).toContain('| --- |')
    expect(tableText).toContain('Q1 营收(千) | Q1 营收(千)')
    expect(tableText).toContain('爱丽丝 Alice')
    expect(tableText).not.toContain('<table>')
    expect(group.parts[2]?.table).toMatchObject({ completeness: 'visible-rows' })
    expect(group.parts[2]?.table?.cells).toContainEqual(expect.objectContaining({
      inlineContent: expect.arrayContaining([expect.objectContaining({ assetKey: CELL_IMG_KEY })]),
    }))
  })

  it('an uploaded image asset becomes a {type:file,receiptId} block (host admission)', () => {
    const assets = createAssetStore(memoryKV(), 'sess-A')
    // Bind IMG1 with a host receipt, inline bytes for the others.
    for (const [key, bytes] of Object.entries(ASSET_MAP)) {
      assets.bind(assetOf(key, bytes), key === IMG1_KEY ? 'receipt-img1' : undefined)
    }
    const result = wireLegacy({ uploaded: [], text: '', groups: [group], admitImage: createAdmitImage(assets) })
    expect(result[2]).toEqual({ type: 'file', receiptId: 'receipt-img1' })
    expect((result[4] as { type: string }).type).toBe('image')
  })

  it('an unbound image keeps its slot as a placeholder instead of being dropped (B20)', () => {
    const emptyAssets = createAssetStore(memoryKV(), 'sess-A')
    const result = wireLegacy({ uploaded: [], text: '', groups: [group], admitImage: createAdmitImage(emptyAssets) })
    expect(result[2]).toEqual({ type: 'text', text: '[image unavailable: i-1]\n' })
    expect(result[4]).toEqual({ type: 'text', text: '[image unavailable: i-2]\n' })
    expect(result).toHaveLength(6)
  })

  it('supports a leading text position through the reused projector', () => {
    const result = wireLegacy({ uploaded: [], text: '先说', groups: [group], admitImage: createAdmitImage(boundAssets()), textPosition: 'leading' })
    expect(result[0]).toEqual({ type: 'text', text: '先说' })
  })
})

describe('createSubmissionSeam — the service.ts:302 injection point', () => {
  it('binds a session id to its stored groups + assets', () => {
    const assets = boundAssets()
    const seam = createSubmissionSeam({
      groupsFor: sessionId => sessionId === 'sess-A' ? [group] : [],
      assetsFor: () => assets,
      sourceLinks: false,
    })
    const content = seam.buildContent({ sessionId: 'sess-A', uploaded, text: '问题' })
    expect(content.map(part => part.type)).toEqual(['file', 'text', 'text', 'image', 'text', 'image', 'text', 'text'])
    expect((content[1] as { text: string }).text).toBe(`${LONG_TEXT}\n`)
    expect(content.at(-1)).toEqual({ type: 'text', text: '问题' })
    // Another session has no groups -> pure compatibility shape.
    expect(seam.buildContent({ sessionId: 'sess-B', uploaded, text: '问题' })).toEqual([...uploaded, { type: 'text', text: '问题' }])
  })

  it('consumes only on commit, and only the set this send froze', () => {
    const submitted: { sessionId: string; ids: readonly string[] }[] = []
    const seam = createSubmissionSeam({
      groupsFor: () => [group],
      assetsFor: () => boundAssets(),
      submitted: (sessionId, ids) => { submitted.push({ sessionId, ids }) },
      sourceLinks: false,
    })
    seam.buildContent({ sessionId: 'sess-A', uploaded, text: '问题' })
    // Building content must not consume: a refused send keeps the draft.
    expect(submitted).toHaveLength(0)
    seam.rollback('sess-A')
    expect(submitted).toHaveLength(0)

    seam.buildContent({ sessionId: 'sess-A', uploaded, text: '问题' })
    seam.commit('sess-A')
    expect(submitted).toEqual([{ sessionId: 'sess-A', ids: [group.referenceId] }])
    // A second commit has nothing left to consume.
    seam.commit('sess-A')
    expect(submitted).toHaveLength(1)
  })
})
