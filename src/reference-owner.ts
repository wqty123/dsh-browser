/** Canonical reference owner; browser session / view identities are separate. */
export function referenceOwnerKey(sessionId: string): string {
  const value = sessionId.trim()
  return value.startsWith('session-') ? value.slice('session-'.length) : value
}
