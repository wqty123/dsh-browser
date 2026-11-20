export const WEB_SOURCE_ROUTE = '/dsh-builtin-browser/reference/source'
export const WEB_REVEAL_STATUSES = ['revealed', 'partial', 'ambiguous', 'missing', 'not-found', 'page-mismatch', 'unavailable'] as const
export type WebRevealStatus = typeof WEB_REVEAL_STATUSES[number]
