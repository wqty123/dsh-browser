export { TAKEOVER_ROUTE } from '../assets/browser-policy.mjs'
export const TAKEOVER_TOOL = 'dsh_browser_request_takeover'

/**
 * What the tool reports back to the model.
 *
 * `unavailable` is its own outcome on purpose: it means this host has no way to reach a person
 * (no approval channel and no sidebar card), which is a property of the host, not something the
 * person decided. Folding it into `cancelled` told the model that a human had declined, and since
 * the takeover guidance forbids solving a challenge alone, the only reachable answer became "not
 * success" — a dead end rather than a decision.
 */
export type TakeoverOutcome = 'done' | 'skipped' | 'cancelled' | 'unavailable'
export type TakeoverDecision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface TakeoverSummary {
  readonly url: string
  readonly title: string
  readonly snapshotHint: string
  readonly fresh: boolean
}

export interface TakeoverNotice {
  readonly id: string
  readonly reason: string
  readonly instructions?: string
  readonly phase: 'waiting' | 'summary'
}
