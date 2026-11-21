/**
 * Intercepts canonical browser-reference anchors emitted by markdown renderers.
 * It updates only link attributes, leaving React-owned text nodes intact.
 * User-message markers are parsed separately by the registered user-text rule.
 * Primary activation invokes the runtime revealer; modified and auxiliary
 * clicks suppress custom-scheme navigation. Ordinary HTTP(S) links retain
 * their host behavior.
 */
import { parseBrowserRefUri } from '../scheme.ts'

/** Only canonical browser-reference destinations are intercepted. */
export const REPLY_LINK_SELECTOR = 'a[href^="dsh-browser-ref:"]'
/** Attribute used for styling / diagnostic queries in the live DOM. */
export const REPLY_LINK_STATE_ATTR = 'data-dsh-browser-ref'
export const REPLY_LINK_TITLE_AVAILABLE = '回到网页原文'
export const REPLY_LINK_TITLE_UNAVAILABLE = '这条引用已不在当前会话中，无法回到原文'

export type ReplyLinkDecoration = 'available' | 'unavailable' | 'invalid'

export interface ReplyLinkBridgeOptions {
  /** Host document; omit in a non-DOM host (unit tests / SSR). */
  readonly doc?: Document
  /** Whether this reference can be revealed in the current conversation. */
  readonly isAvailable: (uri: string) => boolean
  /** Primary activation; the runtime decides the outcome and shows feedback. */
  readonly activate: (uri: string) => void
  readonly mountCard?: (uri: string, anchor: HTMLElement) => (() => void) | undefined
}

export interface ReplyLinkBridge {
  readonly installed: boolean
  /** Decorate every matching anchor in a subtree; returns the number decorated. */
  scan(root?: ParentNode): number
  dispose(): void
}

interface ClosestElement {
  closest?: (selector: string) => Element | null
  matches?: (selector: string) => boolean
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
}

/** Compute the decoration for one href WITHOUT touching the DOM. */
function decorationFor(uri: string, isAvailable: (uri: string) => boolean): ReplyLinkDecoration {
  if (parseBrowserRefUri(uri) === undefined) return 'invalid'
  return isAvailable(uri) ? 'available' : 'unavailable'
}

/** Write only OUR attributes; a host-provided tooltip is never overwritten. */
function writeDecoration(anchor: ClosestElement, decoration: Exclude<ReplyLinkDecoration, 'invalid'>): void {
  anchor.setAttribute(REPLY_LINK_STATE_ATTR, decoration)
  anchor.setAttribute('aria-disabled', decoration === 'available' ? 'false' : 'true')
  if ((anchor.getAttribute('title') ?? '') === '') {
    anchor.setAttribute('title', decoration === 'available' ? REPLY_LINK_TITLE_AVAILABLE : REPLY_LINK_TITLE_UNAVAILABLE)
  }
}

function queryAll(root: ParentNode): readonly Element[] {
  return Array.from(root.querySelectorAll(REPLY_LINK_SELECTOR))
}

/**
 * Install the bridge. Returns a no-op handle when there is no DOM, so the
 * assembly can call it unconditionally.
 */
export function installReplyLinkBridge(options: ReplyLinkBridgeOptions): ReplyLinkBridge {
  const doc = options.doc ?? (typeof document === 'undefined' ? undefined : document)
  if (doc === undefined) {
    return { installed: false, scan: () => 0, dispose: () => {} }
  }
  // A WeakSet plus a per-node fingerprint avoids re-writing the same
  // attributes for an anchor that was already decorated (an O(N^2) storm when
  // a streamed batch is scanned repeatedly). The fingerprint includes the href
  // and availability, so a CHANGED href (or a session switch) is decorated again.
  const decorated = new WeakSet<Element>()
  const decoratedKey = new WeakMap<Element, string>()

  const decorateOne = (anchor: Element): ReplyLinkDecoration => {
    const typed = anchor as unknown as ClosestElement
    const uri = typed.getAttribute('href') ?? ''
    const decoration = decorationFor(uri, options.isAvailable)
    if (decoration === 'invalid') {
      decorated.delete(anchor)
      decoratedKey.delete(anchor)
      return decoration
    }
    const key = `${uri}\u0000${decoration}`
    if (decorated.has(anchor) && decoratedKey.get(anchor) === key) return decoration
    writeDecoration(typed, decoration)
    decorated.add(anchor)
    decoratedKey.set(anchor, key)
    return decoration
  }

  const scan = (root: ParentNode = doc): number => {
    let count = 0
    const self = root as ParentNode & ClosestElement
    if (typeof self.matches === 'function' && typeof self.getAttribute === 'function'
      && self.matches(REPLY_LINK_SELECTOR) && decorateOne(root as Element) !== 'invalid') count += 1
    for (const anchor of queryAll(root)) {
      if (decorateOne(anchor) !== 'invalid') count += 1
    }
    return count
  }

  const onClick = (event: Event): void => {
    if (event.defaultPrevented) return
    const typed = event as MouseEvent
    const target = typed.target as (Element & ClosestElement) | null
    const anchor = target?.closest(REPLY_LINK_SELECTOR) ?? null
    if (anchor === null) return
    const uri = anchor.getAttribute('href') ?? ''
    // A custom scheme must never reach the browser's navigation/protocol layer,
    // even for a malformed destination we cannot activate.
    typed.preventDefault()
    if (parseBrowserRefUri(uri) === undefined) return
    if (typed.button !== 0 || typed.ctrlKey || typed.metaKey || typed.shiftKey || typed.altKey) return
    typed.stopPropagation()
    options.activate(uri)
  }

  let activeAnchor: Element | undefined
  let unmountCard: (() => void) | undefined
  const clearCard = (): void => {
    const unmount = unmountCard
    activeAnchor = undefined
    unmountCard = undefined
    unmount?.()
  }
  const onOver = (event: Event): void => {
    const target = event.target as Element | null
    const anchor = target && typeof (target as ClosestElement).closest === 'function'
      ? (target as ClosestElement).closest?.(REPLY_LINK_SELECTOR) ?? null
      : null
    if (anchor === null || anchor === activeAnchor) return
    clearCard()
    activeAnchor = anchor
    unmountCard = options.mountCard?.(anchor.getAttribute('href') ?? '', anchor as HTMLElement)
  }
  const onKeyDown = (event: Event): void => {
    const typed = event as KeyboardEvent
    if (typed.defaultPrevented || (typed.key !== 'Enter' && typed.key !== ' ')) return
    const anchor = (typed.target as Element | null)?.closest?.(REPLY_LINK_SELECTOR)
    if (anchor == null) return
    typed.preventDefault()
    const uri = anchor.getAttribute('href') ?? ''
    if (typed.ctrlKey || typed.metaKey || typed.shiftKey || typed.altKey || parseBrowserRefUri(uri) === undefined) return
    typed.stopPropagation()
    options.activate(uri)
  }
  doc.addEventListener('pointerover', onOver, true)
  doc.addEventListener('focusin', onOver, true)
  doc.addEventListener('keydown', onKeyDown, true)

  doc.addEventListener('click', onClick, true)
  doc.addEventListener('auxclick', onClick, true)
  scan()

  const observer = typeof MutationObserver === 'undefined'
    ? undefined
    : new MutationObserver((records) => {
      if (activeAnchor !== undefined && !activeAnchor.isConnected) clearCard()
      for (const record of records) {
        // Streamed rendering assigns `href` AFTER the anchor already exists in
        // the DOM. An attribute record (filtered to href) is the only way to
        // see that; childList alone never fires for a late attribute write.
        if (record.type === 'attributes') {
          const target = record.target
          if (target === activeAnchor) clearCard()
          if (target.nodeType === 1) {
            const element = target as Element & ClosestElement
            if (typeof element.matches === 'function' && element.matches(REPLY_LINK_SELECTOR)) {
              decorateOne(target as Element)
            }
          }
          continue
        }
        // React reuses a text node and writes a new value into it (streaming /
        // state update): re-decorate only that node, never its parent.
        for (const node of record.addedNodes) {
          // A plain-text host may insert the marker as a bare text node.
          if (node.nodeType !== 1) continue
          const element = node as Element
          const self = element as Element & ClosestElement
          if (typeof self.matches === 'function' && self.matches(REPLY_LINK_SELECTOR)) {
            decorateOne(element)
          }
          scan(element)
        }
      }
    })
  const observeRoot = doc.documentElement
  try {
    observer?.observe(observeRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      // Writing our own state/title/aria attributes must NOT retrigger this
      // observer; only a late `href` assignment should.
      attributeFilter: ['href'],
      // Plain-text user messages (and streamed updates) change text in place.
    })
  } catch { /* non-DOM host */ }

  let disposed = false
  return {
    installed: true,
    scan,
    dispose() {
      if (disposed) return
      disposed = true
      doc.removeEventListener('click', onClick, true)
      doc.removeEventListener('auxclick', onClick, true)
      doc.removeEventListener('pointerover', onOver, true)
      doc.removeEventListener('focusin', onOver, true)
      doc.removeEventListener('keydown', onKeyDown, true)
      clearCard()
      observer?.disconnect()
    },
  }
}
