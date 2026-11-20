/**
 * Synthetic pointer feedback for a human watching the tab: an overlay drawn
 * INSIDE the page, never the real system pointer. Its presence is the "the agent
 * has taken over this tab" signal, so it also covers DOM-level operations that
 * move no pointer at all.
 *
 * Implementation notes that matter:
 * - The overlay is `position: fixed` and positioned from viewport coordinates,
 *   which is exactly what the element locator already computes and what
 *   `Input.dispatchMouseEvent` consumes.
 * - All styling is inline and the ripple uses the Web Animations API: a
 *   `<style>` element would be subject to the page's `style-src` CSP, an
 *   injected script is not. Injected page feedback must never be silently
 *   dropped by a strict CSP.
 * - Every call is best-effort: feedback is never allowed to fail an operation.
 * @module dsh-browser/browser-electron/virtual-cursor
 */

/** What the pointer is doing at the reported point. */
export type CursorAction = 'move' | 'click'

/** Element id of the overlay root, stable so repeat calls update one node. */
const CURSOR_ID = '__dsh_agent_cursor__'

/**
 * Where the overlay was last placed, so an unchanged position is not repainted.
 *
 * A single tool call issues several CDP commands (locate, click, cursor), and the
 * cursor is repainted for each one that moves it. Repainting to the same pixel is a
 * wasted round-trip *and* a visible flicker: the transition restarts from the same
 * place, which reads as a stutter rather than as movement.
 */
const lastPlaced = new WeakMap<object, { x: number; y: number; action: CursorAction }>()

/**
 * Whether a paint at this position would change anything on screen.
 * @param handle - the view the overlay belongs to.
 * @param x - viewport x in CSS pixels.
 * @param y - viewport y in CSS pixels.
 * @param action - the action being reported.
 * @param force - paint even when unchanged (a click ripple must always fire).
 * @returns true when the overlay should be painted.
 */
export function cursorNeedsPaint<TView>(handle: TView, x: number, y: number, action: CursorAction, force = false): boolean {
  if (force) return true
  const key = handle as unknown as object
  if (key === null || typeof key !== 'object') return true
  const previous = lastPlaced.get(key)
  return previous === undefined || previous.x !== x || previous.y !== y || previous.action !== action
}

/**
 * The in-page expression that materializes or moves the overlay. Idempotent: the
 * first call creates the nodes, later calls only move them (and pulse).
 * @param x - viewport x in CSS pixels.
 * @param y - viewport y in CSS pixels.
 * @param action - whether to pulse a click ripple at the point.
 * @param label - optional short description of the operation, shown beside the
 *   pointer. The overlay is the only "the agent has taken over this tab" signal, so
 *   saying *what* it is doing is what turns it from a decoration into an account of
 *   the agent's actions that a human can follow without reading the tool log.
 * @returns a self-contained expression that evaluates to `true`.
 */
export function cursorScript(x: number, y: number, action: CursorAction, label?: string): string {
  return `(() => {
  const id = ${JSON.stringify(CURSOR_ID)}
  let root = document.getElementById(id)
  if (!root) {
    root = document.createElement('div')
    root.id = id
    root.setAttribute('aria-hidden', 'true')
    root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;transition:transform 190ms cubic-bezier(.22,.85,.24,1);will-change:transform'
    const svg = '<svg width="22" height="22" viewBox="0 0 22 22" style="position:absolute;left:-2px;top:-2px;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">'
      + '<path d="M4 2 L4 18 L8.4 13.8 L11.2 19.6 L13.8 18.4 L11 12.8 L17 12.6 Z" fill="#ffffff" stroke="#111111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
    const ripple = '<span data-dsh-role="ripple" style="position:absolute;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(64,160,255,.9);opacity:0"></span>'
    // The bubble sits below-right of the pointer tip and is capped in width so a long
    // label cannot cover the page it is describing.
    const bubble = '<span data-dsh-role="bubble" style="position:absolute;left:18px;top:16px;max-width:280px;padding:3px 8px;border-radius:5px;background:rgba(17,17,17,.92);color:#fff;font:12px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;box-shadow:0 1px 3px rgba(0,0,0,.4)"></span>'
    root.innerHTML = svg + ripple + bubble
    ;(document.body || document.documentElement).appendChild(root)
  }
  root.style.transform = 'translate(${x}px, ${y}px)'
  ${action === 'click' ? `const ripple = root.querySelector('[data-dsh-role="ripple"]')
  if (ripple && typeof ripple.animate === 'function') {
    ripple.animate(
      [{ transform: 'scale(.25)', opacity: 0.95 }, { transform: 'scale(1.6)', opacity: 0 }],
      { duration: 550, easing: 'ease-out' },
    )
  }` : ''}
  ${label !== undefined && label !== '' ? `const bubble = root.querySelector('[data-dsh-role="bubble"]')
  if (bubble) {
    bubble.textContent = ${JSON.stringify(label)}
    if (typeof bubble.animate === 'function') {
      // Fade in, hold, fade out: the label is a narration of the action, not a
      // permanent caption, so a stale one never lingers over later work.
      bubble.animate(
        [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'translateY(0)' }, { opacity: 1, offset: 0.6 }, { opacity: 0 }],
        { duration: 2200, easing: 'ease-out', fill: 'forwards' },
      )
    } else {
      bubble.style.opacity = '1'
    }
  }` : ''}
  return true
})()`
}

/**
 * Forget the remembered position for a view.
 *
 * Called when the document is replaced: the overlay lived in the old document and
 * went with it, so the cache would otherwise claim the pointer is already where it
 * needs to be and skip every later paint — the pointer would simply never return
 * after a navigation.
 * @param handle - the view whose cache should be dropped.
 */
export function forgetCursor<TView>(handle: TView): void {
  const key = handle as unknown as object
  if (key !== null && typeof key === 'object') lastPlaced.delete(key)
}

/**
 * Draw (or move) the pointer overlay on one view's page.
 *
 * Fire-and-forget: a page that is mid-navigation, cross-origin-blocked, or
 * otherwise unable to answer must not turn a successful operation into a
 * failure, and the navigation that just committed may still be replacing the
 * document this call would have painted into.
 * @param handle - the view to paint into.
 * @param x - viewport x in CSS pixels.
 * @param y - viewport y in CSS pixels.
 * @param action - whether to pulse a click ripple.
 * @param evaluate - the provider's evaluate bridge (keeps the CDP coupling in one place).
 * @param label - optional short description of the operation, shown beside the pointer.
 */
export function paintCursor<TView>(
  handle: TView,
  x: number,
  y: number,
  action: CursorAction,
  evaluate: (handle: TView, expression: string) => Promise<unknown>,
  label?: string,
  force = false,
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const roundedX = Math.round(x)
  const roundedY = Math.round(y)
  if (!cursorNeedsPaint(handle, roundedX, roundedY, action, force)) return
  const key = handle as unknown as object
  if (key !== null && typeof key === 'object') lastPlaced.set(key, { x: roundedX, y: roundedY, action })
  void evaluate(handle, cursorScript(roundedX, roundedY, action, label)).catch(() => {})
}
