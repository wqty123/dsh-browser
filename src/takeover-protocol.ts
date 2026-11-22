export const TAKEOVER_ROUTE = '/dsh-builtin-browser/browser/takeover'
export const TAKEOVER_TOOL = 'dsh_browser_request_takeover'

export type TakeoverOutcome = 'done' | 'skipped' | 'cancelled'
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
