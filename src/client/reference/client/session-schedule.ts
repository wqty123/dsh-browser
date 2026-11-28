/**
 * Collapse the dock's session reports into one switch per tick (issue #127).
 *
 * Two dock components can be alive at once (one per kept-alive conversation), and each one's render
 * reports its own Session. Applying those reports synchronously during render made the runtime notify
 * the other dock, whose render reported back, switching the session again — an unbounded
 * render↔publish cycle that React reports as "Maximum update depth exceeded". Reporting through this
 * scheduler moves the switch out of render and keeps only the last report of a tick.
 */

/**
 * Build the scheduler used by the dock.
 * @param apply - the real switch (normally `runtime.setSession`).
 * @param schedule - how a task is deferred; `queueMicrotask` in the page, a collector in tests.
 * @returns a function to report the Session that is currently being rendered.
 */
export function createSessionScheduler(
  apply: (sessionId: string) => void,
  schedule: (task: () => void) => void,
): (sessionId: string) => void {
  let pending: string | undefined
  let applied: string | undefined
  return sessionId => {
    // Coalesce within a tick, and never re-apply the session already in effect: a dock that renders
    // again for the same conversation must not schedule a switch at all.
    if (pending === sessionId || applied === sessionId) return
    pending = sessionId
    schedule(() => {
      const next = pending
      pending = undefined
      if (next === undefined || next === applied) return
      applied = next
      apply(next)
    })
  }
}
