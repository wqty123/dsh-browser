/**
 * The RPC operation vocabulary, in one place.
 *
 * The child (`host-main.ts`) switches on these names and the parent (`remote-host.ts`) sends
 * them. Both spelled them out independently and nothing connected the two, so a rename on one
 * side compiled fine and failed at run time as "unknown op" — and this pair has already
 * produced one silent failure of that shape (`noteStartFailure`'s dedupe comparison, which was
 * never true and meant a log line that never appeared).
 *
 * The lists are the source of truth for a test that reads both switch statements and asserts
 * they agree, which is what makes a one-sided rename fail loudly instead of at run time.
 */

/** Operations the parent asks the child to perform. */
export const RPC_OPS = [
  'ping',
  'createView',
  'destroyView',
  'showView',
  'groupView',
  'focus',
  'command',
  'capture',
  'download',
  'flushAuth',
  'restoreAuth',
  'navigate',
  'new-tab',
  'activate',
  'close',
  'back',
  'forward',
  'reload',
  'userActionError',
] as const

/** Notifications the child sends the parent, which carry no reply. */
export const RPC_NOTIFICATIONS = ['userAction', 'viewClosed'] as const

/** One operation name. */
export type RpcOp = (typeof RPC_OPS)[number]
