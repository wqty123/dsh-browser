// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import type {
  BrowserRefCreateElement,
  BrowserRefLinkDomProps,
  BrowserRefButtonProps,
} from '../BrowserRefLink.tsx'
import { BrowserRefLink, buildBrowserRefLinkProps } from '../BrowserRefLink.tsx'
import { encodeBrowserRefUri } from '../scheme.ts'

interface Recorded {
  readonly type: 'button' | 'a'
  readonly dom: BrowserRefLinkDomProps
  readonly children: readonly unknown[]
}

const createElement: BrowserRefCreateElement<Recorded> = (type, dom, ...children) => ({ type, dom, children })

function renderLink(uri: string, available: boolean, onActivate: (uri: string) => void): Recorded {
  return BrowserRefLink({ uri, available, onActivate, createElement })
}

function buttonProps(node: Recorded): BrowserRefButtonProps {
  if (node.dom.type !== 'button') throw new Error('expected the dedicated button branch')
  return node.dom
}

const uri = encodeBrowserRefUri({ referenceId: 'r1', partId: 'p1' })

describe('BrowserRefLink dedicated branch (B48)', () => {
  it('renders a button that never writes a system href', () => {
    const node = renderLink(uri, true, vi.fn())
    expect(node.type).toBe('button')
    const dom = buttonProps(node)
    expect(dom.role).toBe('link')
    expect('href' in dom).toBe(false)
    expect(dom.disabled).toBe(false)
    expect(dom['aria-disabled']).toBe(false)
    expect(dom.children).toBe(uri)
  })

  it('primary click and Enter go to the dedicated handler; middle/modifier/other keys do not', () => {
    const onActivate = vi.fn()
    const dom = buttonProps(renderLink(uri, true, onActivate))
    dom.onClick({ type: 'click', button: 0 })
    dom.onClick({ type: 'click', button: 1 })
    dom.onClick({ type: 'click', button: 0, ctrlKey: true })
    dom.onClick({ type: 'click', button: 0, metaKey: true })
    dom.onKeyDown({ type: 'keydown', key: 'Enter' })
    dom.onKeyDown({ type: 'keydown', key: 'a' })
    dom.onKeyDown({ type: 'keydown', key: 'Enter', shiftKey: true })
    dom.onAuxClick({ type: 'auxclick', button: 1 })
    dom.onMouseDown({ type: 'mousedown', button: 1 })
    expect(onActivate).toHaveBeenCalledTimes(2)
    expect(onActivate).toHaveBeenCalledWith(uri)
  })

  it('preventDefault is called on primary click and Enter', () => {
    const preventDefault = vi.fn()
    const dom = buttonProps(renderLink(uri, true, vi.fn()))
    dom.onClick({ button: 0, preventDefault })
    dom.onKeyDown({ key: 'Enter', preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(2)
  })

  it('unknown ids render unavailable and never activate', () => {
    const onActivate = vi.fn()
    const dom = buttonProps(renderLink(uri, false, onActivate))
    expect(dom.disabled).toBe(true)
    expect(dom['aria-disabled']).toBe(true)
    expect(dom.children).toContain('不可用')
    dom.onClick({ button: 0 })
    dom.onKeyDown({ key: 'Enter' })
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('ordinary HTTP(S) links keep their original <a href> behavior', () => {
    const onActivate = vi.fn()
    const node = BrowserRefLink({
      uri: 'https://example.com/a?b=1', available: true, onActivate, createElement,
    })
    expect(node.type).toBe('a')
    if (node.dom.type !== 'a') throw new Error('expected the passthrough anchor branch')
    expect(node.dom.href).toBe('https://example.com/a?b=1')
    expect('onClick' in node.dom).toBe(false)
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('real jsdom events via @testing-library/react fireEvent match the handler contract', () => {
    const onActivate = vi.fn()
    const dom = buttonProps(renderLink(uri, true, onActivate))
    const button = document.createElement('button')
    button.addEventListener('click', dom.onClick as unknown as EventListener)
    button.addEventListener('keydown', dom.onKeyDown as unknown as EventListener)
    button.addEventListener('auxclick', dom.onAuxClick as unknown as EventListener)
    button.addEventListener('mousedown', dom.onMouseDown as unknown as EventListener)
    document.body.appendChild(button)
    fireEvent.click(button, { button: 0 })
    fireEvent.click(button, { button: 1 })
    fireEvent.click(button, { button: 0, ctrlKey: true })
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(button, { key: 'a' })
    button.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }))
    expect(onActivate).toHaveBeenCalledTimes(2)
    button.remove()
  })
})

describe('buildBrowserRefLinkProps', () => {
  it('passes className/title through and defaults children to the uri', () => {
    const dom = buildBrowserRefLinkProps({
      uri: 'dsh-browser-ref:x', available: true, onActivate: vi.fn(), className: 'ref-link', title: '来源',
    })
    expect(dom.className).toBe('ref-link')
    expect(dom.title).toBe('来源')
    expect(dom.children).toBe('dsh-browser-ref:x')
  })
})
