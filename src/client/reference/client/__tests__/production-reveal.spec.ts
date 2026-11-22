import { describe, expect, it } from 'vitest'
import {
  createProductionRevealer,
  createRevealAdapter,
  type RevealOwner,
} from '../production/reveal.ts'
import { encodeBrowserRefUri } from '../scheme.ts'
import { FakeReferenceHttp, makeSnapshot } from './production.fixtures.ts'
import { BridgeVersionError } from '../../../../bridge-compatibility.ts'

function owner(overrides: Partial<RevealOwner> = {}): RevealOwner {
  const snapshot = makeSnapshot('sess-A')
  return {
    sessionId: snapshot.owner.sessionId ?? 'sess-A',
    browserSessionId: snapshot.owner.browserSessionId ?? 'browser-sess-77',
    label: snapshot.source.title,
    frameRoute: 'frame',
    frameSelector: 'iframe#content',
    ...overrides,
  }
}

interface Setup {
  http: FakeReferenceHttp
  revealer: ReturnType<typeof createProductionRevealer>
  owners: Map<string, RevealOwner>
  current: { id: string }
}

function setup(overrides: { current?: string; owner?: RevealOwner; revealOutcome?: FakeReferenceHttp['revealOutcome'] } = {}): Setup {
  const http = new FakeReferenceHttp()
  if (overrides.revealOutcome !== undefined) http.revealOutcome = overrides.revealOutcome
  const owners = new Map<string, RevealOwner>()
  owners.set('ref-mixed-1', overrides.owner ?? owner())
  const current = { id: overrides.current ?? 'sess-A' }
  const revealer = createProductionRevealer({
    http,
    resolveOwner: referenceId => owners.get(referenceId),
    currentSessionId: () => current.id,
  })
  return { http, revealer, owners, current }
}

const URI = encodeBrowserRefUri({ referenceId: 'ref-mixed-1', partId: 'tb-1' })

describe('createProductionRevealer — /reference/reveal + understandable states', () => {
  it('maps the loader package code to the same named error in the reveal adapter', async () => {
    const { http, owners, current } = setup({ revealOutcome: { ok: true, status: 'unavailable', code: 'DSH_BRIDGE_PACKAGE_UNAVAILABLE' } })
    const adapter = createRevealAdapter({ http, resolveOwner: id => owners.get(id), currentSessionId: () => current.id })
    await expect(adapter.locate({ referenceId: 'ref-mixed-1', sessionId: 'sess-A' }, new AbortController().signal)).rejects.toBeInstanceOf(BridgeVersionError)
    await expect(adapter.locate({ referenceId: 'ref-mixed-1', sessionId: 'sess-A' }, new AbortController().signal)).rejects.toMatchObject({
      name: 'BridgeVersionError', code: 'BROWSER_BRIDGE_VERSION_MISMATCH', message: '浏览器桥接不可用，请点击 卸载并重装',
    })
  })

  it('reveals a known reference in the owning session with referenceId + partId', async () => {
    const { http, revealer } = setup()
    const status = await revealer.activate(URI)
    expect(status).toBe('revealed')
    expect(revealer.lastStatus()).toBe('revealed')
    expect(http.revealCalls).toEqual([{ referenceId: 'ref-mixed-1', partId: 'tb-1' }])
  })

  it('reports session-mismatch when the link belongs to another DSH session (no reveal call)', async () => {
    const { http, revealer } = setup({ current: 'sess-B' })
    expect(await revealer.activate(URI)).toBe('session-mismatch')
    expect(http.revealCalls).toHaveLength(0)
  })

  it('reports unknown-reference for an id not in the knowledge set', async () => {
    const { http, revealer } = setup()
    const unknown = encodeBrowserRefUri({ referenceId: 'does-not-exist' })
    expect(await revealer.activate(unknown)).toBe('unknown-reference')
    expect(http.revealCalls).toHaveLength(0)
  })

  it('reports unavailable when the source/ tab is gone (server failure)', async () => {
    const { revealer } = setup({ revealOutcome: { ok: true, status: 'source-unavailable', reason: '原标签页已关闭' } })
    expect(await revealer.activate(URI)).toBe('unavailable')
  })

  // The plugin tells apart "you are on another page" from "the text is gone";
  // collapsing those into `unavailable` was the one misleading toast.
  it('keeps the plugin cause instead of flattening it to unavailable', async () => {
    for (const [wire, expected] of [
      ['page-mismatch', 'page-mismatch'],
      ['session-unavailable', 'session-unavailable'],
      ['missing', 'missing'],
      ['ambiguous', 'ambiguous'],
      ['not-found', 'not-found'],
    ] as const) {
      const { revealer } = setup({ revealOutcome: { ok: true, status: wire } })
      expect(await revealer.activate(URI)).toBe(expected)
    }
  })

  it('treats a partial highlight as a success (the page was located)', async () => {
    const { revealer } = setup({ revealOutcome: { ok: true, status: 'partial' } })
    expect(await revealer.activate(URI)).toBe('revealed')
  })

  it('a plain / non-canonical URI never reaches the reveal endpoint', async () => {
    const { http, revealer } = setup()
    expect(await revealer.activate('https://example.com/x')).toBe('unknown-reference')
    expect(http.revealCalls).toHaveLength(0)
  })
})

describe('createRevealAdapter.validate — explicit validation statuses', () => {
  it('validates ok / unknown-reference / session-mismatch', () => {
    const { http, current } = setup()
    const adapter = createRevealAdapter({ http, resolveOwner: referenceId => referenceId === 'ref-mixed-1' ? owner() : undefined, currentSessionId: () => current.id })
    expect(adapter.validate({ referenceId: 'ref-mixed-1', sessionId: 'sess-A' })).toBe('ok')
    expect(adapter.validate({ referenceId: 'nope', sessionId: 'sess-A' })).toBe('unknown-reference')
    expect(adapter.validate({ referenceId: 'ref-mixed-1', sessionId: 'sess-B' })).toBe('session-mismatch')
  })
})
