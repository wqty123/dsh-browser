// A reference must survive the draft save, or the reader cannot send it.
//
// Reported from the live app: a composer holding only a reference sent an EMPTY content array, which
// the Host answered with "generation continuation is unavailable (session/agent-busy)". The cause was
// `preservationIntact` comparing `draftRev` before and after: persisting the host draft is itself an
// edit, so a host whose `persistDraft()` bumps the revision always looked "changed", every append was
// treated as a failed save, the group never entered the draft store, and the send projected nothing.
//
// The user's text and caret still have to be untouched; only the revision is allowed to move.
import { describe, expect, it } from 'vitest'

import { capturePreservation, preservationIntact, preserveAndAppend } from '../production/draft-adapter.ts'

/** A host face whose `persistDraft()` bumps the revision, exactly like the real composer. */
function hostThatBumpsRevision(bumpOnPersist = true) {
  const state = { text: '用户已经写的问题', start: 3, end: 3, draftRev: 7 }
  return {
    state,
    readText: () => state.text,
    captureInsertion: () => ({ start: state.start, end: state.end, draftRev: state.draftRev }),
    insertText: () => true,
    persistDraft: () => { if (bumpOnPersist) state.draftRev += 1 },
    setText: (next: string) => { state.text = next },
    moveCaret: (at: number) => { state.start = at; state.end = at },
  }
}

/** The smallest store `preserveAndAppend` needs. */
function stubStore() {
  let rev = 0
  return {
    append: () => { rev += 1; return { status: 'appended', draftRev: rev } },
    persist: () => {},
  }
}

describe('draft preservation', () => {
  it('accepts a bumped revision when the text and caret are untouched', () => {
    const host = hostThatBumpsRevision()
    const before = capturePreservation(host as never)
    host.persistDraft()
    expect(preservationIntact(host as never, before)).toBe(true)
  })

  it('still refuses when the user text changed under us', () => {
    const host = hostThatBumpsRevision()
    const before = capturePreservation(host as never)
    host.setText('被改掉了')
    expect(preservationIntact(host as never, before)).toBe(false)
  })

  it('still refuses when the caret moved', () => {
    const host = hostThatBumpsRevision()
    const before = capturePreservation(host as never)
    host.moveCaret(11)
    expect(preservationIntact(host as never, before)).toBe(false)
  })

  it('reports a successful append even though persisting bumped the revision', () => {
    const host = hostThatBumpsRevision()
    const result = preserveAndAppend({
      host: host as never,
      store: stubStore() as never,
      makeReflection: () => ({ referenceId: 'r1' }) as never,
    })
    expect(result.ok).toBe(true)
    expect(result.saveSucceeded).toBe(true)
    expect(result.preserved).toBe(true)
  })
})
