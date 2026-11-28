export { WEB_SOURCE_ROUTE } from '../assets/browser-policy.mjs'
export const WEB_REVEAL_STATUSES = ['revealed', 'partial', 'ambiguous', 'missing', 'not-found', 'page-mismatch', 'unavailable'] as const
export type WebRevealStatus = typeof WEB_REVEAL_STATUSES[number]
