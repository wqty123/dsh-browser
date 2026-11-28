/**
 * Apply-once guard for the client half (issue #132).
 *
 * The host can hand the same context to `apply()` more than once — two rows resolving the same
 * bundle, or a bundle loaded twice — and the second registration used to throw somewhere in the
 * middle of `apply`, taking every later registration (including the settings section) with it.
 * Refusing the second pass up front turns that into one warning and one intact panel.
 *
 * A WeakSet keyed by the context object is deliberate: it is per module instance, so a genuinely
 * new bundle (the self-update path) gets an empty set and still registers, while the same bundle
 * applied twice to the same context does not.
 */

/** Decide whether this context still needs the client registrations. */
export function createApplyGuard(): (ctx: object) => boolean {
  const applied = new WeakSet<object>()
  return ctx => {
    if (applied.has(ctx)) return false
    applied.add(ctx)
    return true
  }
}
