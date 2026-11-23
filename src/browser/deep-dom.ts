/**
 * Page-side DOM traversal shared by every page script that looks elements up.
 *
 * Browser Use reads into same-origin iframes and open shadow roots; a lookup that only asks
 * `document` misses what the snapshot just listed. Inject {@link DEEP_DOM_SOURCE} at the top of a
 * page script, then use `__dshRoots()`, `__dshQuery(selector)` and `__dshQueryAll(selector)`.
 * Cross-origin frames and closed shadow roots stay opaque, as the browser requires.
 * @module dsh-browser/browser/deep-dom
 */

export const DEEP_DOM_SOURCE = `
const __dshRoots = (start) => {
  const roots = []
  const seen = new Set()
  const visit = (root) => {
    if (!root || seen.has(root)) return
    seen.add(root)
    roots.push(root)
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot)
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        try { const d = el.contentDocument; if (d) visit(d) } catch (error) { /* cross-origin */ }
      }
    }
  }
  visit(start || document)
  return roots
}
const __dshQuery = (selector) => {
  const top = document.querySelector(selector)
  if (top) return top
  for (const root of __dshRoots()) { const found = root.querySelector(selector); if (found) return found }
  return null
}
const __dshQueryAll = (selector) => {
  const all = Array.from(document.querySelectorAll(selector))
  for (const root of __dshRoots().slice(1)) all.push(...root.querySelectorAll(selector))
  return all
}
`
