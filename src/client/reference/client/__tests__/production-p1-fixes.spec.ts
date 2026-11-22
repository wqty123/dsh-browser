/**
 * Isolated regression specs for the two P1 acceptance findings.
 *
 * Both use controllable substitutes only: a quota-toggleable KeyValueStorage
 * and the in-memory FakeReferenceHttp (no real localStorage, no network).
 */
import { describe, expect, it } from 'vitest'
import { createProductionRuntime } from '../production/runtime.ts'
import type { HostInputFace } from '../production/draft-adapter.ts'
import type { KeyValueStorage } from '../types.ts'
import {
  ASSET_MAP,
  FakeReferenceHttp,
  assetOf,
  deliveriesResponse,
  fakeHostInput,
  makeDelivery,
} from './production.fixtures.ts'

/** Storage that can be told to reject every write, simulating a full quota. */
class QuotaKV implements KeyValueStorage {
  private readonly map = new Map<string, string>()
  blocked = false

  getItem(key: string): string | null { return this.map.get(key) ?? null }
  setItem(key: string, value: string): void {
    if (this.blocked) {
      const error = new Error('QuotaExceededError: localStorage is full')
      error.name = 'QuotaExceededError'
      throw error
    }
    this.map.set(key, value)
  }
  removeItem(key: string): void { this.map.delete(key) }
}

function assetResponses(): Readonly<Record<string, ReturnType<typeof assetOf>>> {
  return Object.fromEntries(Object.entries(ASSET_MAP).map(([key, bytes]) => [key, assetOf(key, bytes)]))
}

function makeRuntime(kv: KeyValueStorage) {
  const http = new FakeReferenceHttp()
  http.assets = assetResponses()
  const host = fakeHostInput('帮我总结这段网页内容', 7)
  const hostInputFor: (sessionId: string) => HostInputFace = () => host
  const runtime = createProductionRuntime({
    http,
    storage: kv,
    initialSessionId: 'sess-A',
    hostInputFor,
    now: () => 1700000000000,
  })
  return { http, runtime }
}

describe('P1 / problem 1 — an accepted send survives a localStorage archive failure', () => {
  it('sends ordinary chat offline and binds only the projected cards to the Host request', async () => {
    const { runtime, http } = makeRuntime(new QuotaKV())
    const bound: unknown[][] = []
    Object.assign(http, {
      consume: async () => {},
      bindSubmission: async (...args: unknown[]) => { bound.push(args) },
    })
    await runtime.submission.prepare?.('sess-A')
    expect(http.deliveryCalls).toHaveLength(0)
    expect(runtime.submission.buildContent({ sessionId: 'sess-A', uploaded: [], text: '普通消息', requestId: 'empty' })).toEqual([{ type: 'text', text: '普通消息' }])
    await runtime.submission.bind?.('sess-A', 'empty', 'rpc-empty')
    expect(bound).toHaveLength(0)
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'acknowledged', sequence: 1 })], 1))
    await runtime.pollOnce()
    http.enqueue({ ...deliveriesResponse([], 1), tracksSubmissions: true })
    await runtime.submission.prepare?.('sess-A')
    runtime.submission.buildContent({ sessionId: 'sess-A', uploaded: [], text: '已选内容', requestId: 'token' })
    await runtime.submission.bind?.('sess-A', 'token', 'rpc-A')
    expect(bound).toEqual([['sess-A', 'rpc-A', ['ref-mixed-1']]])
    runtime.dispose()
  })
  it('retires references atomically, keeps the commit non-throwing, and completes the archive idempotently on retry', async () => {
    const kv = new QuotaKV()
    const { http, runtime } = makeRuntime(kv)

    // The draft fits: a prepared delivery is fully applied (group + card + assets).
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 1 })], 1))
    const first = await runtime.pollOnce()
    expect(first?.outcomes[0]?.outcome.kind).toBe('acknowledged')
    expect(runtime.draftState('sess-A').groups).toHaveLength(1)
    expect(runtime.cards()).toHaveLength(1)

    // Freeze exactly the references this send carries (a pure read).
    const requestId = 'req-quota-1'
    runtime.submission.buildContent({ sessionId: 'sess-A', uploaded: [], text: '请总结', requestId })

    // Quota becomes full at commit time: copying the full FrozenSnapshot into
    // `sent` is exactly what used to throw and reverse the accepted send.
    kv.blocked = true
    expect(() => runtime.submission.commit('sess-A', requestId)).not.toThrow()

    // Phase 1 still cleared the draft: no card, no group, nothing to re-attach.
    expect(runtime.draftState('sess-A').groups).toHaveLength(0)
    expect(runtime.draftState('sess-A').reflections).toHaveLength(0)
    expect(runtime.cards()).toHaveLength(0)
    const nextContent = runtime.submission.buildContent({
      sessionId: 'sess-A', uploaded: [], text: '下一条', requestId: 'req-next',
    })
    // The NEXT message carries only its own text, never the previous reference.
    expect(nextContent).toEqual([{ type: 'text', text: '下一条' }])

    // Phase 2 is pending (not lost), the tombstone is set, and the sent
    // message's source link still resolves from the pending archive (item 7).
    const state = runtime.draftState('sess-A')
    expect(state.pendingArchive.map(reflection => reflection.referenceId)).toEqual(['ref-mixed-1'])
    expect(state.sent).toHaveLength(0)
    expect(state.tombstones.filter(id => id === 'ref-mixed-1')).toHaveLength(1)
    expect(runtime.ownerFor('ref-mixed-1')).toMatchObject({ label: '季度财报与狐狸图鉴' })

    // The host's idempotent retry hook exists and is a safe no-op while the
    // quota is still full (it never re-sends, never re-ACKs).
    const retryable = runtime.submission as typeof runtime.submission & {
      retrySubmitted?: (sessionId: string, requestId?: string) => void
    }
    expect(typeof retryable.retrySubmitted).toBe('function')
    expect(() => retryable.retrySubmitted?.('sess-A', requestId)).not.toThrow()
    expect(runtime.draftState('sess-A').sent).toHaveLength(0)
    expect(runtime.draftState('sess-A').pendingArchive).toHaveLength(1)

    // Quota recovers: a normal poll completes the durable archive.
    kv.blocked = false
    await runtime.pollOnce()
    expect(runtime.draftState('sess-A').sent.map(reflection => reflection.referenceId)).toEqual(['ref-mixed-1'])
    expect(runtime.draftState('sess-A').pendingArchive).toHaveLength(0)
    // Once durably archived, the source link resolves from `sent` (item 7).
    expect(runtime.ownerFor('ref-mixed-1')).toMatchObject({ label: '季度财报与狐狸图鉴' })

    // Repeated retries / a stale commit / further polls never duplicate the
    // archive or the tombstone.
    retryable.retrySubmitted?.('sess-A', requestId)
    runtime.submission.commit('sess-A', requestId) // token already consumed -> no-op
    await runtime.pollOnce()
    const settled = runtime.draftState('sess-A')
    expect(settled.sent.filter(reflection => reflection.referenceId === 'ref-mixed-1')).toHaveLength(1)
    expect(settled.tombstones.filter(id => id === 'ref-mixed-1')).toHaveLength(1)
    expect(runtime.cards()).toHaveLength(0)
  })
})

describe('P1 / problem 2 — an acknowledged delivery re-fetches temporarily missing assets', () => {
  it('keeps retrying an acknowledged recovery until the host draft has been durably saved', async () => {
    const kv = new QuotaKV()
    const http = new FakeReferenceHttp()
    http.assets = assetResponses()
    const host = fakeHostInput('保留用户的问题', 7)
    let canSave = false
    const persistDraft = host.persistDraft
    host.persistDraft = () => {
      if (!canSave) throw new Error('host draft is temporarily unavailable')
      persistDraft()
    }
    const runtime = createProductionRuntime({
      http, storage: kv, initialSessionId: 'sess-A', hostInputFor: () => host,
    })
    try {
      const delivery = makeDelivery({ state: 'acknowledged', sequence: 5 })
      for (let attempt = 0; attempt < 2; attempt++) {
        http.enqueue(deliveriesResponse([delivery], 5))
        const report = await runtime.pollOnce()
        expect(report?.outcomes[0]?.outcome.kind).toBe('save-failed')
        expect(runtime.draftState('sess-A').since).toBeLessThan(5)
        expect(http.ackCalls).toHaveLength(0)
      }
      canSave = true
      http.enqueue(deliveriesResponse([delivery], 5))
      const recovered = await runtime.pollOnce()
      expect(recovered?.outcomes[0]?.outcome.kind).toBe('rendered')
      expect(runtime.draftState('sess-A').since).toBe(5)
      expect(runtime.cards()).toHaveLength(1)
      // 新契约：确认过的投递首次落地时插入一行来源标记（用户原文保持在前），
      // 且同一引用只会插一次（store.hasInserted 记账），不会随轮询重复叠加。
      expect(host.text.startsWith('保留用户的问题')).toBe(true)
      expect(host.text.match(/<dsh-browser-reference /g) ?? []).toHaveLength(1)
      expect(http.ackCalls).toHaveLength(0)
    } finally {
      runtime.dispose()
    }
  })

  it('pins the cursor on missing assets, then completes assets + projection after recovery, without ACKing', async () => {
    const kv = new QuotaKV()
    const { http, runtime } = makeRuntime(kv)

    // Every required asset request fails this round (transient network outage).
    http.assets = {}
    const ack = makeDelivery({ state: 'acknowledged', sequence: 5 })
    http.enqueue(deliveriesResponse([ack], 5))
    const first = await runtime.pollOnce()

    expect(first?.outcomes[0]?.outcome.kind).toBe('waiting-assets')
    // Cursor is pinned BELOW the delivery's sequence so the next poll asks again.
    expect(runtime.draftState('sess-A').since).toBeLessThan(5)
    expect(http.ackCalls).toHaveLength(0) // acknowledged deliveries never ACK
    expect(runtime.cards()).toHaveLength(0) // no zero-asset card is rendered
    expect(http.assetCalls).toHaveLength(3) // 3 required assets attempted

    // Network recovers. Because the cursor never passed sequence 5, the server
    // re-serves the same acknowledged delivery and bindAssets completes it.
    http.assets = assetResponses()
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'acknowledged', sequence: 5 })], 5))
    const second = await runtime.pollOnce()

    expect(['rendered', 'recovered']).toContain(second?.outcomes[0]?.outcome.kind)
    expect(http.assetCalls.length).toBeGreaterThan(3) // 补拉 actually happened
    expect(runtime.draftState('sess-A').since).toBe(5)
    expect(http.ackCalls).toHaveLength(0) // still no ACK, no server state change
    expect(runtime.cards()).toHaveLength(1)

    // Assets are bound, so the projection carries REAL image blocks rather than
    // "image unavailable" placeholders.
    const content = runtime.submission.buildContent({
      sessionId: 'sess-A', uploaded: [], text: 'Q', requestId: 'req-after',
    })
    expect(JSON.stringify(content)).not.toContain('image unavailable')
    expect(content.some(part => part.type === 'image')).toBe(true)
  })
})

describe('accepted-send recovery — a consumed delivery never blocks a later send', () => {
  it('retires the consumed reference in memory even while localStorage is full', async () => {
    const kv = new QuotaKV()
    const { http, runtime } = makeRuntime(kv)
    Object.assign(http, { consume: async () => {} })

    // A reference the Host already consumed survives on disk after a crash;
    // on restart the client recovers it as a visible card.
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'acknowledged', sequence: 3 })], 3))
    await runtime.pollOnce()
    expect(runtime.cards()).toHaveLength(1)

    // The Host now reports the same reference as consumed, but local writes
    // fail (quota). `prepare()` used to let queue.markDeleted's persist throw,
    // which sendSession treated as a send failure and abandoned the message.
    kv.blocked = true
    http.enqueue({ ...deliveriesResponse([makeDelivery({ state: 'consumed', sequence: 4 })], 4), tracksSubmissions: true })
    await expect(runtime.submission.prepare?.('sess-A')).resolves.toBeUndefined()

    // The in-memory retirement still holds: no card, no group, and the next
    // projection carries only its own text. The tombstone/pending archive are
    // idempotent and are retried by the poller once the quota recovers.
    expect(runtime.cards()).toHaveLength(0)
    expect(runtime.draftState('sess-A').groups).toHaveLength(0)
    const next = runtime.submission.buildContent({
      sessionId: 'sess-A', uploaded: [], text: '第二条消息', requestId: 'req-consumed',
    })
    expect(next).toEqual([{ type: 'text', text: '第二条消息' }])

    kv.blocked = false
    http.enqueue(deliveriesResponse([], 4))
    await runtime.pollOnce()
    expect(runtime.cards()).toHaveLength(0)
    runtime.dispose()
  })
})
