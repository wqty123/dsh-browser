// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReferenceDock } from '../production/ReferenceDock.tsx'
import { zh } from '../production/reference-labels.ts'
import type { CardViewModel } from '../production/reference-card.ts'

const card: CardViewModel = {
  referenceId: 'ref-one', intentId: 'intent-one', index: 1, state: 'acknowledged',
  source: { host: 'example.com', title: '网页来源', pageUrl: 'https://example.com/', capturedAt: '2026-11-09' },
  contentType: 'text', excerpt: '需要逐字保留的选中文本',
  parts: [{ kind: 'text', value: { partId: 'part-one', text: '需要逐字保留的选中文本', exact: '需要逐字保留的选中文本', prefix: '', suffix: '' } }],
  failures: [], comment: '我的评论', edit: { referenceId: 'ref-one', comment: '我的评论' },
  menu: { exportFormats: [], canImport: false, exportSessionId: 'session-test' },
  removeAction: { referenceId: 'ref-one', intentId: 'intent-one' },
}
const second: CardViewModel = {
  ...card, referenceId: 'ref-two', intentId: 'intent-two', index: 2, comment: '',
  source: { host: 'other.example', title: '另一个来源', pageUrl: 'https://other.example/', capturedAt: '2026-11-09' },
}

const pill = (id: string): HTMLElement => document.querySelector(`.dsh-browser-reference-dock [data-reference-id="${id}"]`) as HTMLElement

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('browser reference composer rail', () => {
  it('leaves the normal composer empty when there are no references', () => {
    const { container } = render(<ReferenceDock sessionId="session-test" cards={[]} actions={{}} labels={zh} notice="offline" />)
    expect(container.textContent).toBe('')
    expect(container.querySelector('button')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps every reference COLLAPSED in its own pill, side by side', () => {
    const { container } = render(<ReferenceDock sessionId="session-test" cards={[card, second]} actions={{}} labels={zh} />)
    // One pill per reference, both in the same wrapping row: a second selection
    // is added beside the first, never folded into an aggregate bar.
    expect(container.querySelectorAll('[data-reference-id]')).toHaveLength(2)
    expect(container.querySelector('[data-count="2"]')).toBeTruthy()
    // The pill summarises the QUOTE (two citations of one page must be
    // distinguishable); the page title lives in the detail card.
    expect(container.textContent).toBe(`1${card.excerpt}2${card.excerpt}`)
    // Collapsed by default: one line of summary text per pill, and none of the
    // captured content is rendered into the composer (no paragraph, image or
    // table nodes), so the rail stays 26 px tall instead of growing with it.
    expect(container.querySelectorAll('p, img, table').length).toBe(0)
    expect(screen.queryByRole('dialog')).toBeNull()
    // No aggregate "N 条引用" control to click.
    expect(screen.queryByRole('button', { name: '2 条引用' })).toBeNull()
  })

  it('opens the detail card on hover, portalled over the composer instead of inside it', () => {
    const { container } = render(<ReferenceDock sessionId="session-test" cards={[card, second]} actions={{}} labels={zh} />)
    fireEvent.mouseEnter(pill('ref-one'))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    // Floating, not inline: the composer keeps its own children, so opening the
    // card can never raise the input box or push the conversation down.
    expect(container.contains(dialog)).toBe(false)
    expect(document.body.contains(dialog)).toBe(true)
    expect(dialog.style.position).toBe('fixed')
    expect(dialog.textContent).toContain(card.excerpt)
    expect(dialog.textContent).toContain('我的评论')
    expect(dialog.textContent).toContain('example.com')
    expect(screen.getByRole('button', { name: '编辑评论' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '移除此条引用' })).toBeTruthy()
  })

  it('stays open while the pointer travels from the pill into the card', () => {
    vi.useFakeTimers()
    render(<ReferenceDock sessionId="session-test" cards={[card]} actions={{}} labels={zh} />)
    fireEvent.mouseEnter(pill('ref-one'))
    fireEvent.mouseLeave(pill('ref-one'))
    fireEvent.mouseEnter(screen.getByRole('dialog'))
    act(() => { vi.advanceTimersByTime(400) })
    expect(screen.queryByRole('dialog')).toBeTruthy()
    // Leaving the card closes it after the same short grace period.
    fireEvent.mouseLeave(screen.getByRole('dialog'))
    act(() => { vi.advanceTimersByTime(400) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('edits the note in the card without changing the captured content', () => {
    const edit = vi.fn()
    render(<ReferenceDock sessionId="session-test" cards={[card]} actions={{ onEditComment: edit }} labels={zh} />)
    fireEvent.mouseEnter(pill('ref-one'))
    fireEvent.click(screen.getByRole('button', { name: '编辑评论' }))
    fireEvent.change(screen.getByRole('textbox', { name: '用户评论' }), { target: { value: '新评论' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(edit).toHaveBeenCalledWith('ref-one', '新评论')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByRole('dialog').textContent).toContain(card.excerpt)
  })

  it('removes a reference immediately and leaves no undo offer behind', () => {
    const remove = vi.fn()
    render(<ReferenceDock sessionId="session-test" cards={[card]} actions={{ onRemove: remove }} labels={zh} />)
    fireEvent.mouseEnter(pill('ref-one'))
    fireEvent.click(screen.getByRole('button', { name: '移除此条引用' }))
    expect(remove).toHaveBeenCalledWith('ref-one')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('已移除引用')).toBeNull()
    expect(screen.queryByRole('button', { name: '撤销' })).toBeNull()
  })

  it('removes the reference whose pill was opened, not the first one', () => {
    const remove = vi.fn()
    render(<ReferenceDock sessionId="session-test" cards={[card, second]} actions={{ onRemove: remove }} labels={zh} />)
    fireEvent.mouseEnter(pill('ref-two'))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('另一个来源')
    fireEvent.click(screen.getByRole('button', { name: '移除此条引用' }))
    expect(remove).toHaveBeenCalledWith('ref-two')
  })

  it('jumps back to the source of the reference whose card is open', () => {
    const reveal = vi.fn()
    render(<ReferenceDock sessionId="session-test" cards={[card, second]} actions={{ onReveal: reveal }} labels={zh} />)
    fireEvent.mouseEnter(pill('ref-two'))
    fireEvent.click(screen.getByRole('button', { name: '回到原文' }))
    expect(reveal).toHaveBeenCalledWith('ref-two')
  })

  it('closes the note editor on Escape without saving, then the card itself', () => {
    const edit = vi.fn()
    render(<ReferenceDock sessionId="session-test" cards={[card]} actions={{ onEditComment: edit }} labels={zh} />)
    fireEvent.mouseEnter(pill('ref-one'))
    fireEvent.click(screen.getByRole('button', { name: '编辑评论' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: '用户评论' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(edit).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
