import { describe, expect, it, vi } from 'vitest'
import type { OrderedReferenceGroup } from '../types.ts'
import { createMemoryStorage } from '../types.ts'
import {
  createDeliveryQueue,
  isValidTransition,
  nextDeliveryState,
  DEFAULT_DELIVERY_STORAGE_KEY,
} from '../pending-delivery.ts'

const group: OrderedReferenceGroup = {
  referenceId: 'ref-1',
  parts: [{ kind: 'text', partId: 'p1', referenceId: 'ref-1', text: 'x' }],
}
const emptyGroup: OrderedReferenceGroup = { referenceId: 'other-ref', parts: [] }

describe('state machine', () => {
  it('validates one-step-forward transitions', () => {
    expect(isValidTransition('captured', 'assets-ready')).toBe(true)
    expect(isValidTransition('draft-applied', 'acknowledged')).toBe(true)
    expect(isValidTransition('captured', 'acknowledged')).toBe(false)
    expect(nextDeliveryState('acknowledged')).toBeUndefined()
    expect(nextDeliveryState('prepared')).toBe('draft-applied')
  })
})

describe('idempotent delivery (B27)', () => {
  it('deduplicates by intent id', () => {
    const storage = createMemoryStorage()
    const queue = createDeliveryQueue({ storage, now: () => 1, onApply: vi.fn() })
    expect(queue.capture({ intentId: 'I1', sessionId: 'S1', group }).status).toBe('created')
    expect(queue.capture({ intentId: 'I1', sessionId: 'S1', group }).status).toBe('existing')
    expect(queue.snapshot()).toHaveLength(1)
  })

  it('rejects an illegal state jump through advance()', () => {
    const queue = createDeliveryQueue({ storage: createMemoryStorage() })
    queue.capture({ intentId: 'I1', sessionId: 'S1', group })
    expect(queue.advance('I1', 'acknowledged')).toMatchObject({ status: 'invalid-transition', from: 'captured', to: 'acknowledged' })
    expect(queue.advance('I1', 'assets-ready').status).toBe('advanced')
  })

  it('ACK is idempotent across repeated notification, lost ACK and late retry', () => {
    const storage = createMemoryStorage()
    const apply = vi.fn()
    const first = createDeliveryQueue({ storage, now: () => 1, onApply: apply })
    first.capture({ intentId: 'I1', sessionId: 'S1', group })
    for (const state of ['assets-ready', 'prepared', 'draft-applied'] as const) first.advance('I1', state)
    expect(first.acknowledge('I1').status).toBe('acknowledged')
    expect(apply).toHaveBeenCalledTimes(1)
    // Repeated ACK notification.
    expect(first.acknowledge('I1').status).toBe('already-acknowledged')
    expect(apply).toHaveBeenCalledTimes(1)

    // Simulate a process restart / lost ACK: a fresh queue over the same storage.
    const apply2 = vi.fn()
    const restarted = createDeliveryQueue({ storage, onApply: apply2 })
    expect(restarted.get('I1')?.state).toBe('acknowledged')
    expect(restarted.capture({ intentId: 'I1', sessionId: 'S1', group }).status).toBe('existing')
    expect(restarted.acknowledge('I1').status).toBe('already-acknowledged')
    expect(apply2).toHaveBeenCalledTimes(0)
    expect(apply).toHaveBeenCalledTimes(1)
  })
})

describe('tombstones (B28)', () => {
  it('a deleted reference stays deleted under late retries, even after restart', () => {
    const storage = createMemoryStorage()
    const apply = vi.fn()
    const queue = createDeliveryQueue({ storage, onApply: apply })
    queue.capture({ intentId: 'I1', sessionId: 'S1', group })
    queue.acknowledge('I1')
    expect(apply).toHaveBeenCalledTimes(1)

    queue.markDeleted('ref-1')
    expect(queue.get('I1')?.deleted).toBe(true)
    expect(queue.capture({ intentId: 'I1', sessionId: 'S1', group }).status).toBe('deleted')
    expect(queue.acknowledge('I1').status).toBe('deleted')
    // A brand-new late intent for the same reference must not resurrect it.
    expect(queue.capture({ intentId: 'I2', sessionId: 'S1', group }).status).toBe('deleted')

    const restarted = createDeliveryQueue({ storage, onApply: apply })
    expect(restarted.capture({ intentId: 'I2', sessionId: 'S1', group }).status).toBe('deleted')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('persists deliveries and tombstones through injected storage', () => {
    const storage = createMemoryStorage()
    const queue = createDeliveryQueue({ storage })
    queue.capture({ intentId: 'I1', sessionId: 'S1', group })
    queue.markDeleted('other-ref')
    expect(storage.getItem(DEFAULT_DELIVERY_STORAGE_KEY)).not.toBeNull()

    const restarted = createDeliveryQueue({ storage })
    expect(restarted.snapshot()).toHaveLength(1)
    expect(restarted.capture({ intentId: 'I9', sessionId: 'S1', group: emptyGroup }).status).toBe('deleted')
  })

  it('dispose() clears in-memory state and blocks further writes', () => {
    const queue = createDeliveryQueue({ storage: createMemoryStorage() })
    queue.capture({ intentId: 'I1', sessionId: 'S1', group })
    queue.dispose()
    expect(queue.snapshot()).toHaveLength(0)
    expect(() => queue.capture({ intentId: 'I2', sessionId: 'S1', group })).toThrow()
  })
})
