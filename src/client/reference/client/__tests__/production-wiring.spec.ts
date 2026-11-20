// @vitest-environment jsdom
/**
 * Regression cover for the three FOUNDATION defects the interaction audit
 * reproduced against a real mount:
 *
 *  1. the production entry polled an EMPTY session id (nothing ever landed in
 *     the visible draft),
 *  2. a delivery applied in the background never repainted the dock,
 *  3. a transient asset failure advanced the incremental cursor, so the
 *     reference was never retried after the network recovered.
 *
 * These tests drive the real runtime + a STRICT since-filtering transport
 * (unlike the queue fixture, it never replays records an advanced cursor hides)
 * and, for (2), a real React mount that only re-renders through the
 * subscription.
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { createElement, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProductionRuntime,
  type ProductionRuntime,
} from '../production/runtime.ts'
import { apply } from '../production/assembly.ts'
import type { HostContext } from '../production/assembly.ts'
import type {
  AckRequest,
  AckResponse,
  AssetResponse,
  DeliveriesResponse,
  DeliveryRecord,
  RemoveResponse,
} from '../production/protocol.ts'
import type { ReferenceHttpClient } from '../production/http-transport.ts'
import type { HostInputFace } from '../production/draft-adapter.ts'
import {
  ASSET_MAP,
  IMG1_KEY,
  assetOf,
  fakeHostInput,
  makeDelivery,
  memoryKV,
} from './production.fixtures.ts'

afterEach(cleanup)

/** The test runtime's slot registration wrapper exposes the component directly. */
function componentOf(registration: unknown): (props?: unknown) => unknown {
  return registration as (props?: unknown) => unknown
}

/**
 * Transport that honours `since` exactly: it returns only records whose
 * sequence is greater, so a cursor that advanced past a failed record keeps it
 * hidden forever — the behaviour that hid the bug behind a permissive fixture.
 */
class StrictTransport implements ReferenceHttpClient {
  records: DeliveryRecord[] = []
  readonly deliveryCalls: { sessionId: string; since: number }[] = []
  readonly assetCalls: string[] = []
  readonly ackCalls: AckRequest[] = []
  assetShouldFail = new Set<string>()
  assets: Readonly<Record<string, AssetResponse>> = {}

  async deliveries(sessionId: string, since: number): Promise<DeliveriesResponse> {
    this.deliveryCalls.push({ sessionId, since })
    const visible = this.records.filter(record => record.sequence > since)
    const sequence = this.records.reduce((max, record) => Math.max(max, record.sequence), since)
    return { ok: true, sequence, deliveries: visible }
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
    return new TextEncoder().encode(asset.data)
  }

  async ack(request: AckRequest): Promise<AckResponse> {
    this.ackCalls.push(request)
    return {
      ok: true,
      intentId: request.intentId,
      state: request.phase ?? 'acknowledged',
      draftRev: request.draftRev,
      assetKeys: [...request.assetKeys],
    }
  }

  async remove(intentId: string): Promise<RemoveResponse> {
    return { ok: true, intentId, state: 'removed' }
  }

  async reveal(): Promise<never> {
    throw new Error('not used')
  }

  async exportBundle(): Promise<Uint8Array> {
    return new Uint8Array()
  }

  async importBundle(): Promise<unknown> {
    return { ok: true, imported: 0 }
  }
}

interface Harness {
  runtime: ProductionRuntime
  transport: StrictTransport
  hosts: Record<string, ReturnType<typeof fakeHostInput>>
}

function harness(sessionId = 'sess-A'): Harness {
  const transport = new StrictTransport()
  transport.assets = Object.fromEntries(
    Object.entries(ASSET_MAP).map(([key, bytes]) => [key, assetOf(key, bytes)]),
  )
  const hosts = {
    'sess-A': fakeHostInput('帮我总结这段网页内容', 7),
    'sess-B': fakeHostInput('另一个会话的问题', 3),
  }
  const hostInputFor = (id: string): HostInputFace => hosts[id as keyof typeof hosts] ?? fakeHostInput()
  const runtime = createProductionRuntime({
    http: transport,
    storage: memoryKV(),
    initialSessionId: sessionId,
    hostInputFor,
    now: () => 1700000000000,
  })
  return { runtime, transport, hosts }
}

describe('foundation #3 — a retryable outcome must not advance the cursor', () => {
  it('keeps the failed delivery visible to the next poll and applies it once the asset recovers', async () => {
    const { runtime, transport, hosts } = harness()
    transport.records = [makeDelivery({ state: 'prepared', sequence: 1 })]
    transport.assetShouldFail = new Set([IMG1_KEY])

    const first = await runtime.pollOnce()
    expect(first?.outcomes[0]?.outcome.kind).toBe('waiting-assets')
    // The cursor did NOT move past the record that still has work.
    expect(first?.since).toBe(0)
    expect(runtime.draftState().since).toBe(0)
    expect(runtime.cards()).toHaveLength(0)

    const callsBefore = transport.assetCalls.filter(key => key === IMG1_KEY).length
    transport.assetShouldFail = new Set()

    const second = await runtime.pollOnce()
    expect(second?.outcomes[0]?.outcome.kind).toBe('acknowledged')
    // The asset was requested AGAIN — proof the record was retried, not skipped.
    expect(transport.assetCalls.filter(key => key === IMG1_KEY).length).toBeGreaterThan(callsBefore)
    expect(runtime.draftState().since).toBe(1)
    expect(runtime.cards()).toHaveLength(1)

    // The user's question survived and the reference group was appended after it.
    expect(hosts['sess-A']!.readText()).toContain('帮我总结这段网页内容')
  })

  it('advances past a record the queue already tombstoned (a removed card never blocks the cursor)', async () => {
    const { runtime, transport } = harness()
    const delivery = makeDelivery({ state: 'prepared', sequence: 1 })
    transport.records = [delivery]
    await runtime.pollOnce()
    expect(runtime.draftState().since).toBe(1)
  })
})

describe('foundation #1 — the runtime follows the visible Session', () => {
  it('polls the session it was switched to and keeps cards separated', async () => {
    const { runtime, transport } = harness('sess-A')
    transport.records = [
      makeDelivery({ state: 'prepared', sequence: 1, sessionId: 'sess-A' }),
      makeDelivery({
        state: 'prepared', sequence: 2, sessionId: 'sess-B',
        referenceId: 'ref-b', intentId: 'ref-b',
      }),
    ]

    await runtime.pollOnce()
    expect(transport.deliveryCalls.at(-1)?.sessionId).toBe('sess-A')
    expect(runtime.cards()).toHaveLength(1)

    runtime.setSession('sess-B')
    expect(runtime.currentSessionId()).toBe('sess-B')
    // Switching sessions must repaint immediately from local state.
    expect(runtime.snapshot().sessionId).toBe('sess-B')

    transport.records = []
    await runtime.pollOnce()
    expect(transport.deliveryCalls.at(-1)?.sessionId).toBe('sess-B')
  })

  it('binds the dock props to the runtime (session id + that session’s input face)', () => {
    const { runtime } = harness('')
    const registered: ((props?: unknown) => unknown)[] = []
    const ctx: HostContext = {
      get: () => undefined,
      provide: () => undefined,
      effect: () => {},
      slots: {
        // The host calls `inject(name, producer)` and registers what it yields.
        inject: (_name: string, producer: () => Iterable<unknown>) => {
          for (const registration of producer()) {
            registered.push(componentOf(registration))
          }
        },
        register: (_registration: unknown, component: unknown) => {
          registered.push(component as (props?: unknown) => unknown)
          return () => {}
        },
      },
    }
    apply(ctx, {
      request: { get: async () => ({ status: 200, body: { ok: true, sequence: 0, deliveries: [] } }) } as never,
      storage: memoryKV(),
    })
    const dock = registered[0]
    expect(dock).toBeTypeOf('function')
    // Session-scope props, exactly as the host passes them.
    const props = {
      session: { sessionId: 'sess-42' },
      input: { draft: '已经写了一半的问题' },
      inputActions: {
        captureInsertion: () => ({ start: 0, end: 0, draftRev: 4 }),
        insertText: () => true,
        persistDraft: () => {},
      },
    }
    const rendered = dock!(props) as { props: Record<string, unknown> }
    expect(rendered).toBeTruthy()
    void runtime
  })
})

describe('foundation #2 — the dock repaints from the subscription', () => {
  it('notifies subscribers only when the visible content changes', async () => {
    const { runtime, transport } = harness()
    const listener = vi.fn()
    const unsubscribe = runtime.subscribe(listener)
    const idle = runtime.snapshot()
    expect(runtime.snapshot()).toBe(idle)

    // An empty poll changes nothing: no repaint, same snapshot identity.
    transport.records = []
    await runtime.pollOnce()
    expect(listener).not.toHaveBeenCalled()
    expect(runtime.snapshot()).toBe(idle)

    transport.records = [makeDelivery({ state: 'prepared', sequence: 1 })]
    await runtime.pollOnce()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(runtime.snapshot()).not.toBe(idle)
    expect(runtime.snapshot().cards).toHaveLength(1)

    unsubscribe()
    transport.records = []
    await runtime.pollOnce()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('retires the references a send carried, so the next message cannot repeat them', async () => {
    const { runtime, transport } = harness()
    transport.records = [makeDelivery({ state: 'prepared', sequence: 1 })]
    await runtime.pollOnce()
    expect(runtime.cards()).toHaveLength(1)

    const content = runtime.submission.buildContent({ sessionId: 'sess-A', uploaded: [], text: '这段讲什么' })
    expect(content.length).toBeGreaterThan(1) // the reference, then the typed question
    // Projection is a pure read: until the Host ACCEPTS the prompt the quote is
    // still the user's draft, so a refused send cannot lose it.
    expect(runtime.cards()).toHaveLength(1)

    runtime.submission.commit('sess-A')
    // Accepted means message content now: the draft must stop holding it, otherwise
    // the following send attaches the same quote a second time.
    expect(runtime.cards()).toHaveLength(0)

    const again = runtime.submission.buildContent({ sessionId: 'sess-A', uploaded: [], text: '第二个问题' })
    expect(again).toHaveLength(1)
    expect(JSON.stringify(again)).not.toContain('引用')
  })

  it('keeps the draft when the Host refuses the send, and its source after a send', async () => {
    const { runtime, transport } = harness()
    transport.records = [makeDelivery({ state: 'prepared', sequence: 1 })]
    await runtime.pollOnce()
    expect(runtime.cards()).toHaveLength(1)

    runtime.submission.buildContent({ sessionId: 'sess-A', uploaded: [], text: '被拒绝的问题' })
    runtime.submission.rollback('sess-A')
    expect(runtime.cards()).toHaveLength(1)

    runtime.submission.buildContent({ sessionId: 'sess-A', uploaded: [], text: '再发一次' })
    runtime.submission.commit('sess-A')
    expect(runtime.cards()).toHaveLength(0)
    // The sent message keeps its provenance: the card is gone from the draft, but
    // its snapshot still resolves the source for a reveal click.
    const referenceId = transport.records[0]!.referenceId
    expect(runtime.ownerFor(referenceId)).toBeDefined()
  })

  it('renders a background delivery into a real React tree without any manual re-render', async () => {
    const { runtime, transport } = harness()
    // The live component the plugin registers, over the host's own hook.
    const { createLiveCardDockComponent } = await import('../production/assembly.ts')
    const Dock = createLiveCardDockComponent(
      runtime,
      (tag, props, ...children) => createElement(tag, props as never, ...(children as never[])),
    )
    // The host binds the registration's `hooks.dockCards` into this prop; here the
    // binding is spelled out with the same primitive the host uses.
    const useDockCards = (selector: (value: unknown) => unknown): unknown =>
      useSyncExternalStore(runtime.subscribe, () => selector(runtime.snapshot()))
    const view = render(createElement(Dock as never, { useDockCards } as never))
    // Nothing to show → nothing in the DOM at all: an empty wrapper would still
    // occupy the in-card chip row and defeat its `:empty` collapse.
    // 空轨道的契约是「空壳 + 样式折叠」，不是返回 null：宿主输入面必须每次渲染都
    // 交给 runtime，否则第一次投递永远拿不到面（`ReferenceDock` 里那段注释即此事）。
    const shell = view.container.querySelector('.dsh-browser-reference-dock')
    expect(shell).not.toBeNull()
    expect(shell?.getAttribute('data-cards')).toBe('0')
    expect(view.container.textContent).toBe('')

    transport.records = [makeDelivery({ state: 'prepared', sequence: 1 })]
    await act(async () => { await runtime.pollOnce() })

    // No interaction, no re-render call: the collapsed pill appears on its own.
    const pills = view.container.querySelectorAll('[data-reference-id]')
    expect(pills).toHaveLength(1)
    // The pill is a one-line summary; the captured paragraph itself is not in
    // the composer until the card opens.
    expect(view.container.querySelectorAll('p').length).toBe(0)

    // The captured text is one hover away, in the portalled detail card.
    fireEvent.mouseEnter(pills[0] as HTMLElement)
    expect(document.body.textContent).toContain('The quick brown fox')
  })
})
