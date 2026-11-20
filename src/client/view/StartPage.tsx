/** Browser start page and shared start-page management dialogs. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, FormEvent, MouseEvent, ReactNode } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconEditOutlineRegular,
  IconGlobeOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular, Input,
  LinkIconRegular, Menu, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextMenuBindings } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserStartPageInjected } from '../startpage/binding.ts'
import type { StartPageSnapshot, StartPageWriteResult } from '../startpage/controller.ts'
import type { SearchEngineDraft, ShortcutDraft, StartPageEngineView, StartPageFailure, StartPageShortcutView } from '../startpage/model.ts'
import { MAX_ENGINE_EXTRA_PARAMETERS } from '../startpage/model.ts'
import type { BrowserShortcut } from '../../startpage-settings.ts'
import css from './Browser.module.css'

type Translate = TranslateNS<'sidebarBrowser'>

const UNDO_MS = 8000

interface ShortcutEditor {
  readonly shortcut: StartPageShortcutView | undefined
}

interface RemovedShortcut {
  readonly shortcut: StartPageShortcutView
  readonly index: number
}

/** Props for the start page shown in an empty Browser tab. */
export interface StartPageProps {
  readonly data: StartPageSnapshot
  readonly t: Translate
  readonly actions: BrowserStartPageInjected['shortcuts']
  readonly sessionId: SessionId
  readonly tabId: TabId
  /** DSH menu bindings; absent only in isolated component tests. */
  readonly getTriggerProps?: ContextMenuBindings['getTriggerProps']
  /** @param url - validated shortcut address. @param mode - current tab or a background sidebar tab. */
  readonly open: (url: string, mode: 'current' | 'new-tab') => void
}

function failureText(t: Translate, reason: StartPageFailure): string {
  return t(`error.${reason}`)
}

function ShortcutGlyph({ shortcut }: { readonly shortcut: StartPageShortcutView }): ReactNode {
  if (shortcut.iconKey === 'globe') return <IconGlobeOutlineRegular size={24} />
  if (shortcut.iconKey === 'letter') {
    const initial = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      .segment(shortcut.title.trim()).containing(0)?.segment ?? '?'
    return <span className={css.shortcutLetter} aria-hidden>{initial.toUpperCase()}</span>
  }
  return <LinkIconRegular kind="url" href={shortcut.url} size={24} />
}

/**
 * Render the empty-tab start page: shared shortcuts, add/edit/delete/reorder,
 * and an explicitly undoable delete.
 */
export function StartPage({ data, t, actions, sessionId, tabId, getTriggerProps, open }: StartPageProps): ReactNode {
  const [manage, setManage] = useState(false)
  const [editor, setEditor] = useState<ShortcutEditor>()
  const [removed, setRemoved] = useState<RemovedShortcut>()
  const [notice, setNotice] = useState<string>()
  const [writing, setWriting] = useState(false)
  const [draggingId, setDraggingId] = useState<string>()
  const [localOrder, setLocalOrder] = useState<readonly string[]>()
  const draggingRef = useRef<string | undefined>(undefined)
  const dragOrder = useRef<readonly string[] | undefined>(undefined)

  useEffect(() => {
    if (draggingRef.current === undefined) setLocalOrder(undefined)
  }, [data.shortcuts])

  useEffect(() => {
    if (removed === undefined) return
    const timer = setTimeout(() => { setRemoved(undefined) }, UNDO_MS)
    return () => { clearTimeout(timer) }
  }, [removed])

  const byId = useMemo(() => new Map(data.shortcuts.map(shortcut => [shortcut.id, shortcut] as const)), [data.shortcuts])
  const displayed = (localOrder ?? data.shortcuts.map(shortcut => shortcut.id))
    .flatMap((id) => { const shortcut = byId.get(id); return shortcut === undefined ? [] : [shortcut] })

  const run = async (result: Promise<StartPageWriteResult>, onOk?: () => void): Promise<void> => {
    setWriting(true)
    const settlement = await result
    setWriting(false)
    if (settlement.ok) { setNotice(undefined); onOk?.() } else setNotice(failureText(t, settlement.reason))
  }

  const remove = (shortcut: StartPageShortcutView): void => {
    const index = data.shortcuts.findIndex(entry => entry.id === shortcut.id)
    void run(actions.remove(shortcut.id), () => { setRemoved({ shortcut, index: Math.max(0, index) }) })
  }

  const undo = (): void => {
    if (removed === undefined) return
    const pending = removed
    // `StartPageShortcutView` also carries a validated `target` (and the
    // rendered positions). Writing that view object back into settings would
    // persist UI-only fields into the shared preference section. Restore the
    // exact stored fields instead, and only retire the undo offer AFTER the
    // write succeeded: a failed restore must remain retryable.
    const stored: BrowserShortcut = {
      id: pending.shortcut.id,
      title: pending.shortcut.title,
      url: pending.shortcut.url,
      iconKey: pending.shortcut.iconKey,
    }
    void run(actions.restore(stored, pending.index), () => { setRemoved(undefined) })
  }

  const openShortcut = (event: MouseEvent<HTMLButtonElement>, shortcut: StartPageShortcutView): void => {
    if (manage) { setEditor({ shortcut }); return }
    if (shortcut.target === undefined) return
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      open(shortcut.target.url, 'new-tab')
      return
    }
    open(shortcut.target.url, 'current')
  }

  const dragStart = (event: DragEvent<HTMLDivElement>, shortcut: StartPageShortcutView): void => {
    if (!manage || writing || !data.writable) { event.preventDefault(); return }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', shortcut.id)
    setDraggingId(shortcut.id)
    draggingRef.current = shortcut.id
    dragOrder.current = displayed.map(entry => entry.id)
    setLocalOrder(dragOrder.current)
  }

  const dragOver = (event: DragEvent<HTMLDivElement>, shortcut: StartPageShortcutView): void => {
    if (draggingId === undefined || draggingId === shortcut.id) return
    event.preventDefault()
    const order = [...(dragOrder.current ?? displayed.map(entry => entry.id))]
    const from = order.indexOf(draggingId)
    const to = order.indexOf(shortcut.id)
    if (from === -1 || to === -1) return
    order.splice(from, 1)
    order.splice(to, 0, draggingId)
    dragOrder.current = order
    setLocalOrder(order)
  }

  const dragEnd = (): void => {
    draggingRef.current = undefined
    dragOrder.current = undefined
    setDraggingId(undefined)
    setLocalOrder(undefined)
  }

  const drop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const order = dragOrder.current
    if (draggingRef.current === undefined || order === undefined) return
    const changed = order.some((id, index) => data.shortcuts[index]?.id !== id)
    dragEnd()
    if (changed) void run(actions.reorder(order))
  }

  return (
    <section className={css.startPage} aria-label={t('startpage.title')} aria-busy={writing}>
      <header className={css.startHeader}>
        <h2 className={css.startHeading}>{t('startpage.title')}</h2>
        <div className={css.startTools}>
          <Button variant="ghost" size="sm" icon={<IconPlusOutlineRegular size={14} />}
            disabled={writing || !data.writable}
            onClick={() => { setEditor({ shortcut: undefined }) }}>{t('startpage.add')}</Button>
          <Button variant={manage ? 'outline' : 'ghost'} size="sm" aria-pressed={manage}
            disabled={writing || displayed.length === 0 || !data.writable}
            onClick={() => { setManage(value => !value) }}>{t(manage ? 'startpage.done' : 'startpage.manage')}</Button>
        </div>
      </header>
      {notice !== undefined && <p className={css.startNotice} role="alert">{notice}</p>}
      <div className={css.shortcutGrid}>
        {displayed.map((shortcut, index) => (
          <div
            key={shortcut.id}
            className={[css.shortcutCell, manage ? css.shortcutManaging : '', draggingId === shortcut.id ? css.shortcutDragging : '', shortcut.target === undefined ? css.shortcutInvalid : ''].join(' ')}
            draggable={manage && data.writable && !writing}
            onDragStart={(event) => { dragStart(event, shortcut) }}
            onDragOver={(event) => { dragOver(event, shortcut) }}
            onDrop={drop}
            onDragEnd={dragEnd}
          >
            <button
              type="button"
              className={css.shortcutCard}
              aria-label={shortcut.title}
              title={shortcut.target === undefined ? shortcut.url : shortcut.target.url}
              aria-haspopup={manage ? 'dialog' : undefined}
              disabled={writing || (!manage && shortcut.target === undefined)}
              // In manage mode a left click opens the edit dialog, so binding
              // the shortcut context menu here would contradict aria-haspopup
              // and offer two different actions for the same card.
              {...manage ? {} : getTriggerProps?.(shortcut.target === undefined ? undefined : {
                kind: 'shortcut',
                value: { sessionId, tabId, title: shortcut.title, url: shortcut.target.url },
              })}
              onClick={(event) => { openShortcut(event, shortcut) }}
              onAuxClick={(event) => {
                if (event.button !== 1) return
                event.preventDefault()
                if (manage || shortcut.target === undefined) return
                open(shortcut.target.url, 'new-tab')
              }}
            >
              <span className={css.shortcutIcon}><ShortcutGlyph shortcut={shortcut} /></span>
              <span className={css.shortcutTitle}>{shortcut.title}</span>
            </button>
            {shortcut.target === undefined && (
              <button
                type="button"
                className={css.addressHintError}
                style={{ display: 'block', width: '100%', padding: '0 8px 8px', background: 'none', border: 0,
                  font: 'var(--dsw-font-xxxs-11)', textAlign: 'center', cursor: 'pointer' }}
                disabled={writing || !data.writable}
                title={t('startpage.edit')}
                onClick={() => { setEditor({ shortcut }) }}
              >
                {t('startpage.invalidUrl')}
              </button>
            )}
            {!manage && <Tooltip label={t('startpage.edit')} side="bottom" delayMs={500}>
              <button type="button" className={css.shortcutEdit} aria-label={t('startpage.edit')}
                disabled={writing || !data.writable}
                onClick={() => { setEditor({ shortcut }) }}><IconEditOutlineRegular size={12} /></button>
            </Tooltip>}
            {manage && <div className={css.shortcutManage}>
              <Tooltip label={t('startpage.edit')} side="bottom" delayMs={500}>
                <button type="button" className={css.shortcutManageButton} aria-label={t('startpage.edit')}
                  disabled={writing} onClick={() => { setEditor({ shortcut }) }}><IconEditOutlineRegular size={14} /></button>
              </Tooltip>
              <Tooltip label={t('startpage.moveEarlier')} side="bottom" delayMs={500}>
                <button type="button" className={css.shortcutManageButton} aria-label={t('startpage.moveEarlier')}
                  disabled={writing || index === 0} onClick={() => { void run(actions.move(shortcut.id, -1)) }}>
                  <IconChevronDownOutlineRegular size={14} className={css.rotateUp} />
                </button>
              </Tooltip>
              <Tooltip label={t('startpage.moveLater')} side="bottom" delayMs={500}>
                <button type="button" className={css.shortcutManageButton} aria-label={t('startpage.moveLater')}
                  disabled={writing || index === displayed.length - 1} onClick={() => { void run(actions.move(shortcut.id, 1)) }}>
                  <IconChevronDownOutlineRegular size={14} />
                </button>
              </Tooltip>
              <Tooltip label={t('startpage.delete')} side="bottom" delayMs={500}>
                <button type="button" className={[css.shortcutManageButton, css.danger].join(' ')} aria-label={t('startpage.delete')}
                  disabled={writing} onClick={() => { remove(shortcut) }}><IconTrashOutlineRegular size={14} /></button>
              </Tooltip>
            </div>}
          </div>
        ))}
        {displayed.length === 0 && <button type="button" className={css.addCard} disabled={writing || !data.writable}
          onClick={() => { setEditor({ shortcut: undefined }) }}>
          <IconPlusOutlineRegular size={20} />
          <span>{t('startpage.addTitle')}</span>
        </button>}
      </div>
      {removed !== undefined && <div className={css.undoBar} role="status">
        <span className={css.undoText}>{t('startpage.deleted', { title: removed.shortcut.title })}</span>
        <Button variant="ghost" size="sm" disabled={writing} onClick={undo}>{t('startpage.undo')}</Button>
      </div>}
      <ShortcutDialog
        open={editor !== undefined}
        shortcut={editor?.shortcut}
        t={t}
        actions={actions}
        onClose={() => { setEditor(undefined) }}
        // Closing during a save cannot cancel the write that is already in
        // flight. Say so instead of letting the shortcut appear "from nowhere".
        onLateSuccess={() => { setNotice(t('startpage.lateSuccess')) }}
      />
    </section>
  )
}

/** Props for the shared add/edit shortcut form. */
export interface ShortcutDialogProps {
  readonly open: boolean
  readonly shortcut: StartPageShortcutView | undefined
  /** Prefilled fields from the current page; only for adding. */
  readonly seed?: ShortcutDraft | undefined
  readonly t: Translate
  readonly actions: BrowserStartPageInjected['shortcuts']
  readonly onClose: () => void
  /** A save that finished after the dialog was closed still added the entry. */
  readonly onLateSuccess?: () => void
}

export function ShortcutDialog({ open, shortcut, seed, t, actions, onClose, onLateSuccess }: ShortcutDialogProps): ReactNode {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [iconKey, setIconKey] = useState('')
  const [failure, setFailure] = useState<StartPageFailure>()
  const [busy, setBusy] = useState(false)
  const editGeneration = useRef(0)

  useEffect(() => {
    const generation = ++editGeneration.current
    if (open) {
      setName(shortcut?.title ?? seed?.title ?? '')
      setUrl(shortcut?.url ?? seed?.url ?? '')
      setIconKey(shortcut?.iconKey ?? seed?.iconKey ?? '')
      setFailure(undefined)
      setBusy(false)
    }
    return () => { if (editGeneration.current === generation) editGeneration.current += 1 }
  }, [open, shortcut, seed])

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    if (busy) return
    const generation = editGeneration.current
    setBusy(true)
    const draft: ShortcutDraft = { title: name, url, iconKey }
    const settlement = shortcut === undefined
      ? await actions.add(draft)
      : await actions.update(shortcut.id, draft)
    if (generation !== editGeneration.current) {
      setBusy(false)
      if (settlement.ok) onLateSuccess?.()
      return
    }
    setBusy(false)
    if (settlement.ok) onClose()
    else setFailure(settlement.reason)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t(shortcut === undefined ? 'startpage.addTitle' : 'startpage.editTitle')}
      closeLabel={t('startpage.cancel')}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>{t('startpage.cancel')}</Button>
          <Button variant="primary" size="sm" disabled={busy || url.trim() === ''} onClick={() => { void submit() }}>{t('startpage.save')}</Button>
        </>
      )}
    >
      <form className={css.form} onSubmit={(event) => { void submit(event) }}>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('startpage.url')}</span>
          <Input value={url} spellCheck={false} placeholder={t('startpage.urlPlaceholder')}
            data-modal-autofocus onChange={(event) => { setUrl(event.currentTarget.value) }} />
        </label>
        <label className={css.field}>
          <span className={css.fieldLabel}>{t('startpage.name')}</span>
          <Input value={name} placeholder={t('startpage.namePlaceholder')}
            onChange={(event) => { setName(event.currentTarget.value) }} />
        </label>
        <div className={css.field}>
          <span className={css.fieldLabel}>{t('startpage.icon')}</span>
          <div className={css.iconChoices} role="group" aria-label={t('startpage.icon')}>
            {(['', 'globe', 'letter'] as const).map(choice => (
              <Button key={choice === '' ? 'auto' : choice} size="sm"
                variant={iconKey === choice ? 'primary' : 'ghost'} aria-pressed={iconKey === choice}
                onClick={() => { setIconKey(choice) }}>
                {t(choice === '' ? 'startpage.icon.auto' : `startpage.icon.${choice}`)}
              </Button>
            ))}
          </div>
        </div>
        {failure !== undefined && <p className={css.formError} role="alert">{failureText(t, failure)}</p>}
      </form>
    </Modal>
  )
}

/** Props for the toolbar engine selector. */
export interface SearchEngineMenuProps {
  readonly data: StartPageSnapshot
  readonly t: Translate
  readonly actions: BrowserStartPageInjected['engines']
  readonly onManage: () => void
  readonly onFailure: (reason: StartPageFailure | undefined) => void
}

/** Compact toolbar menu for the default engine; removal stays in the manager. */
export function SearchEngineMenu({ data, t, actions, onManage, onFailure }: SearchEngineMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const selected = data.engines.find(engine => engine.id === data.defaultSearchEngineId && engine.valid)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      align="start"
      side="bottom"
      portal
      selection="check"
      selectedId={selected?.id}
      items={data.engines.filter(engine => engine.valid).map(engine => ({ id: engine.id, label: engine.label,
        disabled: busy || !data.writable }))}
      footer={[{ id: 'manage', label: t('startpage.engine.manage') }]}
      onSelect={(id) => {
        if (id === 'manage') { setOpen(false); onManage(); return }
        if (busy) return
        setBusy(true)
        onFailure(undefined)
        void actions.setDefault(id).then((result) => {
          setBusy(false)
          setOpen(false)
          if (!result.ok) onFailure(result.reason)
        })
      }}
      anchor={(
        <Tooltip label={selected?.label ?? t('startpage.engine')} side="bottom" delayMs={500}>
          <button type="button" className={[css.tool, css.engineTool].join(' ')}
            aria-label={t('startpage.engine')} aria-haspopup="menu" aria-expanded={open}
            onClick={() => { setOpen(value => !value) }}>
            {selected === undefined ? <IconGlobeOutlineRegular size={15} />
              : <LinkIconRegular kind="url" href={selected.homeUrl} size={15} />}
            <IconChevronDownOutlineRegular size={9} />
          </button>
        </Tooltip>
      )}
    />
  )
}

/** Props for the shared engine manager. */
export interface EngineSettingsDialogProps {
  readonly open: boolean
  readonly data: StartPageSnapshot
  readonly t: Translate
  readonly actions: BrowserStartPageInjected['engines']
  readonly onClose: () => void
}

type EngineFormState = { mode: 'add' } | { mode: 'edit'; engine: StartPageEngineView }

function parseExtraParameters(text: string): Readonly<Record<string, string>> | undefined {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const at = trimmed.indexOf('=')
    if (at <= 0) return undefined
    result[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
    if (Object.keys(result).length > MAX_ENGINE_EXTRA_PARAMETERS) return undefined
  }
  return result
}

function formatExtraParameters(parameters: Readonly<Record<string, string>>): string {
  return Object.entries(parameters).map(([name, value]) => `${name}=${value}`).join('\n')
}

/** Manage engines: add, edit, choose the default, and remove with a replacement. */
export function EngineSettingsDialog({ open, data, t, actions, onClose }: EngineSettingsDialogProps): ReactNode {
  const [editor, setEditor] = useState<EngineFormState>()
  const [removing, setRemoving] = useState<StartPageEngineView>()
  const [replacement, setReplacement] = useState('')
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    if (open) return
    setEditor(undefined)
    setRemoving(undefined)
    setNotice(undefined)
  }, [open])

  const run = async (result: Promise<StartPageWriteResult>, onOk?: () => void): Promise<void> => {
    const settlement = await result
    if (settlement.ok) { setNotice(undefined); onOk?.() } else setNotice(failureText(t, settlement.reason))
  }

  const alternatives = data.engines.filter(engine => engine.valid && engine.id !== removing?.id)
  const removeWithReplacement = async (): Promise<void> => {
    if (removing === undefined) return
    await run(actions.remove(removing.id, removing.id === data.defaultSearchEngineId ? replacement : undefined),
      () => { setRemoving(undefined); setReplacement('') })
  }

  return (
    <Modal open={open} onClose={onClose} title={t('startpage.engine.manage')} closeLabel={t('startpage.cancel')}>
      {notice !== undefined && <p className={css.formError} role="alert">{notice}</p>}
      {editor !== undefined
        ? <EngineForm key={editor.mode === 'edit' ? editor.engine.id : 'add'} t={t} actions={actions} editor={editor} onDone={() => { setEditor(undefined) }} />
        : removing !== undefined
          ? (
            <div className={css.form}>
              <p className={css.engineQuestion}>{t('startpage.engine.remove')}: {removing.label}</p>
              {removing.id === data.defaultSearchEngineId && (alternatives.length === 0
                ? <p className={css.formError} role="alert">{t('startpage.engine.last')}</p>
                : (
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('startpage.engine.replacement')}</span>
                    <select className={css.select} value={replacement} onChange={(event) => { setReplacement(event.currentTarget.value) }}>
                      <option value="">{t('startpage.engine.setDefault')}</option>
                      {alternatives.map(engine => <option key={engine.id} value={engine.id}>{engine.label}</option>)}
                    </select>
                  </label>
                ))}
              <div className={css.formActions}>
                <Button variant="ghost" size="sm" onClick={() => { setRemoving(undefined) }}>{t('startpage.cancel')}</Button>
                <Button variant="primary" size="sm" disabled={removing.id === data.defaultSearchEngineId && replacement === ''}
                  onClick={() => { void removeWithReplacement() }}>{t('startpage.engine.remove')}</Button>
              </div>
            </div>
          )
          : (
            <div className={css.engineList}>
              {data.engines.map(engine => (
                <div key={engine.id} className={css.engineRow}>
                  <span className={css.engineName}>{engine.label}</span>
                  {engine.id === data.defaultSearchEngineId && <span className={css.engineDefault}>{t('startpage.engine.default')}</span>}
                  {!engine.valid && <span className={css.engineInvalid}>{t('error.engine-unavailable')}</span>}
                  <span className={css.engineRowTools}>
                    <Button variant="ghost" size="sm" disabled={!engine.valid || engine.id === data.defaultSearchEngineId}
                      onClick={() => { void run(actions.setDefault(engine.id)) }}>{t('startpage.engine.setDefault')}</Button>
                    <Button variant="ghost" size="sm"
                      onClick={() => { setEditor({ mode: 'edit', engine }) }}>{t('startpage.engine.edit')}</Button>
                    <Button variant="ghost" size="sm" disabled={data.engines.length <= 1}
                      onClick={() => { setRemoving(engine); setReplacement(alternatives[0]?.id ?? '') }}>{t('startpage.engine.remove')}</Button>
                  </span>
                </div>
              ))}
              <Button variant="ghost" size="sm" icon={<IconPlusOutlineRegular size={14} />}
                onClick={() => { setEditor({ mode: 'add' }) }}>{t('startpage.engine.add')}</Button>
            </div>
          )}
    </Modal>
  )
}

function EngineForm({ t, actions, editor, onDone }: {
  readonly t: Translate
  readonly actions: BrowserStartPageInjected['engines']
  readonly editor: EngineFormState
  readonly onDone: () => void
}): ReactNode {
  const engine = editor.mode === 'edit' ? editor.engine : undefined
  const [label, setLabel] = useState(engine?.label ?? '')
  const [homeUrl, setHomeUrl] = useState(engine?.homeUrl ?? '')
  const [searchUrl, setSearchUrl] = useState(engine?.searchUrl ?? '')
  const [parameter, setParameter] = useState(engine?.queryParameter ?? 'q')
  const [extra, setExtra] = useState(engine === undefined ? '' : formatExtraParameters(engine.extraParameters))
  const [failure, setFailure] = useState<StartPageFailure>()
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (busy) return
    const extraParameters = parseExtraParameters(extra)
    if (extraParameters === undefined) { setFailure('parameters'); return }
    const draft: SearchEngineDraft = { label, homeUrl, searchUrl, queryParameter: parameter, extraParameters }
    setBusy(true)
    const settlement = editor.mode === 'add'
      ? await actions.add(draft)
      : await actions.update(editor.engine.id, draft)
    setBusy(false)
    if (settlement.ok) onDone()
    else setFailure(settlement.reason)
  }

  return (
    <form className={css.form} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('startpage.engine.name')}</span>
        <Input value={label} data-modal-autofocus onChange={(event) => { setLabel(event.currentTarget.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('startpage.engine.home')}</span>
        <Input value={homeUrl} spellCheck={false} placeholder={t('startpage.urlPlaceholder')}
          onChange={(event) => { setHomeUrl(event.currentTarget.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('startpage.engine.search')}</span>
        <Input value={searchUrl} spellCheck={false} placeholder={t('startpage.urlPlaceholder')}
          onChange={(event) => { setSearchUrl(event.currentTarget.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('startpage.engine.parameter')}</span>
        <Input value={parameter} spellCheck={false} onChange={(event) => { setParameter(event.currentTarget.value) }} />
      </label>
      <label className={css.field}>
        <span className={css.fieldLabel}>{t('startpage.engine.extra')}</span>
        <textarea className={css.textarea} value={extra} spellCheck={false}
          onChange={(event) => { setExtra(event.currentTarget.value) }} />
      </label>
      {failure !== undefined && <p className={css.formError} role="alert">{failureText(t, failure)}</p>}
      <div className={css.formActions}>
        <Button variant="ghost" size="sm" onClick={onDone}>{t('startpage.cancel')}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void submit() }}>{t('startpage.save')}</Button>
      </div>
    </form>
  )
}
