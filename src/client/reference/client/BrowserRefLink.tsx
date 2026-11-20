/**
 * Reply-side renderer for `dsh-browser-ref:` links (§15, B48).
 *
 * The dedicated branch renders a <button> that NEVER writes a system `href`:
 * the custom scheme must not be handed to markdown's `sanitizeUrl` or the
 * browser's protocol handler. Primary click and Enter go to an injected
 * handler; middle click, modifier keys and auxclick are explicitly ignored so
 * ordinary link behavior is never hijacked. Unknown ids render as disabled /
 * "unavailable". Ordinary HTTP(S) URLs are passed through as a plain <a> with
 * its href, so their existing behavior is completely unchanged.
 *
 * Space also activates the element, but through the browser's own native button
 * click (verified with real keyboard input in Chrome and Edge); `onKeyDown`
 * handles Enter only, so the element keeps standard button semantics.
 *
 * This module has NO runtime React import: `import type` is erased at transform
 * time and `createElement` is injected through props. That keeps the package
 * testable without installing react (a peer-only dependency), and avoids any
 * dependency on the host markdown internals.
 */
import type { ReactElement } from 'react'
import { isBrowserRefUri } from './scheme.ts'

/** Duck-typed event, compatible with both React synthetic and native DOM events. */
export interface ActivationEventLike {
  readonly type?: string
  readonly button?: number
  readonly key?: string
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly shiftKey?: boolean
  readonly altKey?: boolean
  readonly preventDefault?: () => void
  readonly stopPropagation?: () => void
}

export interface BrowserRefLinkSpec {
  /** Canonical `dsh-browser-ref:...` URI (or a plain URL for passthrough). */
  readonly uri: string
  /** Whether the reference id is known by the host (false → unavailable). */
  readonly available: boolean
  /** Dedicated handler for primary click / Enter. */
  readonly onActivate: (uri: string) => void
  readonly children?: string
  readonly className?: string
  readonly title?: string
}

/** Dedicated <button> props. `href` is forbidden by type, so no system link is written. */
export interface BrowserRefButtonProps {
  readonly type: 'button'
  readonly role: 'link'
  readonly href?: never
  readonly 'aria-disabled': boolean
  readonly disabled: boolean
  readonly className?: string
  readonly title?: string
  readonly children: string
  readonly onClick: (event: ActivationEventLike) => void
  readonly onKeyDown: (event: ActivationEventLike) => void
  readonly onAuxClick: (event: ActivationEventLike) => void
  readonly onMouseDown: (event: ActivationEventLike) => void
}

/** Passthrough <a> props for ordinary HTTP(S) links: behavior is untouched. */
export interface BrowserRefAnchorProps {
  readonly type: 'a'
  readonly href: string
  readonly children: string
  readonly className?: string
}

export type BrowserRefLinkDomProps = BrowserRefButtonProps | BrowserRefAnchorProps

/** Injected element factory (`React.createElement` in production, a stub in tests). */
export type BrowserRefCreateElement<T> = (
  type: 'button' | 'a',
  props: BrowserRefLinkDomProps,
  ...children: readonly unknown[]
) => T

export interface BrowserRefLinkProps<T = ReactElement> extends BrowserRefLinkSpec {
  readonly createElement: BrowserRefCreateElement<T>
}

function hasModifier(event: ActivationEventLike): boolean {
  return event.ctrlKey === true || event.metaKey === true
    || event.shiftKey === true || event.altKey === true
}

/** Build the complete, testable DOM behavior for the dedicated button branch. */
export function buildBrowserRefLinkProps(spec: BrowserRefLinkSpec): BrowserRefButtonProps {
  const usable = spec.available
  const label = spec.children ?? spec.uri

  const activate = (event: ActivationEventLike): void => {
    if (!usable || hasModifier(event)) return
    event.preventDefault?.()
    spec.onActivate(spec.uri)
  }

  return {
    type: 'button',
    role: 'link',
    'aria-disabled': !usable,
    disabled: !usable,
    ...(spec.className === undefined ? {} : { className: spec.className }),
    ...(spec.title === undefined ? {} : { title: spec.title }),
    children: usable ? label : `${label}（来源不可用）`,
    onClick: (event) => {
      // Middle click must not trigger the dedicated handler, and must not be
      // prevented: ordinary middle-click behavior stays intact.
      if (event.button !== undefined && event.button !== 0) return
      activate(event)
    },
    onKeyDown: (event) => {
      if (event.key !== 'Enter') return
      activate(event)
    },
    // Aux/middle activation is explicitly ignored: the dedicated handler is
    // primary-only and must never hijack the browser's own behavior.
    onAuxClick: () => { /* no dedicated activation */ },
    onMouseDown: (event) => {
      if (hasModifier(event) || (event.button !== undefined && event.button !== 0)) {
        // Modifier/middle mousedown is explicitly ignored.
        return
      }
      // Primary mousedown is intentionally inert; onClick performs activation.
    },
  }
}

/** Minimal generic React component; the host injects its element factory. */
export function BrowserRefLink<T>(props: BrowserRefLinkProps<T>): T {
  if (!isBrowserRefUri(props.uri)) {
    // Ordinary HTTP(S) link: keep the host's original anchor behavior untouched.
    const label = props.children ?? props.uri
    return props.createElement('a', { type: 'a', href: props.uri, children: label }, label)
  }
  const dom = buildBrowserRefLinkProps(props)
  return props.createElement('button', dom, dom.children)
}
