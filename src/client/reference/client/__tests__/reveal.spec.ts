import { describe, expect, it, vi } from 'vitest'
import type { RevealAdapter, RevealLocation } from '../reveal.ts'
import { createRevealer } from '../reveal.ts'
import type { RevealRequest } from '../types.ts'

function okAdapter(overrides: Partial<RevealAdapter> = {}): RevealAdapter {
  return {
    validate: overrides.validate ?? (() => 'ok'),
    locate: overrides.locate ?? (async () => ({ tabId: 't1' })),
    apply: overrides.apply ?? (() => {}),
  }
}

const request: RevealRequest = { referenceId: 'r1', sessionId: 'S1' }

describe('revealReference contract', () => {
  it('is waitable and applies once on success', async () => {
    const apply = vi.fn()
    const revealer = createRevealer({ adapter: okAdapter({ apply }) })
    await expect(revealer.reveal(request)).resolves.toEqual({ status: 'revealed' })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('returns explicit statuses for unknown id and session mismatch', async () => {
    const locate = vi.fn(async () => ({}))
    const apply = vi.fn()
    const unknown = createRevealer({ adapter: okAdapter({ validate: () => 'unknown-reference', locate, apply }) })
    await expect(unknown.reveal(request)).resolves.toEqual({ status: 'unknown-reference' })
    const mismatch = createRevealer({ adapter: okAdapter({ validate: () => 'session-mismatch', locate, apply }) })
    await expect(mismatch.reveal(request)).resolves.toEqual({ status: 'session-mismatch' })
    expect(locate).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('is cancellable via AbortSignal and never applies after cancellation', async () => {
    const controller = new AbortController()
    const locate = (_req: RevealRequest, signal: AbortSignal) => new Promise<RevealLocation>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    const apply = vi.fn()
    const revealer = createRevealer({ adapter: okAdapter({ locate, apply }) })
    const pending = revealer.reveal({ ...request, signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toEqual({ status: 'cancelled' })
    expect(apply).not.toHaveBeenCalled()
  })

  it('short-circuits when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const validate = vi.fn(() => 'ok' as const)
    const revealer = createRevealer({ adapter: okAdapter({ validate }) })
    await expect(revealer.reveal({ ...request, signal: controller.signal })).resolves.toEqual({ status: 'cancelled' })
    expect(validate).not.toHaveBeenCalled()
  })

  it('a newer intent supersedes an older late result, which cannot apply (B37)', async () => {
    let resolveFirst: (loc: RevealLocation) => void = () => {}
    const firstLocate = (_req: RevealRequest, _signal: AbortSignal) => new Promise<RevealLocation>(resolve => { resolveFirst = resolve })
    let calls = 0
    const locate = (req: RevealRequest, signal: AbortSignal): Promise<RevealLocation> => {
      calls += 1
      return calls === 1 ? firstLocate(req, signal) : Promise.resolve({ tabId: 't2' })
    }
    const apply = vi.fn()
    const revealer = createRevealer({ adapter: okAdapter({ locate, apply }) })
    const older = revealer.reveal({ ...request, referenceId: 'r1' })
    const newer = revealer.reveal({ ...request, referenceId: 'r2' })
    resolveFirst({ tabId: 't1' })
    await expect(older).resolves.toEqual({ status: 'superseded' })
    await expect(newer).resolves.toEqual({ status: 'revealed' })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('dispose() makes further reveals unavailable', async () => {
    const revealer = createRevealer({ adapter: okAdapter() })
    revealer.dispose()
    await expect(revealer.reveal(request)).resolves.toMatchObject({ status: 'unavailable' })
  })
})
