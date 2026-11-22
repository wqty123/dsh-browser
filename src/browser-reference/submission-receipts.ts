import { createHash, randomUUID } from 'node:crypto'
import { referenceOwnerKey } from '../reference-owner.ts'
import { linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deliveryStorePath, type DeliveryQueue } from './delivery.ts'

/** Only the committed Session event's user RPC identity establishes acceptance. */
interface AcceptedMessage { readonly source?: { readonly kind?: string; readonly rpcId?: string } }
interface ReceiptEvent {
  readonly type: string
  readonly data?: AcceptedMessage & { readonly inserted?: readonly AcceptedMessage[] }
}
export interface ReceiptSession {
  readonly seq?: number
  eventAt?(offset: number): ReceiptEvent | undefined
  /** Earlier Desktop versions expose the event log as an array. */
  readonly events?: readonly ReceiptEvent[]
}
interface Attempt { readonly intentIds: readonly string[]; readonly offset: number }
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

function acceptedIds(event: ReceiptEvent | undefined): string[] {
  const messages = event?.type === 'agent/inbox/spliced' ? (event.data?.inserted ?? [])
    : event?.type === 'user/message' && event.data !== undefined ? [event.data] : []
  return messages.flatMap(({ source }) => source?.kind === 'user' && typeof source.rpcId === 'string' && uuid.test(source.rpcId)
    ? [source.rpcId] : [])
}

/** The HTTP client binds its frozen reference ids before sending. The Host
 * joins that receipt to its own accepted request id, including after restart. */
export function createSubmissionReceipts(
  queue: DeliveryQueue,
  sessionFor: (sessionId: string) => ReceiptSession | undefined,
  root = deliveryStorePath() + '.submissions',
) {
  const directory = (sessionId: string): string => join(root, createHash('sha256').update(sessionId).digest('hex'))
  const file = (sessionId: string, requestId: string): string => join(directory(sessionId), requestId + '.json')
  const read = (path: string): Attempt | undefined => {
    try { return JSON.parse(readFileSync(path, 'utf8')) as Attempt }
    catch (error) { if (absent(error)) return undefined; throw error }
  }
  const remove = (path: string): void => {
    try { unlinkSync(path) } catch (error) { if (!absent(error)) throw error }
  }
  const length = (session: ReceiptSession): number => session.seq ?? session.events?.length ?? 0
  const settle = (sessionId: string, path: string, attempt: Attempt): void => {
    for (const id of attempt.intentIds) queue.consume(id, sessionId)
    remove(path)
  }
  return {
    bind(sessionId: string, requestId: string, ids: readonly string[]): boolean {
      sessionId = referenceOwnerKey(sessionId)
      if (!uuid.test(requestId) || ids.length === 0) return false
      if (ids.some(id => {
        const row = queue.get(id)
        return row?.sessionId !== sessionId || row.state === 'consumed' || row.state === 'removed'
      })) return false
      const dir = directory(sessionId)
      mkdirSync(dir, { recursive: true })
      const path = file(sessionId, requestId)
      const session = sessionFor(sessionId)
      const tmp = join(dir, randomUUID() + '.tmp')
      const attempt: Attempt = { intentIds: [...new Set(ids)], offset: session === undefined ? 0 : length(session) }
      try {
        writeFileSync(tmp, JSON.stringify(attempt), { flag: 'wx' })
        // Publish a complete receipt atomically; a duplicate request cannot replace it.
        try { linkSync(tmp, path) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          return JSON.stringify(read(path)?.intentIds) === JSON.stringify(attempt.intentIds)
        }
      } finally { remove(tmp) }
      return true
    },
    observe(sessionId: string, event: ReceiptEvent): void {
      sessionId = referenceOwnerKey(sessionId)
      for (const id of acceptedIds(event)) {
        const path = file(sessionId, id)
        const attempt = read(path)
        if (attempt !== undefined) settle(sessionId, path, attempt)
      }
    },
    /** Called before a session's delivery feed is exposed. If the Session is
     * still loading, only its previously submitted cards need a retry. */
    recover(sessionId: string): readonly string[] {
      sessionId = referenceOwnerKey(sessionId)
      const dir = directory(sessionId)
      let names: string[]
      try { names = readdirSync(dir) } catch (error) { if (absent(error)) return []; throw error }
      const pending = new Map<string, Attempt>()
      for (const name of names) {
        const id = name.slice(0, -5)
        if (!name.endsWith('.json') || !uuid.test(id)) continue
        const path = file(sessionId, id)
        const attempt = read(path)
        if (attempt === undefined) continue
        if (attempt.intentIds.every(intent => {
          const state = queue.get(intent)?.state
          return state === 'consumed' || state === 'removed'
        })) remove(path)
        else pending.set(id, attempt)
      }
      if (pending.size === 0) return []
      const session = sessionFor(sessionId)
      if (session === undefined) return [...new Set([...pending.values()].flatMap(row => row.intentIds))]
      const end = length(session)
      let offset = end
      for (const row of pending.values()) offset = Math.min(offset, row.offset > end ? 0 : row.offset)
      for (; offset < end && pending.size > 0; offset++) {
        const event = session.eventAt ? session.eventAt(offset) : session.events?.[offset]
        for (const id of acceptedIds(event)) {
          const attempt = pending.get(id)
          if (attempt === undefined) continue
          settle(sessionId, file(sessionId, id), attempt)
          pending.delete(id)
        }
      }
      return []
    },
  }
}
