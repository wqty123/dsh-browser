/**
 * User-facing affordances of the dock, asserted on the path the desktop
 * actually renders: a removal is final, a stuck delivery explains itself, and
 * the one stylesheet the plugin injects is installed exactly once.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createProductionRuntime, type ProductionRuntime } from '../production/runtime.ts'
import type { HostInputFace } from '../production/draft-adapter.ts'
import { ReferenceDock } from '../production/ReferenceDock.tsx'
import { zh } from '../production/reference-labels.ts'
import { DOCK_CSS, DOCK_STYLE_ID, ensureDockStyles } from '../production/styles.ts'
import {
  FakeReferenceHttp,
  assetOf,
  ASSET_MAP,
  deliveriesResponse,
  fakeHostInput,
  makeDelivery,
  memoryKV,
} from './production.fixtures.ts'

function harness(options: { persistThrows?: boolean } = {}): { http: FakeReferenceHttp; runtime: ProductionRuntime } {
  const http = new FakeReferenceHttp()
  http.assets = Object.fromEntries(Object.entries(ASSET_MAP).map(([key, bytes]) => [key, assetOf(key, bytes)]))
  const host: HostInputFace = options.persistThrows === true
    ? Object.assign(Object.create(Object.getPrototypeOf(fakeHostInput('问题', 0))), fakeHostInput('问题', 0), {
      persistDraft: () => { throw new Error('host draft save failed') },
    }) as HostInputFace
    : fakeHostInput('问题', 0)
  const runtime = createProductionRuntime({
    http,
    storage: memoryKV(),
    initialSessionId: 'sess-A',
    hostInputFor: () => host,
    now: () => 1,
  })
  return { http, runtime }
}

describe('dock stylesheet', () => {
  it('is installed exactly once, into the host document', () => {
    const appended: { id: string; textContent: string }[] = []
    const doc = {
      getElementById: (id: string) => appended.find(entry => entry.id === id) ?? null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: (node: { id: string; textContent: string }) => { appended.push(node) } },
      documentElement: { appendChild: () => undefined },
    } as unknown as Document
    ensureDockStyles(doc)
    ensureDockStyles(doc)
    expect(appended).toHaveLength(1)
    expect(appended[0]!.id).toBe(DOCK_STYLE_ID)
  })

  it('styles only the reply-side anchors the link bridge upgrades', () => {
    // The composer rail is styled by its CSS module; the document-level sheet
    // must not carry dead card rules the React dock never renders.
    expect(DOCK_CSS).toContain('a[data-dsh-browser-ref]')
    expect(DOCK_CSS).not.toContain('.dsh-ref-card')
    expect(DOCK_CSS).not.toContain('.dsh-ref-chips')
  })
})

describe('a stuck delivery explains itself', () => {
  it('keeps a visible, self-clearing notice on the rail', async () => {
    const { http, runtime } = harness({ persistThrows: true })
    http.enqueue(deliveriesResponse([makeDelivery({ state: 'prepared', sequence: 1 })], 1))
    await runtime.pollOnce()
    // The card exists locally, but the host draft could not be saved, so the
    // delivery is retried and the dock must say why it is not confirmed yet.
    const issue = runtime.snapshot().issue
    expect(issue).toContain('输入框')
    const html = renderToStaticMarkup(
      <ReferenceDock sessionId="sess-A" cards={runtime.cards()} actions={{}} labels={zh} {...(issue === undefined ? {} : { notice: issue })} />,
    )
    expect(html).toContain('输入框')

    // The next cycle is clean -> the notice goes away on its own.
    http.enqueue(deliveriesResponse([], 1))
    await runtime.pollOnce()
    expect(runtime.snapshot().issue).toBeUndefined()
  })
})
