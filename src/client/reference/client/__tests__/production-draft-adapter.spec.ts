import { describe, expect, it } from 'vitest'
import {
  capturePreservation,
  createSessionDraftStore,
  draftStoreKey,
  insertMarkerAtCaret,
  preserveAndAppend,
  preservationIntact,
  reflectionFromDelivery,
  type HostInputFace,
} from '../production/draft-adapter.ts'
import { toOrderedGroup } from '../production/snapshot-adapter.ts'
import { fakeHostInput, makeDelivery, memoryKV } from './production.fixtures.ts'

function reflection(delivery = makeDelivery()) {
  return reflectionFromDelivery(delivery, toOrderedGroup(delivery.snapshot), 1234)
}

describe('capturePreservation / preservationIntact — keep the typed question + caret', () => {
  it('detects an unchanged text/caret/rev and rejects a clobbered one', () => {
    const host = fakeHostInput('请帮我总结', 5)
    const before = capturePreservation(host)
    expect(before.text).toBe('请帮我总结')
    expect(before.span.draftRev).toBe(5)
    expect(preservationIntact(host, before)).toBe(true)
    host.setText('被覆盖了')
    host.setRev(6)
    expect(preservationIntact(host, before)).toBe(false)
  })
})

describe('insertMarkerAtCaret — CAS-guarded editor write (host mechanism)', () => {
  it('inserts at the captured caret with the current draftRev', () => {
    const host = fakeHostInput('AB', 4)
    const result = insertMarkerAtCaret(host, '「来源」')
    expect(result.ok).toBe(true)
    expect(result.span.draftRev).toBe(4)
    expect(host.text).toBe('AB「来源」')
  })
  it('a stale draftRev rejects the edit', () => {
    const host = fakeHostInput('AB', 4)
    const span = host.captureInsertion()
    host.setRev(9)
    expect(host.insertText(span, 'X')).toBe(false)
    expect(host.text).toBe('AB')
  })
})

describe('createSessionDraftStore — CAS append, persistence, recovery', () => {
  it('append uses insertGroup CAS, bumps draftRev and persists groups + full reflections', () => {
    const kv = memoryKV()
    const store = createSessionDraftStore(kv, 'sess-A')
    const result = store.append(reflection())
    expect(result).toEqual({ status: 'appended', draftRev: 1 })
    expect(store.draftState().groups).toHaveLength(1)
    expect(store.state().reflections[0]!.snapshot.parts).toHaveLength(5)
    expect(store.append(reflection())).toEqual({ status: 'duplicate', draftRev: 1 })
    expect(kv.dump()[draftStoreKey('sess-A')]).toBeTruthy()
  })

  it('restore() recovers every fragment + asset binding reference after a restart', () => {
    const kv = memoryKV()
    const first = createSessionDraftStore(kv, 'sess-A')
    first.append(reflection())
    first.setSince(42)
    const second = createSessionDraftStore(kv, 'sess-A')
    expect(second.state().draftRev).toBe(1)
    expect(second.state().since).toBe(42)
    expect(second.state().groups[0]!.parts.map(part => part.kind)).toEqual(['text', 'image', 'table', 'image', 'text'])
    expect(second.state().reflections[0]!.snapshot.parts[2]!.type).toBe('table')
    const img = second.state().reflections[0]!.snapshot.parts[1]!
    expect(img.type === 'image' && img.assetKey).toBeTruthy()
  })

  it('remove() writes a tombstone; late appends of the same reference are refused', () => {
    const kv = memoryKV()
    const store = createSessionDraftStore(kv, 'sess-A')
    store.append(reflection())
    expect(store.remove('ref-mixed-1')).toBe(true)
    expect(store.state().tombstones).toContain('ref-mixed-1')
    expect(store.append(reflection())).toMatchObject({ status: 'duplicate' })
    expect(store.state().groups).toHaveLength(0)
    expect(store.hasReference('ref-mixed-1')).toBe(false)
  })

  it('per-session keys isolate drafts across sessions', () => {
    const kv = memoryKV()
    const a = createSessionDraftStore(kv, 'sess-A')
    const b = createSessionDraftStore(kv, 'sess-B')
    a.append(reflection(makeDelivery({ sessionId: 'sess-A' })))
    expect(a.state().groups).toHaveLength(1)
    expect(b.state().groups).toHaveLength(0)
    expect(kv.dump()[draftStoreKey('sess-A')]).toBeTruthy()
    expect(kv.dump()[draftStoreKey('sess-B')]).toBeUndefined()
  })

  it('setDeliveryState flips a reflection to acknowledged', () => {
    const store = createSessionDraftStore(memoryKV(), 'sess-A')
    store.append(reflection())
    store.setDeliveryState('ref-mixed-1', 'acknowledged')
    expect(store.state().reflections[0]!.deliveryState).toBe('acknowledged')
  })
})

describe('preserveAndAppend — save成功后才允许 ACK', () => {
  it('returns ok only when the append persisted AND the host text/caret survived', () => {
    const kv = memoryKV()
    const store = createSessionDraftStore(kv, 'sess-A')
    const host = fakeHostInput('用户的问题', 7)
    const result = preserveAndAppend({ host, store, makeReflection: () => reflection() })
    expect(result).toMatchObject({ ok: true, status: 'appended', draftRev: 1, preserved: true, saveSucceeded: true })
    expect(host.text).toBe('用户的问题')
    expect(host.calls).not.toContain('insertText')
  })

  it('reports saveSucceeded=false and does NOT allow an ACK when persist fails', () => {
    const kv = memoryKV()
    const store = createSessionDraftStore(kv, 'sess-A')
    const host: HostInputFace = {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
      insertText: () => true,
      persistDraft: () => { throw new Error('disk full') },
      readText: () => '用户的问题',
    }
    const result = preserveAndAppend({ host, store, makeReflection: () => reflection() })
    expect(result.saveSucceeded).toBe(false)
    expect(result.ok).toBe(false)
  })

  it('reports preserved=false when a concurrent edit changed the host text/caret', () => {
    const kv = memoryKV()
    const store = createSessionDraftStore(kv, 'sess-A')
    let rev = 3
    let text = '原文'
    const host: HostInputFace = {
      captureInsertion: () => ({ start: text.length, end: text.length, draftRev: rev }),
      insertText: () => true,
      persistDraft: () => {
        // A concurrent user edit lands during our save.
        text = '用户在保存时又输入了内容'
        rev = 4
      },
      readText: () => text,
    }
    const result = preserveAndAppend({ host, store, makeReflection: () => reflection() })
    expect(result.preserved).toBe(false)
    expect(result.ok).toBe(false)
  })
})
