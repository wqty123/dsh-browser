/**
 * Tracks one opaque guest iframe's own position inside the browser's joint session history.
 *
 * Joint `history.length` includes entries owned by the host DSH page and retains the guest's
 * forward branch after a Back step. Comparing `depth` only against `lastDepth` fails when a
 * user goes Back and then navigates to a new page (or calls `history.pushState`): Chromium
 * truncates the forward branch before pushing the new entry, so `history.length` stays equal
 * to (or becomes smaller than) `lastDepth`, leaving Back disabled.
 *
 * Comparing against `baseDepth + index` on genuine forward navigations (and honoring explicit
 * `push` / `pop` / `replace` / `navigationType` hints from the guest runtime) keeps both Back
 * and Forward accurate across branches without ever stepping into the host page's history.
 */
export interface GuestHistoryObservation {
  readonly depth: number
  readonly reason?: string | undefined
  readonly navigationType?: string | undefined
}

export class GuestFrameHistory {
  private baseDepth: number | undefined
  private lastDepth = 1
  private index = 0
  private maxIndex = 0
  private hasCommittedDocument = false
  private documentNavigated = false
  private pendingSteps = 0

  reset(baseDepth: number): void {
    this.baseDepth = Number.isSafeInteger(baseDepth) && baseDepth > 0 ? baseDepth : 1
    this.lastDepth = this.baseDepth
    this.index = 0
    this.maxIndex = 0
    this.hasCommittedDocument = false
    this.documentNavigated = false
    this.pendingSteps = 0
  }

  /** Record that the guest switched to a new document identity after the initial load. */
  noteDocumentChange(): void {
    if (this.hasCommittedDocument) this.documentNavigated = true
  }

  record(observation: GuestHistoryObservation): void {
    const depth = Number.isSafeInteger(observation.depth) && observation.depth > 0 ? observation.depth : 1
    if (this.baseDepth === undefined || depth < this.baseDepth) this.baseDepth = depth
    const base = this.baseDepth
    const reason = observation.reason
    const navType = observation.navigationType
    const navigated = this.documentNavigated
    this.documentNavigated = false
    this.hasCommittedDocument = true

    if (reason === 'push') {
      this.pendingSteps = 0
      this.index = Math.max(this.index + 1, depth - base)
      this.maxIndex = this.index
      this.lastDepth = depth
      return
    }
    if (reason === 'pop' || reason === 'pageshow') {
      if (this.pendingSteps > 0) this.pendingSteps -= 1
      this.lastDepth = depth
      return
    }
    if (reason === 'replace') {
      this.lastDepth = depth
      return
    }

    if (navigated) {
      if (navType === 'back_forward') {
        if (this.pendingSteps > 0) this.pendingSteps -= 1
        this.lastDepth = depth
        return
      }
      if (navType === 'reload') {
        this.lastDepth = depth
        return
      }
      if (navType === undefined && this.pendingSteps > 0) {
        this.pendingSteps -= 1
        this.lastDepth = depth
        return
      }
      // Fresh cross-document navigation: Chromium truncated any forward branch above `index`
      // before pushing the new entry. Only advance when joint history exceeds `base + index`,
      // so `location.replace()` at the tip does not fabricate a Back entry.
      this.pendingSteps = 0
      if (depth > base + this.index) {
        this.index = depth - base
        this.maxIndex = this.index
      }
      this.lastDepth = depth
      return
    }

    if (depth > this.lastDepth) {
      this.index = depth - base
      this.maxIndex = Math.max(this.maxIndex, this.index)
    }
    this.lastDepth = depth
  }

  canStep(delta: number): boolean {
    return delta < 0 ? this.index > 0 : this.index < this.maxIndex
  }

  step(delta: number): boolean {
    if (!this.canStep(delta)) return false
    this.index = Math.max(0, this.index + (delta < 0 ? -1 : 1))
    this.pendingSteps += 1
    return true
  }

  /** Entries this guest iframe itself added, counting the current one; host session history is excluded. */
  depth(): number {
    return this.index + 1
  }

  /** Whether the guest iframe has a forward entry of its own. */
  canGoForward(): boolean {
    return this.index < this.maxIndex
  }
}
