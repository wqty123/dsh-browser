/**
 * Browser references inside the composer.
 *
 * COLLAPSED BY DEFAULT: every reference is one compact pill (`[1] 标题`) in a
 * single wrapping row. A second selection is added BESIDE the first, so the row
 * grows sideways instead of the composer growing taller, and the box keeps the
 * height the user typed into.
 *
 * Hovering or focusing a pill opens a floating detail card ABOVE it: the
 * captured content in its own shape (paragraphs keep their line breaks, images
 * stay images, tables stay tables), the user's note, and the three actions —
 * edit note, go to source, remove. The card is portalled with fixed positioning
 * and bounded height, so opening it never pushes the input box or the
 * conversation around; it also stays open while the pointer travels from the
 * pill into the card, which is what makes “edit the note” reachable by mouse.
 * Removal is final: the pill disappears and nothing offers to undo it.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconEditOutlineRegular, IconLinkOutlineRegular, IconTrashOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CardActions, CardPart, CardViewModel } from './reference-card.ts'
import type { ReferenceLabels } from './reference-labels.ts'
import css from './ReferenceDock.module.css'

interface Props {
  readonly sessionId: string
  readonly cards: readonly CardViewModel[]
  readonly actions: CardActions
  readonly labels: ReferenceLabels
  readonly notice?: string
}

/** Time the pointer may leave the pill and land on the card without a flicker. */
const CLOSE_DELAY_MS = 180
const PANEL_GAP_PX = 8
const VIEWPORT_PAD_PX = 8
const PANEL_MAX_WIDTH_PX = 460
const PANEL_MAX_HEIGHT_PX = 420


function Part({ part, labels }: { readonly part: CardPart; readonly labels: ReferenceLabels }): ReactNode {
  if (part.kind === 'text') return <p className={css.quote}>{part.value.text}</p>
  if (part.kind === 'image') return part.value.bound
    ? <img className={css.image} src={part.value.thumbnailSrc} alt={part.value.alt ?? labels.image} />
    : <p className={css.secondary} role="status">{labels.loadingImage}</p>
  const rows = new Map<number, typeof part.value.cells[number][]>()
  for (const cell of part.value.cells) rows.set(cell.row, [...rows.get(cell.row) ?? [], cell])
  return <div className={css.tableScroll} tabIndex={0} aria-label={part.value.caption ?? labels.table}>
    <table className={css.table}>
      {part.value.caption !== undefined && <caption>{part.value.caption}</caption>}
      <tbody>{[...rows].sort(([a], [b]) => a - b).map(([row, cells]) => <tr key={row}>
        {cells.sort((a, b) => a.column - b.column).map((cell) => {
          const Cell = cell.role === 'header' ? 'th' : 'td'
          return <Cell key={cell.column} rowSpan={cell.rowSpan} colSpan={cell.columnSpan}>{cell.text}
            {cell.inlineImages.map(image => image.thumbnailSrc === undefined
              ? <span key={image.partId} className={css.secondary}>{labels.loadingImage}</span>
              : <img key={image.partId} className={css.image} src={image.thumbnailSrc} alt={labels.image} />)}
          </Cell>
        })}
      </tr>)}</tbody>
    </table>
  </div>
}

/** Presentation receives only data and callbacks; delivery and sending stay in the runtime. */
export function ReferenceDock({ sessionId, cards, actions, labels, notice }: Props): ReactNode {
  const [openId, setOpenId] = useState<string>()
  /** A click pins the card open so a touch user (and the note editor) keeps it. */
  const [pinned, setPinned] = useState(false)
  const [edit, setEdit] = useState<{ id: string; value: string }>()
  const chips = useRef(new Map<string, HTMLButtonElement>())
  const panel = useRef<HTMLDivElement | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = useIdSafe()

  const active = useMemo(() => cards.find(card => card.referenceId === openId), [cards, openId])

  const clearTimer = useCallback(() => {
    if (closeTimer.current !== undefined) { clearTimeout(closeTimer.current); closeTimer.current = undefined }
  }, [])

  const open = useCallback((referenceId: string) => {
    clearTimer()
    setOpenId(referenceId)
  }, [clearTimer])

  const scheduleClose = useCallback(() => {
    if (pinned) return
    clearTimer()
    closeTimer.current = setTimeout(() => {
      closeTimer.current = undefined
      setOpenId(undefined)
      setEdit(undefined)
    }, CLOSE_DELAY_MS)
  }, [clearTimer, pinned])

  const close = useCallback(() => {
    clearTimer()
    setPinned(false)
    setOpenId(undefined)
    setEdit(undefined)
  }, [clearTimer])

  useEffect(() => () => { clearTimer() }, [clearTimer])

  // The card floats over the composer instead of living in it. Placement is written STRAIGHT TO THE
  // NODE: routing a measurement back through `setState` re-renders the card, and a render that can
  // change measured geometry is exactly the measure→render→measure cycle that ends in
  // "ResizeObserver loop completed with undelivered notifications". A `position: fixed` node cannot
  // feed back into the layout it measured, so writing its style is final — no state, no second pass.
  useLayoutEffect(() => {
    const node = panel.current
    if (openId === undefined || node === null) return
    const measure = (): void => {
      const anchor = chips.current.get(openId)
      if (anchor === undefined) return
      const rect = anchor.getBoundingClientRect()
      // A zero box means the pill is not laid out yet (or the host hides the composer). Fall back near
      // the bottom-left corner so the card still renders rather than leaving the reference with no detail.
      const laidOut = rect.width !== 0 || rect.height !== 0
      const anchorTop = laidOut ? rect.top : window.innerHeight - 96
      const anchorLeft = laidOut ? rect.left : VIEWPORT_PAD_PX
      const width = Math.max(240, Math.min(PANEL_MAX_WIDTH_PX, window.innerWidth - VIEWPORT_PAD_PX * 2))
      const left = Math.min(Math.max(VIEWPORT_PAD_PX, anchorLeft), window.innerWidth - width - VIEWPORT_PAD_PX)
      // Anchored by its BOTTOM edge so the card grows upward: the composer sits at the bottom of the
      // window, a top-anchored card would open off-screen.
      const bottom = Math.max(VIEWPORT_PAD_PX, window.innerHeight - anchorTop + PANEL_GAP_PX)
      const maxHeight = Math.min(PANEL_MAX_HEIGHT_PX, Math.max(140, anchorTop - VIEWPORT_PAD_PX * 2))
      node.style.left = `${left}px`
      node.style.bottom = `${bottom}px`
      node.style.width = `${width}px`
      node.style.maxHeight = `${maxHeight}px`
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [openId, cards.length])

  useEffect(() => {
    if (openId === undefined) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (edit !== undefined) { setEdit(undefined); return }
      close()
    }
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (panel.current?.contains(target) === true) return
      for (const chip of chips.current.values()) if (chip.contains(target)) return
      close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onPointerDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPointerDown)
    }
  }, [openId, edit, close])

  const save = (): void => {
    if (edit === undefined) return
    actions.onEditComment?.(edit.id, edit.value)
    setEdit(undefined)
  }

  // Nothing to draw: render NOTHING rather than an empty wrapper. The host seat
  // is a flex row inside the composer card, and a zero-height child would still
  // defeat the row's `:empty` collapse (and its -4px pull on the text surface).
  // Never return null when empty: this component is the ONLY place the host's input face is handed to
  // the runtime (`noteDockProps`), and the runtime needs that face to append a card. Returning null
  // made it a chicken-and-egg loop — no cards, so no face, so no card could ever be appended, and the
  // reference stayed a pending delivery forever. The empty host is invisible (the stylesheet hides an
  // empty `.dock`), so nothing is drawn until a card exists.
  if (cards.length === 0 && notice === undefined) {
    return <div className={`dsh-browser-reference-dock ${css.dock}`} data-session={sessionId} data-cards={0} data-dock-build="0.7.15" />
  }

  return <div className={`dsh-browser-reference-dock ${css.dock}`} data-session={sessionId} data-cards={cards.length} data-dock-build="0.7.15">
    {cards.length > 0 && <div className={css.rail} role="group" aria-label={labels.count} data-count={cards.length}
      data-pending={cards.some(card => card.state !== 'acknowledged') ? 'yes' : 'no'}>
      {cards.map(card => <button
        key={card.referenceId}
        ref={(node) => {
          if (node === null) chips.current.delete(card.referenceId)
          else chips.current.set(card.referenceId, node)
        }}
        type="button"
        className={css.chip}
        data-reference-id={card.referenceId}
        data-index={card.index}
        data-has-note={card.comment !== undefined && card.comment !== '' ? 'yes' : 'no'}
        aria-haspopup="dialog"
        aria-expanded={openId === card.referenceId}
        aria-controls={openId === card.referenceId ? `${id}-${card.index}` : undefined}
        onMouseEnter={() => { open(card.referenceId) }}
        onMouseLeave={scheduleClose}
        onFocus={() => { open(card.referenceId) }}
        onBlur={() => { if (!pinned) scheduleClose() }}
        onClick={() => {
          // Click pins the card (touch has no hover); a second click releases it.
          if (openId === card.referenceId && pinned) { close(); return }
          setPinned(true)
          open(card.referenceId)
        }}
      >
        <span className={css.badge} aria-hidden>{card.index}</span>
        <span className={css.label}>{card.excerpt || card.source.title || card.source.host}</span>
        {/* 这个位置原来是装饰性灰点：直接换成可点的删除键（交叉线由 CSS 画，避免字形缺失渲染成圆点）。 */}
        <span
          role="button"
          tabIndex={0}
          className={css.chipRemove}
          aria-label={labels.removeDraft}
          title={labels.removeDraft}
          data-chip-remove={card.referenceId}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            actions.onRemove?.(card.referenceId)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            event.stopPropagation()
            actions.onRemove?.(card.referenceId)
          }}
        >
          {/* 叉用内联 SVG 画：不依赖字体字形，也不依赖 CSS 伪元素（两者都曾导致它不可见）。 */}
          <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true" focusable="false">
            <path d="M1 1 L8 8 M8 1 L1 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
          </svg>
        </span>

      </button>)}
    </div>}

    {active !== undefined && typeof document !== 'undefined' && createPortal(
      <div
        id={`${id}-${active.index}`}
        ref={node => { panel.current = node }}
        className={css.panel}
        role="dialog"
        aria-label={`${active.index}. ${active.source.title || active.source.host}`}
        // `position: fixed` is also in the stylesheet; inline keeps the card out of the
        // composer's flow even if the stylesheet has not loaded yet. Left/bottom/width/maxHeight
        // are written by the layout effect above, directly on this node.
        style={{ position: 'fixed' }}
        // The pointer may travel from the pill into the card: crossing the gap
        // must not close it, or the note editor is unreachable by mouse.
        onMouseEnter={() => { clearTimer() }}
        onMouseLeave={scheduleClose}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}
      >
        <div className={css.head}>
          <span className={css.badge} aria-hidden>{active.index}</span>
          <div className={css.heading}>
            <span className={css.title}>{active.source.title || active.source.host}</span>
            <span className={css.host}>{active.source.host}</span>
          </div>
          <div className={css.tools}>
            <Tooltip label={labels.edit} portal><button type="button" aria-label={labels.edit} className={css.icon}
              aria-pressed={edit?.id === active.referenceId}
              onClick={() => {
                setPinned(true)
                setEdit(previous => previous?.id === active.referenceId
                  ? undefined
                  : { id: active.referenceId, value: active.comment ?? '' })
              }}><IconEditOutlineRegular size={14} /></button></Tooltip>
            <Tooltip label={labels.remove} portal><button type="button" aria-label={labels.remove} className={css.icon}
              onClick={() => { close(); actions.onRemove?.(active.referenceId) }}><IconTrashOutlineRegular size={14} /></button></Tooltip>
          </div>
        </div>
        <div className={css.parts}>{active.parts.map((part, index) => <Part key={`${part.kind}:${index}`} part={part} labels={labels} />)}</div>
        {active.failures.length > 0 && <p className={css.notice} role="status">{labels.partial}</p>}
        {edit?.id === active.referenceId ? <div className={css.editor}>
          <label htmlFor={`${id}-${active.index}-note`}>{labels.comment}</label>
          <textarea id={`${id}-${active.index}-note`} value={edit.value} rows={2} placeholder={labels.optional} autoFocus
            onChange={(event) => { setEdit({ id: active.referenceId, value: event.currentTarget.value }) }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); save() }
              // First Escape leaves the editor; the card stays open (a second one closes it).
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEdit(undefined) }
            }} />
          <div className={css.editorActions}><button type="button" onClick={() => { setEdit(undefined) }}>{labels.cancel}</button><button type="button" onClick={save}>{labels.save}</button></div>
        </div> : active.comment !== undefined && active.comment !== ''
          ? <div className={css.comment}><span className={css.secondary}>{labels.comment}</span><p>{active.comment}</p></div>
          : null}
        <button type="button" className={css.source} title={active.source.pageUrl} onClick={() => { actions.onReveal?.(active.referenceId) }}>
          <IconLinkOutlineRegular size={12} /><span>{labels.reveal}</span>
        </button>
      </div>,
      document.body,
    )}

    {cards.length > 0 && notice !== undefined && <p className={css.status} role="status">{notice}</p>}
  </div>
}

/** `useId` is React 18-only; the bundle also loads in hosts that pin 17. */
function useIdSafe(): string {
  const [value] = useState(() => `dsh-ref-${Math.random().toString(36).slice(2, 9)}`)
  return value
}
