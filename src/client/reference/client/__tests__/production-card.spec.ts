import { describe, expect, it } from 'vitest'
import { createAssetStore } from '../production/asset-store.ts'
import {
  buildCardViewModel,
  type CardImage,
  type CardTable,
} from '../production/reference-card.ts'
import { toOrderedGroup } from '../production/snapshot-adapter.ts'
import { reflectionFromDelivery } from '../production/draft-adapter.ts'
import {
  ASSET_MAP,
  CELL_IMG_KEY,
  IMG1_BYTES,
  IMG1_KEY,
  IMG2_KEY,
  LONG_TEXT,
  TAIL_TEXT,
  assetOf,
  makeDelivery,
  memoryKV,
} from './production.fixtures.ts'

function boundCard() {
  const assets = createAssetStore(memoryKV(), 'sess-A')
  for (const [key, bytes] of Object.entries(ASSET_MAP)) assets.bind(assetOf(key, bytes))
  const delivery = makeDelivery({
    failures: [{ kind: 'image', reason: '第 3 张图片超时' }, { kind: 'table', reason: '部分行不可见' }],
  })
  const reflection = reflectionFromDelivery(delivery, toOrderedGroup(delivery.snapshot), 1000)
  const card = buildCardViewModel(reflection, assets)
  return { assets, delivery, card }
}

describe('buildCardViewModel — content-complete dock card', () => {
  it('shows source host/title, a verbatim excerpt and the mixed content type', () => {
    const { card } = boundCard()
    expect(card.source.host).toBe('news.example.com')
    expect(card.source.title).toBe('季度财报与狐狸图鉴')
    expect(card.contentType).toBe('mixed')
    expect(card.excerpt).toBe(LONG_TEXT)
    expect(card.state).toBe('prepared')
  })

  it('emits parts in captured order: text, image, table, image, text (images NOT hoisted)', () => {
    const { card } = boundCard()
    expect(card.parts.map(part => part.kind)).toEqual(['text', 'image', 'table', 'image', 'text'])
    expect((card.parts[0] as { value: { text: string } }).value.text).toBe(LONG_TEXT)
    expect((card.parts[4] as { value: { text: string } }).value.text).toBe(TAIL_TEXT)
  })

  it('image thumbnails carry the REAL bytes (base64), sha256, mime and a data: URL — not a page URL/alt', () => {
    const { card } = boundCard()
    const img1 = (card.parts[1] as { value: CardImage }).value
    expect(img1.assetKey).toBe(IMG1_KEY)
    expect(img1.sha256).toBe(IMG1_KEY)
    expect(img1.mime).toBe('image/png')
    expect(img1.byteLength).toBe(IMG1_BYTES.length)
    expect(img1.bound).toBe(true)
    expect(img1.data).toBeTruthy()
    expect(img1.thumbnailSrc).toBe(`data:image/png;base64,${img1.data}`)
    expect(img1.thumbnailSrc).not.toContain('news.example.com')
    expect(img1.alt).toBe('A quick fox')
    const img2 = (card.parts[3] as { value: CardImage }).value
    expect(img2.assetKey).toBe(IMG2_KEY)
    expect(img2.bound).toBe(true)
  })

  it('table exposes headers, row/col counts, every cell verbatim with merges/role/completeness/partial flags', () => {
    const { card } = boundCard()
    const table = (card.parts[2] as { value: CardTable }).value
    expect(table.rowCount).toBe(3)
    expect(table.columnCount).toBe(3)
    expect(table.completeness).toBe('visible-rows')
    expect(table.normalizationVersion).toBe('norm-2026-11')
    expect(table.headers).toEqual(['姓名 / Name', 'Q1 营收(千)', 'Q2'])
    expect(table.selectedCell).toEqual({ row: 1, column: 2 })
    expect(table.cells.map(cell => cell.text)).toEqual([
      '姓名 / Name', 'Q1 营收(千)', '爱丽丝 Alice', '1,234', '含图片的单元格', '部分…',
    ])
    expect(table.cells[1]!.columnSpan).toBe(2)
    expect(table.cells[2]!.rowSpan).toBe(2)
    expect(table.cells[4]!.partialText).toBe(true)
    expect(table.cells[4]!.inlineImages).toEqual([{ partId: 'cell-img', assetKey: CELL_IMG_KEY, bound: true, thumbnailSrc: `data:image/png;base64,${assetOf(CELL_IMG_KEY, ASSET_MAP[CELL_IMG_KEY]!).data}` }])
    expect(table.cells[5]!.includedAs).toBe('header-context')
    // The model-facing text still contains every cell verbatim.
    expect(table.text).toContain('含图片的单元格')
    expect(table.text).toContain('completeness=visible-rows')
  })

  it('surfaces failure segments, a remove action and the import/export menu', () => {
    const { card } = boundCard()
    expect(card.failures).toEqual([
      { kind: 'image', reason: '第 3 张图片超时' },
      { kind: 'table', reason: '部分行不可见' },
    ])
    expect(card.removeAction).toEqual({ intentId: 'ref-mixed-1', referenceId: 'ref-mixed-1' })
    expect(card.menu.exportFormats).toEqual(['jsonl', 'markdown', 'zip', 'markdown-zip'])
    expect(card.menu.canImport).toBe(true)
    expect(card.menu.exportSessionId).toBe('sess-A')
  })

  it('an unbound asset is marked bound=false with an empty thumbnail (kept, not hidden)', () => {
    const assets = createAssetStore(memoryKV(), 'sess-A')
    const delivery = makeDelivery()
    const card = buildCardViewModel(reflectionFromDelivery(delivery, toOrderedGroup(delivery.snapshot), 1), assets)
    const img1 = (card.parts[1] as { value: CardImage }).value
    expect(img1.bound).toBe(false)
    expect(img1.thumbnailSrc).toBe('')
    expect(img1.data).toBe('')
    expect(img1.sha256).toBe(IMG1_KEY)
  })
})
