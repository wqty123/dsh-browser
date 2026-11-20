import { describe, expect, it } from 'vitest'
import {
  contentTypeOf,
  projectTableText,
  requiredAssetKeys,
  sourceOf,
  toOrderedGroup,
} from '../production/snapshot-adapter.ts'
import {
  LONG_TEXT,
  TAIL_TEXT,
  TABLE,
  CELL_IMG_KEY,
  IMG1_KEY,
  IMG2_KEY,
  makeSnapshot,
} from './production.fixtures.ts'

describe('toOrderedGroup — verbatim content', () => {
  it('keeps long mixed text verbatim and preserves the captured part order (images not hoisted)', () => {
    const snapshot = makeSnapshot()
    const group = toOrderedGroup(snapshot)
    expect(group.referenceId).toBe('ref-mixed-1')
    expect(group.parts.map(part => part.kind)).toEqual(['text', 'image', 'table', 'image', 'text'])
    expect(group.parts[0]).toMatchObject({ kind: 'text', partId: 't-1', text: LONG_TEXT })
    expect(group.parts[4]).toMatchObject({ kind: 'text', partId: 't-2', text: TAIL_TEXT })
    // The two image parts stay in their captured slots, not at the front.
    expect(group.parts[1]).toMatchObject({ kind: 'image', partId: 'i-1', assetKey: IMG1_KEY })
    expect(group.parts[3]).toMatchObject({ kind: 'image', partId: 'i-2', assetKey: IMG2_KEY })
    // Every character of the long text is preserved (including emoji / markup / tabs).
    expect((group.parts[0] as { text: string }).text).toBe(LONG_TEXT)
    expect((group.parts[0] as { text: string }).text).toContain('🦊🦊')
    expect((group.parts[0] as { text: string }).text).toContain('<b>not html</b>')
    expect((group.parts[0] as { text: string }).text).toContain('\t TAB')
  })

  it('projects a table into text that keeps every cell verbatim with merge/role/completeness facts', () => {
    const text = projectTableText(TABLE, TABLE.caption)
    expect(text).toContain('[table 3x3 completeness=visible-rows norm=norm-2026-11]')
    expect(text).toContain(`caption: ${TABLE.caption}`)
    expect(text).toContain('姓名 / Name')
    expect(text).toContain('Q1 营收(千)')
    expect(text).toContain('爱丽丝 Alice')
    expect(text).toContain('1,234')
    expect(text).toContain('含图片的单元格')
    // Merge facts + role + partial/completeness are visible, not flattened away.
    expect(text).toContain('[0,1] (1r x 2c; header,header-context,full-text)')
    expect(text).toContain('[1,0] (2r x 1c; data,selection,full-text)')
    expect(text).toContain('[1,2] (1r x 1c; data,selection,partial-text)')
    expect(text).toContain(`images=[cell-img@${CELL_IMG_KEY}]`)
    const group = toOrderedGroup(makeSnapshot())
    expect((group.parts[2] as { text: string }).text).toBe(text)
  })

  it('collects ALL image asset keys, including inline images inside table cells', () => {
    const keys = requiredAssetKeys(makeSnapshot())
    expect(keys).toEqual([IMG1_KEY, CELL_IMG_KEY, IMG2_KEY])
    // stable + deduplicated
    expect(requiredAssetKeys(makeSnapshot())).toEqual([...new Set(keys)])
  })

  it('derives mixed content type and the source host/title from the frozen snapshot', () => {
    const snapshot = makeSnapshot()
    expect(contentTypeOf(snapshot)).toBe('mixed')
    const source = sourceOf(snapshot)
    expect(source.host).toBe('news.example.com')
    expect(source.title).toBe('季度财报与狐狸图鉴')
    expect(source.pageUrl).toBe('https://news.example.com/a/b?x=1#frag')
    expect(source.frameRoute).toBe('frame')
    expect(source.frameSelector).toBe('iframe#content')
    expect(requiredAssetKeys(snapshot)).toEqual([IMG1_KEY, CELL_IMG_KEY, IMG2_KEY])
  })

  it('contentTypeOf is single-kind for homogeneous captures', () => {
    const base = makeSnapshot()
    const textOnly: typeof base = { ...base, parts: [base.parts[0]!, base.parts[4]!] }
    expect(contentTypeOf(textOnly)).toBe('text')
    const imageOnly: typeof base = { ...base, parts: [base.parts[1]!, base.parts[3]!] }
    expect(contentTypeOf(imageOnly)).toBe('image')
  })
})
