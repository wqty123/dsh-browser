import { describe, expect, it } from 'vitest'
import { createProductionRuntime, type ApplyOutcome, type ProductionRuntime } from '../production/runtime.ts'
import type { HostInputFace } from '../production/draft-adapter.ts'
import type { CardImage, CardTable } from '../production/reference-card.ts'
import {
  ASSET_MAP,
  CELL_IMG_KEY,
  FakeReferenceHttp,
  IMG1_KEY,
  IMG2_KEY,
  LONG_TEXT,
  TAIL_TEXT,
  assetOf,
  deliveriesResponse,
  fakeHostInput,
  makeDelivery,
  memoryKV,
} from './production.fixtures.ts'

function assetResponses(): Readonly<Record<string, ReturnType<typeof assetOf>>> {
  return Object.fromEntries(Object.entries(ASSET_MAP).map(([key, bytes]) => [key, assetOf(key, bytes)]))
}

interface Harness {
  http: FakeReferenceHttp
  runtime: ProductionRuntime
  hosts: Record<string, ReturnType<typeof fakeHostInput>>
  kv: ReturnType<typeof memoryKV>
}

function harness(options: { sessionId?: string; admitReceipt?: boolean; persistThrows?: boolean } = {}): Harness {
  const kv = memoryKV()
  const http = new FakeReferenceHttp()
  http.assets = assetResponses()
  const hosts: Record<string, ReturnType<typeof fakeHostInput>> = {
    'sess-A': fakeHostInput('帮我总结这段网页内容', 7),
    'sess-B': fakeHostInput('另一个会话的问题', 3),
  }
  if (options.persistThrows === true) {
    const original = hosts['sess-A']!
    hosts['sess-A'] = Object.assign(Object.create(Object.getPrototypeOf(original)), original, {
      persistDraft: () => { throw new Error('host draft save failed') },
    }) as ReturnType<typeof fakeHostInput>
  }
  const hostInputFor: (sessionId: string) => HostInputFace = sessionId => hosts[sessionId] ?? fakeHostInput()
  const runtime = createProductionRuntime({
    http,
    storage: kv,
    initialSessionId: options.sessionId ?? 'sess-A',
    hostInputFor,
    ...(options.admitReceipt === true
      ? { admitAsset: async (asset: ReturnType<typeof assetOf>) => ({ receiptId: `receipt-${asset.key.slice(0, 8)}` }) }
      : {}),
    now: () => 1700000000000,
  })
  return { http, runtime, hosts, kv }
}

function firstOutcome(report: { outcomes: readonly { intentId: string; outcome: ApplyOutcome }[] } | undefined): ApplyOutcome | undefined {
  return report?.outcomes[0]?.outcome
}

describe('createProductionRuntime — prepared delivery full apply (content-level)', () => {
  it('binds every asset, appends the ordered group, then ACKs with a saved draftRev and all hashes', async () => {
    const { http, runtime, hosts } = harness()
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 1 })], 1))
    const report = await runtime.pollOnce()

    expect(firstOutcome(report)?.kind).toBe('acknowledged')
    const outcome = firstOutcome(report)!
    if (outcome.kind === 'acknowledged') {
      expect(outcome.draftRev).toBeGreaterThanOrEqual(1)
      expect(outcome.assetKeys).toEqual([IMG1_KEY, CELL_IMG_KEY, IMG2_KEY])
      expect(outcome.phases).toEqual(['draft-applied', 'acknowledged'])
    }
    // Real image bytes fetched from the asset endpoint, including table inline images.
    expect(http.assetCalls).toEqual([IMG1_KEY, CELL_IMG_KEY, IMG2_KEY])
    // Two-phase ACK with the exact asset set.
    expect(http.ackCalls).toHaveLength(2)
    expect(http.ackCalls[0]).toMatchObject({ phase: 'draft-applied', intentId: 'ref-mixed-1' })
    expect(http.ackCalls[0]!.assetKeys).toEqual([IMG1_KEY, CELL_IMG_KEY, IMG2_KEY])
    expect(http.ackCalls[1]).toMatchObject({ phase: 'acknowledged' })

    // The draft keeps every fragment verbatim.
    const state = runtime.draftState('sess-A')
    expect(state.groups).toHaveLength(1)
    expect(state.groups[0]!.parts.map(part => part.kind)).toEqual(['text', 'image', 'table', 'image', 'text'])
    expect((state.groups[0]!.parts[0] as { text: string }).text).toBe(LONG_TEXT)
    expect((state.groups[0]!.parts[4] as { text: string }).text).toBe(TAIL_TEXT)
    expect(state.reflections[0]!.snapshot.parts).toHaveLength(5)
    expect(state.reflections[0]!.deliveryState).toBe('acknowledged')

    // User's typed question and caret are preserved; nothing auto-submitted.
    expect(hosts['sess-A']!.text).toBe('帮我总结这段网页内容')
    const calls = hosts['sess-A']!.calls
    expect(calls).toContain('persistDraft')
    expect(calls).toContain('captureInsertion')
    expect(calls).not.toContain('insertText') // no setDraft/replaceText either
    expect(calls.some(call => call === 'submit')).toBe(false)

    // Card is content-complete with real image bytes and table cells.
    const card = runtime.cards()[0]!
    expect(card.state).toBe('acknowledged')
    expect(card.parts.map(part => part.kind)).toEqual(['text', 'image', 'table', 'image', 'text'])
    expect((card.parts[1] as { value: CardImage }).value.bound).toBe(true)
    expect((card.parts[1] as { value: CardImage }).value.thumbnailSrc).toContain('data:image/png;base64,')
    expect((card.parts[2] as { value: CardTable }).value.cells.map(cell => cell.text)).toContain('含图片的单元格')
    expect(runtime.assetStore('sess-A').bytesOf(IMG1_KEY)).toEqual(ASSET_MAP[IMG1_KEY]!)
  })

  it('routes admitted images through the host attachment service as durable receipts', async () => {
    const { http, runtime } = harness({ admitReceipt: true })
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared' })], 1))
    await runtime.pollOnce()
    const bindings = runtime.assetStore('sess-A').values()
    // Three required keys: two image parts + one inline table image.
    expect(bindings).toHaveLength(3)
    expect(bindings.every(binding => binding.receiptId !== undefined)).toBe(true)
    // Only the two ordered IMAGE PARTS become file blocks; the inline table
    // image is preserved inside the table text projection.
    const content = runtime.projectContent({ uploaded: [], text: 'Q' })
    expect(content.filter(part => part.type === 'file')).toHaveLength(2)
  })
})

describe('ACK gating — only after draft AND all image assets are durably saved', () => {
  it('does NOT ACK when a required asset is missing, and does not append the group', async () => {
    const { http, runtime } = harness()
    http.assetShouldFail.add(IMG1_KEY)
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared' })], 1))
    const report = await runtime.pollOnce()
    expect(firstOutcome(report)).toMatchObject({ kind: 'waiting-assets', missing: [IMG1_KEY] })
    expect(http.ackCalls).toHaveLength(0)
    expect(runtime.draftState('sess-A').groups).toHaveLength(0)
    expect(runtime.cards()).toHaveLength(0)
  })

  it('does NOT ACK when the draft persist fails', async () => {
    const { http, runtime } = harness({ persistThrows: true })
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared' })], 1))
    const report = await runtime.pollOnce()
    expect(firstOutcome(report)).toMatchObject({ kind: 'save-failed', reason: 'persist failed' })
    expect(http.ackCalls).toHaveLength(0)
  })

  it('a 409 ACK failure returns ack-pending; a later poll converges to acknowledged', async () => {
    const { http, runtime } = harness()
    http.ackShouldFail = true
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 2 })], 2))
    const first = await runtime.pollOnce()
    expect(firstOutcome(first)).toMatchObject({ kind: 'ack-pending' })
    expect(http.ackCalls.some(call => call.phase === 'acknowledged')).toBe(false)

    http.ackShouldFail = false
    // Server still reports 'prepared' because the ACK never landed.
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 2 })], 2))
    const second = await runtime.pollOnce()
    expect(firstOutcome(second)?.kind).toBe('acknowledged')
    expect(http.ackCalls.at(-1)).toMatchObject({ phase: 'acknowledged' })
  })

  it('draft-applied deliveries skip the draft-applied phase and go straight to acknowledged', async () => {
    const { http, runtime } = harness()
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'draft-applied' })], 1))
    await runtime.pollOnce()
    expect(http.ackCalls.map(call => call.phase)).toEqual(['acknowledged'])
  })
})

describe('session isolation + incremental cursor', () => {
  it('skips deliveries whose sessionId differs from the current session', async () => {
    const { http, runtime } = harness({ sessionId: 'sess-A' })
    http.enqueue(deliveriesResponse([
      makeDelivery({ sessionId: 'sess-B', intentId: 'ref-B', referenceId: 'ref-B', state: 'prepared' }),
      makeDelivery({ sessionId: 'sess-A', state: 'prepared' }),
    ], 2))
    const report = await runtime.pollOnce()
    expect(report!.outcomes[0]!.outcome).toMatchObject({ kind: 'skipped', reason: 'wrong-session' })
    expect(report!.outcomes[1]!.outcome).toMatchObject({ kind: 'acknowledged' })
    expect(runtime.draftState('sess-A').groups).toHaveLength(1)
    expect(runtime.draftState('sess-B').groups).toHaveLength(0)
  })

  it('setSession switches to a separate store/cursor (no cross-session leakage)', async () => {
    const { http, runtime } = harness({ sessionId: 'sess-A' })
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 5 })], 5))
    await runtime.pollOnce()
    expect(runtime.draftState('sess-A').groups).toHaveLength(1)

    runtime.setSession('sess-B')
    expect(runtime.currentSessionId()).toBe('sess-B')
    expect(runtime.cards()).toHaveLength(0) // sess-B has no cards yet
    http.enqueue(deliveriesResponse([
      makeDelivery({ sessionId: 'sess-B', intentId: 'ref-B2', referenceId: 'ref-B2', state: 'prepared', sequence: 9 }),
    ], 9))
    const report = await runtime.pollOnce()
    expect(firstOutcome(report)?.kind).toBe('acknowledged')
    expect(runtime.draftState('sess-B').groups).toHaveLength(1)
    expect(runtime.draftState('sess-A').groups).toHaveLength(1) // unchanged
    expect(runtime.draftState('sess-A').since).toBe(5)
    expect(runtime.draftState('sess-B').since).toBe(9)
  })

  it('uses the persisted per-session since cursor on the next poll (incremental)', async () => {
    const { http, runtime } = harness()
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 12 })], 12))
    await runtime.pollOnce()
    http.enqueue(deliveriesResponse([], 12))
    await runtime.pollOnce()
    expect(http.deliveryCalls[0]).toEqual({ sessionId: 'sess-A', since: 0 })
    expect(http.deliveryCalls[1]).toEqual({ sessionId: 'sess-A', since: 12 })
  })
})

describe('tombstone — a removed reference is not re-inserted by a late retry', () => {
  it('removeCard writes a durable tombstone; a late prepared retry is skipped', async () => {
    const { http, runtime } = harness()
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 3 })], 3))
    await runtime.pollOnce()
    expect(runtime.cards()).toHaveLength(1)

    await runtime.removeCard('ref-mixed-1')
    expect(http.removeCalls).toEqual(['ref-mixed-1'])
    expect(runtime.cards()).toHaveLength(0)
    expect(runtime.draftState('sess-A').tombstones).toContain('ref-mixed-1')

    // A late retry with a HIGHER sequence arrives after removal.
    http.enqueue(deliveriesResponse([
      makeDelivery({ state: 'prepared', sequence: 99, intentId: 'ref-mixed-1', referenceId: 'ref-mixed-1' }),
    ], 99))
    const report = await runtime.pollOnce()
    expect(firstOutcome(report)).toMatchObject({ kind: 'skipped' })
    expect(runtime.cards()).toHaveLength(0)
    expect(runtime.draftState('sess-A').groups).toHaveLength(0)
    expect(http.ackCalls.filter(call => call.phase === 'acknowledged')).toHaveLength(1) // only the first apply
  })

  it('the tombstone survives a restart with the same persisted storage', async () => {
    const kv = memoryKV()
    const http1 = new FakeReferenceHttp(); http1.assets = assetResponses()
    const r1 = createProductionRuntime({ http: http1, storage: kv, initialSessionId: 'sess-A', hostInputFor: () => fakeHostInput(), now: () => 1 })
    http1.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared' })], 1))
    await r1.pollOnce()
    await r1.removeCard('ref-mixed-1')
    r1.dispose()

    const http2 = new FakeReferenceHttp(); http2.assets = assetResponses()
    const r2 = createProductionRuntime({ http: http2, storage: kv, initialSessionId: 'sess-A', hostInputFor: () => fakeHostInput(), now: () => 2 })
    http2.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 100 })], 100))
    const report = await r2.pollOnce()
    expect(firstOutcome(report)).toMatchObject({ kind: 'skipped' })
    expect(r2.cards()).toHaveLength(0)
  })
})

describe('removal — final, in one step', () => {
  it('takes the reference out of the very next message and tombstones it immediately', async () => {
    const { http, runtime } = harness()
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 3 })], 3))
    await runtime.pollOnce()
    expect(runtime.cards()).toHaveLength(1)
    const before = runtime.projectContent({ uploaded: [], text: '问题' })
    expect(before.length).toBeGreaterThan(1)

    await runtime.removeCard('ref-mixed-1')
    // Gone from the rail AND from the send, with the plugin told right away:
    // there is no window in which the card is hidden but still revivable.
    expect(runtime.cards()).toHaveLength(0)
    expect(runtime.projectContent({ uploaded: [], text: '问题' })).toHaveLength(1)
    expect(http.removeCalls).toEqual(['ref-mixed-1'])
    expect(runtime.draftState('sess-A').tombstones).toContain('ref-mixed-1')
    expect('removal' in runtime.snapshot()).toBe(false)
  })
})

describe('recovery — full references + asset bindings restored from frozen snapshot', () => {
  it('an acknowledged delivery rebuilds a card from its snapshot when the local store is empty', async () => {
    const { http, runtime } = harness()
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'acknowledged' })], 1))
    const report = await runtime.pollOnce()
    expect(firstOutcome(report)).toMatchObject({ kind: 'recovered', from: 'snapshot' })
    expect(http.ackCalls).toHaveLength(0) // acknowledged deliveries only render
    const card = runtime.cards()[0]!
    expect(card.state).toBe('acknowledged')
    expect(card.excerpt).toBe(LONG_TEXT)
    expect((card.parts[2] as { value: CardTable }).value.cells.map(cell => cell.text)).toContain('爱丽丝 Alice')
    expect((card.parts[1] as { value: CardImage }).value.bound).toBe(true)
    expect(runtime.assetStore('sess-A').bytesOf(IMG2_KEY)).toEqual(ASSET_MAP[IMG2_KEY]!)
    // Rebuild also places the group in the draft for the ordered send path.
    expect(runtime.draftState('sess-A').groups).toHaveLength(1)
  })

  it('a restart with persisted state renders the full card and asset bytes without re-ACK', async () => {
    const kv = memoryKV()
    const http1 = new FakeReferenceHttp(); http1.assets = assetResponses()
    const r1 = createProductionRuntime({ http: http1, storage: kv, initialSessionId: 'sess-A', hostInputFor: () => fakeHostInput('保留的问题'), now: () => 1 })
    http1.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared' })], 1))
    await r1.pollOnce()
    r1.dispose()

    const http2 = new FakeReferenceHttp(); http2.assets = assetResponses()
    const r2 = createProductionRuntime({ http: http2, storage: kv, initialSessionId: 'sess-A', hostInputFor: () => fakeHostInput('保留的问题'), now: () => 2 })
    http2.enqueue(deliveriesResponse([makeDelivery({ state: 'acknowledged', sequence: 1 })], 1))
    const report = await r2.pollOnce()
    expect(firstOutcome(report)).toMatchObject({ kind: 'rendered' })
    expect(http2.ackCalls).toHaveLength(0)
    expect(r2.cards()).toHaveLength(1)
    expect(r2.cards()[0]!.excerpt).toBe(LONG_TEXT)
    // Asset bindings are restored verbatim (no refetch needed for bound keys).
    expect(r2.assetStore('sess-A').bytesOf(IMG1_KEY)).toEqual(ASSET_MAP[IMG1_KEY]!)
    expect((r2.cards()[0]!.parts[2] as { value: CardTable }).value.completeness).toBe('visible-rows')
  })
})

describe('polling lifecycle', () => {
  it('dispose cancels polling and a later pollOnce returns undefined', async () => {
    const { http, runtime } = harness()
    http.enqueue(deliveriesResponse([], 0))
    await runtime.pollOnce()
    expect(runtime.disposed).toBe(false)
    runtime.dispose()
    expect(runtime.disposed).toBe(true)
    expect(runtime.poller.disposed).toBe(true)
    expect(await runtime.pollOnce()).toBeUndefined()
  })

  it('stop/start are idempotent and do not corrupt the cursor', () => {
    const { runtime } = harness()
    runtime.stop()
    runtime.start()
    runtime.start()
    runtime.stop()
    expect(runtime.draftState('sess-A').since).toBe(0)
  })
})

describe('revealReference — it goes to the source page', () => {
  async function withCard() {
    const { http, runtime } = harness()
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 1 })], 1))
    await runtime.pollOnce()
    return { http, runtime, card: runtime.cards()[0]! }
  }

  it('asks the plugin to navigate its page to the source, then locates the quote', async () => {
    const { http, runtime, card } = await withCard()
    http.revealOutcome = { ok: true, status: 'page-mismatch' }
    const seen: (boolean | undefined)[] = []
    const original = http.reveal.bind(http)
    http.reveal = async (referenceId, partId, navigate) => {
      seen.push(navigate)
      // The navigating call is the one that lands on the page.
      if (navigate === true) http.revealOutcome = { ok: true, status: 'revealed' }
      return await original(referenceId, partId, navigate)
    }
    await runtime.revealReference(card.referenceId)
    expect(seen).toEqual([false, true])
    // Success is silent: the person is looking at the source, not at a toast.
    expect(runtime.snapshot().reveal).toBeUndefined()
  })

  it('opens a sidebar page when there is none, then locates the quote', async () => {
    const { http, runtime, card } = await withCard()
    http.revealOutcome = { ok: true, status: 'session-unavailable' }
    const opened: string[] = []
    runtime.setSourceOpener(async (url) => {
      opened.push(url)
      // Stands for the page finishing its load: the next attempt locates it.
      http.revealOutcome = { ok: true, status: 'revealed' }
    })
    await runtime.revealReference(card.referenceId)
    expect(opened).toEqual([card.source.pageUrl])
    expect(http.revealCalls.length).toBeGreaterThanOrEqual(2)
    expect(runtime.snapshot().reveal).toBeUndefined()
  })

  it('keeps the specific reason when the host cannot open a page', async () => {
    const { http, runtime, card } = await withCard()
    http.revealOutcome = { ok: true, status: 'session-unavailable' }
    runtime.setSourceOpener(async () => { throw new Error('sidebar tab API is unavailable') })
    await runtime.revealReference(card.referenceId)
    expect(runtime.snapshot().reveal?.status).toBe('session-unavailable')
    expect(runtime.snapshot().reveal?.message).toContain('标签页')
  })
})
