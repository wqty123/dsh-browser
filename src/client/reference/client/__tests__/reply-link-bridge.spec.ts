// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeBrowserRefUri } from '../scheme.ts'
import {
  installReplyLinkBridge,
  REPLY_LINK_SELECTOR,
  REPLY_LINK_STATE_ATTR,
  REPLY_LINK_TITLE_AVAILABLE,
  REPLY_LINK_TITLE_UNAVAILABLE,
  type ReplyLinkBridge,
} from '../production/reply-link-bridge.ts'

const URI = encodeBrowserRefUri({ referenceId: 'ref-1' })
const OTHER = encodeBrowserRefUri({ referenceId: 'ref-2', partId: 'p2' })
let bridge: ReplyLinkBridge | undefined

function anchor(href: string, label = '来源'): HTMLAnchorElement {
  const node = document.createElement('a')
  node.setAttribute('href', href)
  node.textContent = label
  document.body.appendChild(node)
  return node
}

function fire(node: Element, type: 'click' | 'auxclick', init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })
  node.dispatchEvent(event)
  return event
}

afterEach(() => {
  bridge?.dispose()
  bridge = undefined
  document.body.innerHTML = ''
})

describe('reply link bridge — deployed markdown renderer without the optional hook', () => {
  it('exposes an explicit scan that is safe to call repeatedly', () => {
    const activate = vi.fn()
    bridge = installReplyLinkBridge({ doc: document, isAvailable: () => true, activate })
    anchor(URI)
    expect(bridge.installed).toBe(true)
    expect(bridge.scan()).toBe(1)
    expect(bridge.scan()).toBe(1)
    expect(activate).not.toHaveBeenCalled()
  })

  it('decorates existing links and reports availability', () => {
    const activate = vi.fn()
    bridge = installReplyLinkBridge({ isAvailable: uri => uri === URI, activate })
    const ok = anchor(URI)
    const stale = anchor(OTHER)
    expect(bridge.installed).toBe(true)
    expect(bridge.scan()).toBe(2)
    expect(ok.getAttribute(REPLY_LINK_STATE_ATTR)).toBe('available')
    expect(ok.getAttribute('title')).toBe(REPLY_LINK_TITLE_AVAILABLE)
    expect(ok.getAttribute('aria-disabled')).toBe('false')
    expect(stale.getAttribute(REPLY_LINK_STATE_ATTR)).toBe('unavailable')
    expect(stale.getAttribute('title')).toBe(REPLY_LINK_TITLE_UNAVAILABLE)
    expect(stale.getAttribute('aria-disabled')).toBe('true')
  })

  it('intercepts a primary click instead of navigating the custom scheme', () => {
    const activate = vi.fn()
    bridge = installReplyLinkBridge({ isAvailable: () => true, activate })
    const node = anchor(URI)
    const event = fire(node, 'click')
    expect(event.defaultPrevented).toBe(true)
    expect(activate).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith(URI)
  })

  it('still activates an unavailable link so the runtime can explain why', () => {
    const activate = vi.fn()
    bridge = installReplyLinkBridge({ isAvailable: () => false, activate })
    const event = fire(anchor(URI), 'click')
    expect(event.defaultPrevented).toBe(true)
    expect(activate).toHaveBeenCalledWith(URI)
  })

  it('never hijacks modifier or middle/aux clicks, but blocks their navigation', () => {
    const activate = vi.fn()
    bridge = installReplyLinkBridge({ isAvailable: () => true, activate })
    const ctrl = fire(anchor(URI), 'click', { ctrlKey: true })
    expect(ctrl.defaultPrevented).toBe(true)
    const middle = fire(anchor(OTHER), 'auxclick', { button: 1 })
    expect(middle.defaultPrevented).toBe(true)
    expect(activate).not.toHaveBeenCalled()
  })

  it('blocks malformed destinations without invoking the revealer', () => {
    const activate = vi.fn()
    bridge = installReplyLinkBridge({ isAvailable: () => true, activate })
    const event = fire(anchor('dsh-browser-ref:%ZZ'), 'click')
    expect(event.defaultPrevented).toBe(true)
    expect(activate).not.toHaveBeenCalled()
  })

  it('leaves ordinary http(s) links completely untouched', () => {
    const activate = vi.fn()
    bridge = installReplyLinkBridge({ isAvailable: () => true, activate })
    const link = anchor('https://example.com/page')
    const event = fire(link, 'click')
    expect(event.defaultPrevented).toBe(false)
    expect(link.hasAttribute(REPLY_LINK_STATE_ATTR)).toBe(false)
    expect(activate).not.toHaveBeenCalled()
  })

  it('decorates links added later (streamed messages) through the observer', async () => {
    const activate = vi.fn()
    bridge = installReplyLinkBridge({ isAvailable: () => true, activate })
    const node = anchor(URI)
    expect(node.hasAttribute(REPLY_LINK_STATE_ATTR)).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(node.getAttribute(REPLY_LINK_STATE_ATTR)).toBe('available')
    expect(document.querySelectorAll(`${REPLY_LINK_SELECTOR}[${REPLY_LINK_STATE_ATTR}]`)).toHaveLength(1)
    bridge.dispose()
    bridge = undefined
  })

  it('stops intercepting after dispose', () => {
    const activate = vi.fn()
    const handle = installReplyLinkBridge({ isAvailable: () => true, activate })
    const node = anchor(URI)
    handle.dispose()
    const event = fire(node, 'click')
    expect(event.defaultPrevented).toBe(false)
    expect(activate).not.toHaveBeenCalled()
  })
})
