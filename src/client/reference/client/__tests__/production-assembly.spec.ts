import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  inject,
  createReplyLinkComponent,
  type BrowserReferenceDeps,
  type HostContext,
} from '../production/assembly.ts'
import type { RequestInitLike, RawResponse } from '../production/http-transport.ts'
import { fakeHostInput, manualScheduler } from './production.fixtures.ts'

interface StubCtx extends HostContext {
  readonly slotInjections: string[]
  readonly registrations: { name: string; key?: string; id?: string }[]
  readonly components: unknown[]
  readonly services: Record<string, unknown>
  readonly effects: { label: string; cleanup: () => void }[]
  set(name: string, value: unknown): void
}

function stubCtx(): StubCtx {
  const slotInjections: string[] = []
  const registrations: { name: string; key?: string; id?: string }[] = []
  const components: unknown[] = []
  const services: Record<string, unknown> = {}
  const effects: { label: string; cleanup: () => void }[] = []
  const ctx: StubCtx = {
    slotInjections,
    registrations,
    components,
    services,
    effects,
    get: () => undefined,
    set: (name, value) => { services[name] = value },
    effect: (fn, label) => { effects.push({ label, cleanup: (fn() as (() => void) | void) ?? (() => {}) }) },
    slots: {
      inject(name, producer) {
        slotInjections.push(name)
        for (const _entry of producer()) void _entry
      },
      register(registration, component) {
        const record = registration as { name: string; key?: string; id?: string }
        registrations.push({ name: record.name, ...(record.key === undefined ? {} : { key: record.key }), ...(record.id === undefined ? {} : { id: record.id }) })
        components.push(component)
        return undefined
      },
    },
  }
  return ctx
}

afterEach(() => {
  // apply() installs a global markdown hook; clear it so no spec leaks state.
  delete (globalThis as unknown as Record<string, unknown>)['__DSH_BROWSER_REF_RENDERER__']
})

function emptyRequest(): (url: string, init?: RequestInitLike) => Promise<RawResponse> {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, sequence: 0, deliveries: [] }),
    bytes: async () => new Uint8Array(),
  })
}

describe('assembly inject / apply(ctx)', () => {
  it('declares the exact host services it injects', () => {
    expect(inject).toEqual([
      'slots', 'sessions', 'uiConversation', 'conversation', 'uiSession', 'locale',
    ])
  })

  it('registers the dock card + reply link slots and exposes the submission seam', () => {
    const ctx = stubCtx()
    const runtime = apply(ctx, {
      request: emptyRequest(),
      initialSessionId: 'sess-A',
      hostInputFor: () => fakeHostInput(),
      scheduler: manualScheduler(),
      createElement: (tag, props, ...children) => ({ tag, props, children }),
    })
    expect(ctx.slotInjections).toEqual(['conversation.input.dock', 'conversation.user.text.node', 'shell.overlay'])
    expect(ctx.registrations).toEqual([
      { name: 'conversation.input.dock', id: 'dsh-browser-reference' },
      { name: 'conversation.user.text.node', key: 'browser-ref' },
      { name: 'shell.overlay', id: 'dsh-browser-reference-feedback' },
    ])
    expect(ctx.services['browserReferenceSubmission']).toBe(runtime.submission)
    expect(runtime.disposed).toBe(false)
    // The markdown link renderer is installed on globalThis (optional hook).
    const globalHost = globalThis as unknown as Record<string, unknown>
    expect(typeof globalHost['__DSH_BROWSER_REF_RENDERER__']).toBe('function')
    // Effect cleanups: markdown renderer unregister + runtime dispose.
    expect(ctx.effects.length).toBeGreaterThanOrEqual(2)
    for (const effect of ctx.effects) effect.cleanup()
    expect(runtime.disposed).toBe(true)
    expect(globalHost['__DSH_BROWSER_REF_RENDERER__']).toBeUndefined()
  })

  it('registers the live dock on the in-card overlay rail and a callable reply-link factory', () => {
    const ctx = stubCtx()
    const runtime = apply(ctx, {
      request: emptyRequest(),
      initialSessionId: 'sess-A',
      hostInputFor: () => fakeHostInput(),
      scheduler: manualScheduler(),
      createElement: (tag, props, ...children) => ({ tag, props, children }),
    })
    // The dock is registered as a component, not rendered through a separate
    // zero-React tree: the seat hands it the host React hooks on every render.
    expect(ctx.registrations).toContainEqual({ name: 'conversation.input.dock', id: 'dsh-browser-reference' })
    const dock = ctx.components[0] as (props?: unknown) => { type?: { name?: string } } | null
    expect(typeof dock).toBe('function')
    expect(dock()?.type?.name).toBe('ReferenceDock')
    const createElement = (tag: string, props: Readonly<Record<string, unknown>>, ...children: readonly unknown[]) => ({ tag, props, children })
    const link = createReplyLinkComponent(runtime, createElement)
    expect(typeof link).toBe('function')
    // A plain https link must fall back to the host's raw-text renderer, not a
    // disabled "来源不可用" dead button (B5).
    expect(link({ uri: 'https://example.com', children: 'x' })).toBeNull()
    const button = link({ uri: 'dsh-browser-ref:ref-1', children: 'x' }) as { tag: string }
    expect(button.tag).toBe('button')
    runtime.dispose()
  })

  it('resolves host adapters from the browserReferenceDeps scope service (L01 wiring)', () => {
    const ctx = stubCtx()
    const host = fakeHostInput('来自 deps 的问题', 11)
    const deps: BrowserReferenceDeps = {
      hostInputFor: () => host,
      createElement: (tag, props, ...children) => ({ tag, props, children }),
      baseUrl: 'http://127.0.0.1:49999',
      admitAsset: async () => undefined,
    }
    ctx.set('browserReferenceDeps', deps)
    const runtime = apply(ctx, { request: emptyRequest(), initialSessionId: 'sess-A', scheduler: manualScheduler() })
    expect(ctx.services['browserReferenceSubmission']).toBe(runtime.submission)
    expect(runtime.draftState('sess-A').groups).toHaveLength(0)
    // The deps-provided element factory is the one the dock renders through.
    const dock = ctx.components[0] as (props?: unknown) => { type?: { name?: string } } | null
    expect(dock()?.type?.name).toBe('ReferenceDock')
    runtime.dispose()
  })
})
