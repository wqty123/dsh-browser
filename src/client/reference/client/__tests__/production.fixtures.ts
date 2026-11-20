/**
 * Shared, content-rich fixtures for the production access-layer specs.
 * Not a spec file itself (no `.spec.` suffix), so vitest does not collect it.
 */
import type {
  AssetResponse,
  BrowserReferencePart,
  DeliveriesResponse,
  DeliveryRecord,
  FrozenSnapshot,
  TableSnapshot,
} from '../production/protocol.ts'

import { requiredAssetKeys } from '../production/snapshot-adapter.ts'
import type { KeyValueStorage } from '../types.ts'
import type {
  AckRequest,
  AckResponse,
  ExportFormat,
  RemoveResponse,
  RevealResultWire,
} from '../production/protocol.ts'
import type { ReferenceHttpClient } from '../production/http-transport.ts'
import type { HostInputFace } from '../production/draft-adapter.ts'
import type { PollerScheduler } from '../production/delivery-client.ts'

/** 64-hex content hashes (asset keys), as the plugin produces. */
export const IMG1_KEY = 'a1'.repeat(32)
export const IMG2_KEY = 'b2'.repeat(32)
export const CELL_IMG_KEY = 'c3'.repeat(32)
export const EXTRA_KEY = 'd4'.repeat(32)

/** Real bytes behind IMG1_KEY (a tiny PNG-ish header + payload). */
export const IMG1_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 250, 255, 0, 42])
export const IMG2_BYTES = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1, 9, 8])
export const CELL_IMG_BYTES = new Uint8Array([71, 73, 70, 56, 57, 97, 3, 2, 1, 0, 127])

export const LONG_TEXT = [
  'The quick brown fox jumps over the lazy dog. ',
  '这是一段很长的中文摘录，包含全角标点、空白  、换行与 emoji 🦊🦊，',
  '以及需要逐字保留的字符：<b>not html</b> & "quotes" \\ backslash \t TAB.',
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.',
].join('\n').repeat(3)

export const TAIL_TEXT = '这是第二段文本，仍然需要逐字保留。结尾。'

export const TABLE: TableSnapshot = {
  rowCount: 3,
  columnCount: 3,
  completeness: 'visible-rows',
  normalizationVersion: 'norm-2026-11',
  caption: '季度销售表（部分选择）',
  cells: [
    { row: 0, column: 0, rowSpan: 1, columnSpan: 1, role: 'header', text: '姓名 / Name', includedAs: 'selection', partialText: false },
    { row: 0, column: 1, rowSpan: 1, columnSpan: 2, role: 'header', text: 'Q1 营收(千)', includedAs: 'header-context', partialText: false },
    { row: 1, column: 0, rowSpan: 2, columnSpan: 1, role: 'data', text: '爱丽丝 Alice', includedAs: 'selection', partialText: false },
    { row: 1, column: 1, rowSpan: 1, columnSpan: 1, role: 'data', text: '1,234', includedAs: 'selection', partialText: false },
    {
      row: 1, column: 2, rowSpan: 1, columnSpan: 1, role: 'data', text: '含图片的单元格',
      includedAs: 'selection', partialText: true,
      inlineContent: [
        { type: 'text', text: '含图片的单元格' },
        { type: 'image', partId: 'cell-img', assetKey: CELL_IMG_KEY },
      ],
    },
    { row: 2, column: 1, rowSpan: 1, columnSpan: 1, role: 'data', text: '部分…', includedAs: 'header-context', partialText: true },
  ],
}

export function mixedParts(): readonly BrowserReferencePart[] {
  return [
    { partId: 't-1', type: 'text', text: LONG_TEXT, anchor: { exact: LONG_TEXT.slice(0, 40), prefix: '前文…', suffix: '…后文' } },
    {
      partId: 'i-1', type: 'image', assetKey: IMG1_KEY, representation: 'source-image',
      alt: 'A quick fox', caption: 'Figure 1', anchor: { src: 'https://example.test/fox.png', versionStatus: 'verified' },
    },
    {
      partId: 'tb-1', type: 'table', table: TABLE,
      anchor: { headers: ['姓名 / Name', 'Q1 营收(千)', 'Q2'], firstCells: ['爱丽丝 Alice', '1,234'], cell: { row: 1, column: 2 }, selector: '#sales' },
    },
    {
      partId: 'i-2', type: 'image', assetKey: IMG2_KEY, representation: 'visible-snapshot',
      anchor: { geometry: { x: 10, y: 20, w: 300, h: 200 } },
    },
    { partId: 't-2', type: 'text', text: TAIL_TEXT, anchor: { exact: TAIL_TEXT, prefix: '', suffix: '' } },
  ]
}

export function makeSnapshot(sessionId = 'sess-A'): FrozenSnapshot {
  return {
    version: 1,
    provider: 'dsh-browser',
    referenceId: 'ref-mixed-1',
    owner: { sessionId, browserSessionId: 'browser-sess-77' },
    provenance: { origin: 'user-selection', entry: 'page-overlay' },
    source: {
      pageUrl: 'https://news.example.com/a/b?x=1#frag',
      title: '季度财报与狐狸图鉴',
      capturedAt: '2026-11-08T01:02:03.000Z',
      frameUrl: 'https://news.example.com/frame',
      frameRoute: 'frame',
      frameSelector: 'iframe#content',
      carrier: 'bundled',
    },
    parts: mixedParts(),
    manifestHash: 'e5'.repeat(32),
  }
}

export function assetOf(key: string, bytes: Uint8Array, mime = 'image/png'): AssetResponse {
  return {
    ok: true,
    key,
    mime,
    bytes: bytes.length,
    sha256: key,
    data: Buffer.from(bytes).toString('base64'),
  }
}

export const ASSET_MAP: Readonly<Record<string, Uint8Array>> = {
  [IMG1_KEY]: IMG1_BYTES,
  [IMG2_KEY]: IMG2_BYTES,
  [CELL_IMG_KEY]: CELL_IMG_BYTES,
}

export interface DeliveryOverrides {
  readonly intentId?: string
  readonly sessionId?: string
  readonly referenceId?: string
  readonly state?: DeliveryRecord['state']
  readonly sequence?: number
  readonly snapshot?: FrozenSnapshot
  readonly requiredAssets?: readonly string[]
  readonly failures?: readonly DeliveryRecord['failures'][number][]
}

export function makeDelivery(overrides: DeliveryOverrides = {}): DeliveryRecord {
  const snapshot = overrides.snapshot ?? makeSnapshot(overrides.sessionId ?? 'sess-A')
  return {
    intentId: overrides.intentId ?? snapshot.referenceId,
    sessionId: overrides.sessionId ?? snapshot.owner.sessionId ?? 'sess-A',
    browserSessionId: snapshot.owner.browserSessionId ?? '',
    referenceId: overrides.referenceId ?? snapshot.referenceId,
    state: overrides.state ?? 'prepared',
    failures: overrides.failures ?? [],
    assetKeys: [],
    requiredAssets: overrides.requiredAssets ?? requiredAssetKeys(snapshot),
    createdAt: '2026-11-08T01:02:03.000Z',
    updatedAt: '2026-11-08T01:02:03.000Z',
    sequence: overrides.sequence ?? 1,
    snapshot,
  }
}

export function deliveriesResponse(
  deliveries: readonly DeliveryRecord[],
  sequence = deliveries.reduce((max, d) => Math.max(max, d.sequence), 0),
): DeliveriesResponse {
  return { ok: true, sequence, deliveries }
}

/** In-memory KeyValueStorage with helpers to inspect persisted keys. */
export function memoryKV(): KeyValueStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>()
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: key => { map.delete(key) },
    dump: () => Object.fromEntries(map),
  }
}

/** A host input face whose text/caret we can inspect and mutate. */
export interface FakeHostInput extends HostInputFace {
  readonly calls: readonly string[]
  setText(text: string): void
  setRev(rev: number): void
  readonly text: string
}

export function fakeHostInput(initialText = '帮我总结这段网页内容', rev = 7): FakeHostInput {
  let text = initialText
  let currentRev = rev
  const calls: string[] = []
  return {
    captureInsertion() { calls.push('captureInsertion'); return { start: text.length, end: text.length, draftRev: currentRev } },
    insertText(span, inserted) {
      calls.push('insertText')
      if (span.draftRev !== currentRev) return false
      text = text.slice(0, span.start) + inserted + text.slice(span.end)
      return true
    },
    persistDraft() { calls.push('persistDraft') },
    readText() { calls.push('readText'); return text },
    setText(next) { text = next },
    setRev(next) { currentRev = next },
    get calls() { return calls },
    get text() { return text },
  }
}

/** Deterministic scheduler: never fires automatically; tests drive manually. */
export function manualScheduler(): PollerScheduler & { tick(): void; readonly scheduled: number } {
  const callbacks: (() => void)[] = []
  let interval = 0
  return {
    setInterval(callback, ms) { callbacks.push(callback); interval = ms; return callbacks.length },
    clearInterval() { /* keep callbacks for manual ticks in tests */ },
    tick() { for (const cb of [...callbacks]) cb() },
    get scheduled() { return interval },
  }
}

/** A fully controllable fake ReferenceHttpClient that records every call. */
export class FakeReferenceHttp implements ReferenceHttpClient {
  deliveriesQueue: DeliveriesResponse[] = []
  readonly deliveryCalls: { sessionId: string; since: number }[] = []
  readonly assetCalls: string[] = []
  readonly ackCalls: AckRequest[] = []
  readonly removeCalls: string[] = []
  readonly revealCalls: { referenceId: string; partId?: string; sourcePageId?: string }[] = []
  readonly exportCalls: { format: ExportFormat; sessionId: string }[] = []
  readonly importCalls: Uint8Array[] = []
  assets: Readonly<Record<string, AssetResponse>> = {}
  ackShouldFail = false
  assetShouldFail = new Set<string>()
  revealOutcome: RevealResultWire = { ok: true, status: 'revealed', tabId: 'tab-9', frameId: 'frame-3' }

  enqueue(response: DeliveriesResponse): void { this.deliveriesQueue.push(response) }

  async deliveries(sessionId: string, since: number): Promise<DeliveriesResponse> {
    this.deliveryCalls.push({ sessionId, since })
    return this.deliveriesQueue.shift() ?? { ok: true, sequence: since, deliveries: [] }
  }
  async assetBase64(key: string): Promise<AssetResponse> {
    this.assetCalls.push(key)
    if (this.assetShouldFail.has(key)) throw new Error(`asset ${key} temporarily unavailable`)
    const asset = this.assets[key]
    if (asset === undefined) throw new Error(`no asset ${key}`)
    return asset
  }
  async assetBytes(key: string): Promise<Uint8Array> {
    const asset = await this.assetBase64(key)
    return decode(asset.data)
  }
  async ack(request: AckRequest): Promise<AckResponse> {
    this.ackCalls.push(request)
    if (this.ackShouldFail) throw new Error('ack rejected (409)')
    return { ok: true, intentId: request.intentId, state: request.phase ?? 'acknowledged', draftRev: request.draftRev, assetKeys: [...request.assetKeys] }
  }
  async remove(intentId: string): Promise<RemoveResponse> {
    this.removeCalls.push(intentId)
    return { ok: true, intentId, state: 'removed' }
  }
  async reveal(referenceId: string, partId?: string, navigate?: boolean, sourcePageId?: string): Promise<RevealResultWire> {
    this.revealCalls.push({
      ...(partId === undefined ? {} : { partId }),
      referenceId,
      ...(sourcePageId === undefined ? {} : { sourcePageId }),
      ...(navigate === true ? { navigate: true } : {}),
    } as { referenceId: string; partId?: string; navigate?: boolean })
    return this.revealOutcome
  }
  async exportBundle(format: ExportFormat, sessionId: string): Promise<Uint8Array> {
    this.exportCalls.push({ format, sessionId })
    return new Uint8Array([80, 75, 3, 4])
  }
  async importBundle(zip: Uint8Array): Promise<unknown> {
    this.importCalls.push(zip)
    return { ok: true, imported: 1 }
  }
}

// Local decode to avoid importing the production codec into the fake HTTP stub.
function decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = input.replace(/=+$/u, '')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    const value = alphabet.indexOf(char)
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 0xff); buffer &= (1 << bits) - 1 }
  }
  return new Uint8Array(bytes)
}
