/**
 * "Is this the same frame state?" — the guard that keeps a publish loop from becoming React #185.
 *
 * WHY THIS EXISTS
 * Every tick of a browser tab calls `publish()`, which hands a freshly built snapshot object to the
 * session store. The store notifies its subscribers on every `set`, the dock re-renders, and a tab
 * whose state did not actually change publishes again — an unbounded publish → render → publish
 * cycle that React reports as "Maximum update depth exceeded" (issue #127).
 *
 * The snapshot is a plain object of scalars plus one `target` descriptor, so "changed" means "a key
 * differs", with the descriptor compared by value.
 */

/** Compare two snapshots by value, so an equal state is not published again. */
export function sameFrameState(left: object, right: object): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    const a = (left as Record<string, unknown>)[key]
    const b = (right as Record<string, unknown>)[key]
    if (a === b) continue
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
      if (JSON.stringify(a) === JSON.stringify(b)) continue
    }
    return false
  }
  return true
}
