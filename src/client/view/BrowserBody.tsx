/** Common browser chrome; a presentation adapter attaches the page inside its content container. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconLinkOutlineRegular,
  IconRefreshOutlineRegular, Tooltip,
  IconRightUpOutlineRegular,
  SHIELD_OUTLINE_PATH,
  ICON_REGULAR_STROKE,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import type { BrowserInitFailure } from '../browser/initialization.ts'
import { emptyBrowserFrame } from '../browser/BrowserFrame.ts'
import { currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import { resolveOmniboxInput } from '../browser/omnibox.ts'
import { searchEnginePreferences } from '../startpage/model.ts'
import type { StartPageFailure } from '../startpage/model.ts'
import type { BrowserStore } from '../browser/store.ts'
import { EngineSettingsDialog, SearchEngineMenu, ShortcutDialog, StartPage } from './StartPage.tsx'
import { TakeoverBanner } from './TakeoverBanner.tsx'
import { connectBrowserTakeover } from '../browser/takeover-channel.ts'
import type { TakeoverNotice } from '../../takeover-protocol.ts'
import css from './Browser.module.css'

const EMPTY_FRAME = emptyBrowserFrame()

function SandboxPolicyIcon({ sandboxed }: { readonly sandboxed: boolean }): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth={ICON_REGULAR_STROKE} strokeLinejoin="round" />
      {sandboxed
        ? <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor" />
        : <path d="M10.6074 4.40278L8.00975 6.99973L10.6074 9.59739L9.59736 10.6074L6.9997 8.00978L4.40274 10.6074L3.3927 9.59739L5.98966 6.99973L3.3927 4.40278L4.40274 3.39273L6.9997 5.98969L9.59736 3.39273L10.6074 4.40278Z" fill="currentColor" transform="translate(1.2 0.8)" />}
    </svg>
  )
}

/** Browser body props assembled by the tab seat. */
export type BrowserBodyProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<BrowserStore>
  & PropsLocale<'sidebarBrowser'>
  & InjectFace<BrowserInjected>

function useBrowserDraft(url: string | undefined, revision: number): readonly [string, (value: string) => void, () => void] {
  const [edit, setEdit] = useState<{ readonly revision: number; readonly value: string }>()
  return [edit?.revision === revision ? edit.value : url ?? '',
    (value) => { setEdit({ revision, value }) },
    () => { setEdit(undefined) }]
}

/** Render provider-neutral navigation state and optional controls. */
export function BrowserBody(props: BrowserBodyProps): ReactNode {
  const {
    mount, loadUrl, submitInput, restore, goBack, goForward, reload, setSandbox, shortcuts, engines,
    bindAddressFocus, dismissShortcut, useBrowserState, useStartPage, useStore, useTabInfo, useContextMenu, t, sessionId,
  } = props
  const { tab } = useTabInfo()
  const { getTriggerProps } = useContextMenu()
  useEffect(() => tab.actions.bindCommands({ refresh: () => { reload(tab.id) } }), [tab.actions, tab.id, reload])
  const addressRef = useRef<HTMLInputElement>(null)
  useEffect(() => bindAddressFocus(tab.id, () => {
    const input = addressRef.current
    if (input === null) return
    input.focus()
    input.select()
  }), [bindAddressFocus, tab.id])
  const saved = useStore(state => state.byTab[tab.id])
  const initial = useRef(saved)
  const initialUrl = useRef(tab.navigation.params?.url)
  const initialNavigationRevision = useRef(tab.navigation.revision)
  const lastNavigationRevision = useRef(tab.navigation.revision)
  const [initFailure, setInitFailure] = useState<BrowserInitFailure>()
  // Capability fallback: a caller without the receipt API still gets the old
  // initial-URL path, but never a crash when it returns nothing.
  const runNavigate = (tabId: typeof tab.id, request: { url: string; navigationRevision: number }) => {
    const runner = (props as { navigate?: typeof props.navigate }).navigate
    if (runner !== undefined) return runner(tabId, request)
    const outcome = loadUrl(tabId, request.url)
    return outcome ?? { ok: true as const, requestId: '' }
  }
  const viewportId = useId()
  const [mountEpoch, setMountEpoch] = useState(0)
  const [focused, setFocused] = useState(false)
  const [enginesOpen, setEnginesOpen] = useState(false)
  const [engineFailure, setEngineFailure] = useState<StartPageFailure>()
  const state = useBrowserState(tab.id)
  const rootRef = useRef<HTMLDivElement>(null)
  const takeoverCurrent = useRef({ url: '' })
  const [takeover, setTakeover] = useState<{ notice?: TakeoverNotice; error?: boolean }>({})
  const takeoverChannel = useRef<ReturnType<typeof connectBrowserTakeover>>()
  const pageId = props.currentPage?.(tab.id)?.guestId ?? state?.initialization?.guestId
  takeoverCurrent.current.url = state?.frame.target?.url ?? ''
  useEffect(() => {
    if (!pageId) return
    const lifetime = new AbortController()
    takeoverChannel.current = connectBrowserTakeover({ owner: sessionId, tabId: tab.id, pageId,
      current: () => {
        const node = rootRef.current
        return { url: takeoverCurrent.current.url, active: node !== null && (node.checkVisibility?.({ checkVisibilityCSS: true })
          ?? (node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden')) }
      },
      changed: (notice, error) => { setTakeover({ notice, error }) },
    }, lifetime.signal)
    return () => { lifetime.abort(); takeoverChannel.current = undefined }
  }, [sessionId, tab.id, pageId])
  const startPage = useStartPage(value => value)
  const frame = state?.frame ?? EMPTY_FRAME
  const restoreTarget = state === undefined ? currentBrowserTarget(initial.current) : state.restoreTarget
  const target = frame.target ?? restoreTarget
  const [draft, setDraft, resetDraft] = useBrowserDraft(target?.url ?? initialUrl.current, state?.commandRevision ?? 0)

  // A trusted navigation aimed at this tab (from the plugin bridge or another
  // sidebar action) changes the revision without remounting the body. Hand the
  // exact (tab, revision) to the controller; a missing controller is rebuilt
  // from the last committed mount instead of being silently ignored.
  useEffect(() => {
    if (tab.navigation.revision === lastNavigationRevision.current) return
    lastNavigationRevision.current = tab.navigation.revision
    const url = tab.navigation.params?.url
    if (url === undefined || url === '') return
    const outcome = runNavigate(tab.id, { url, navigationRevision: tab.navigation.revision })
    setInitFailure(outcome.ok ? undefined : outcome.reason)
  }, [tab.navigation.revision, tab.navigation.params, tab.id, runNavigate])

  useLayoutEffect(() => {
    const hide = mount({
      tabId: tab.id, sessionId, navigationRevision: initialNavigationRevision.current,
      signal: tab.signal, viewportId, applicationOrigin: window.location.origin,
      initial: initial.current, initialUrl: initialUrl.current,
      openTab: (url) => { tab.actions.openTab('browser', { params: { url }, revealIfOpened: false }) },
    })
    setMountEpoch(value => value + 1)
    return hide
  }, [mount, tab.id, tab.signal, tab.actions, viewportId, props.actions, sessionId])

  const unknown = frame.address === 'unknown'
  const externalUrl = unknown ? undefined : target?.url
  const sandboxed = frame.sandboxEnabled
  const addressShortcut = tab.shortcuts?.find(row => row.id === 'browser.address')
  const failure = state?.addressFailure
  const error = frame.error
  const pageUrl = target?.url ?? ''
  const preview = draft.trim() === '' || draft.trim() === pageUrl
    ? undefined
    : resolveOmniboxInput(draft, {
      defaultSearchEngineId: startPage.defaultSearchEngineId,
      searchEngines: searchEnginePreferences(startPage),
      applicationOrigin: window.location.origin,
    })
  const previewSearchEngineId = preview?.kind === 'resolved' && preview.primary.kind === 'search'
    ? preview.primary.engineId
    : undefined
  const previewEngine = previewSearchEngineId === undefined
    ? undefined
    : startPage.engines.find(engine => engine.id === previewSearchEngineId)
  const alternativeSearch = preview?.kind === 'resolved' && preview.alternative?.kind === 'search'
    ? preview.alternative
    : undefined
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const outcome = submitInput(tab.id, draft)
    if (outcome !== undefined) setInitFailure(outcome.ok ? undefined : outcome.reason)
  }
  const openShortcutUrl = (url: string, mode: 'current' | 'new-tab'): void => {
    if (mode === 'new-tab') tab.actions.openTab('browser', { params: { url }, revealIfOpened: false })
    else {
      const outcome = loadUrl(tab.id, url)
      if (outcome !== undefined) setInitFailure(outcome.ok ? undefined : outcome.reason)
    }
  }
  // A rejected address already has its precise `error.*` notice; showing the
  // generic lifecycle failure next to it would duplicate the same event.
  const reportedInitFailure = initFailure
    ?? (state?.initialization?.stage === 'failed' ? state.initialization.reason : undefined)
  // `addressFailure` and `frame.error` already render these two precisely.
  const activeInitFailure = reportedInitFailure === 'navigation-rejected' || reportedInitFailure === 'navigation-failed'
    ? undefined
    : reportedInitFailure

  return (
    <div className={css.root} ref={rootRef}>
      <div
        style={{ display: 'contents' }}
        onBlur={(event) => {
          // Keep the hint — and its "search this" button — mounted while Tab
          // moves focus between the address bar and the hint container. Only
          // clear once focus leaves this whole toolbar/hint container.
          const next = event.relatedTarget as Node | null
          if (next !== null && event.currentTarget.contains(next)) return
          setFocused(false)
        }}
      >
      <TakeoverBanner notice={takeover.notice} error={takeover.error}
        label={t('takeover.waiting', { reason: takeover.notice?.reason ?? '' })}
        done={t('takeover.done')} skip={t('takeover.skip')} failure={t('takeover.failed')}
        answer={outcome => { void takeoverChannel.current?.answer(outcome) }} />
      <form className={css.toolbar} onSubmit={submit}>
        <button type="button" className={css.tool} aria-label={t('back')} title={t('back')} disabled={!frame.canGoBack} onClick={() => { goBack(tab.id) }}><IconChevronLeftOutlineRegular /></button>
        <button type="button" className={css.tool} aria-label={t('forward')} title={t('forward')} disabled={!frame.canGoForward} onClick={() => { goForward(tab.id) }}><IconChevronRightOutlineRegular /></button>
        <Tooltip label={t('reload')} shortcutKeys={tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('reload')} aria-keyshortcuts={tab.refreshShortcut?.aria} disabled={target === undefined || mountEpoch === 0} onClick={() => { reload(tab.id) }}><IconRefreshOutlineRegular /></button>
        </Tooltip>
        <SearchEngineMenu data={startPage} t={t} actions={engines} onManage={() => { setEnginesOpen(true) }}
          onFailure={setEngineFailure} />
        <div className={css.addressBox}>
          <input
            ref={addressRef}
            className={[css.address, unknown ? css.addressUnknown : ''].join(' ')}
            value={draft}
            aria-label={t('address.placeholder')}
            aria-keyshortcuts={addressShortcut?.aria}
            title={addressShortcut === undefined ? undefined : t('address.shortcut', { keys: addressShortcut.keys.join(' ') })}
            placeholder={t('address.placeholder')}
            spellCheck={false}
            onChange={(event) => { setDraft(event.currentTarget.value) }}
            onFocus={() => { setFocused(true) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                resetDraft()
                event.currentTarget.blur()
                return
              }
              // oxlint-disable-next-line typescript/no-deprecated -- IME 229 covers engines without isComposing.
              if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault()
            }}
          />
          {unknown && <span className={css.addressChanged}>{t('address.changed')}</span>}
          <button type="submit" className={[css.tool, css.addressGo].join(' ')} aria-label={t('go')} title={t('go')}><IconLinkOutlineRegular /></button>
        </div>
        <button type="button" className={css.tool} aria-label={t('external')} title={t('external')} disabled={externalUrl === undefined}
          onClick={externalUrl === undefined ? undefined : () => { window.open(externalUrl, '_blank', 'noopener,noreferrer') }}
        ><IconRightUpOutlineRegular size={14} /></button>
        {sandboxed !== undefined && <button
          type="button"
          className={[css.tool, sandboxed ? '' : css.sandboxOff].join(' ')}
          aria-label={t(sandboxed ? 'sandbox.disable' : 'sandbox.enable')}
          title={t(sandboxed ? 'sandbox.disable' : 'sandbox.enable')}
          aria-pressed={!sandboxed}
          onClick={() => { setSandbox(tab.id, !sandboxed) }}
        ><SandboxPolicyIcon sandboxed={sandboxed} /></button>}
      </form>
      {focused && preview?.kind === 'resolved' && (
        <div className={css.addressHint} role="status">
          <span className={css.addressHintText}>
            {preview.primary.kind === 'search'
              ? t('address.searchHint', { engine: previewEngine?.label ?? preview.primary.engineId, query: preview.primary.query })
              : t('address.openHint', { url: preview.primary.target.url })}
          </span>
          {alternativeSearch !== undefined && (
            <button type="button" className={css.addressHintAction}
              onMouseDown={(event) => { event.preventDefault() }}
              onClick={() => { loadUrl(tab.id, alternativeSearch.target.url) }}>
              {t('address.searchThis')}
            </button>
          )}
        </div>
      )}
      {focused && preview?.kind === 'refused' && preview.reason !== 'empty' && (
        <div className={css.addressHint} role="alert">
          <span className={css.addressHintError}>{t(`error.${preview.reason}`)}</span>
        </div>
      )}
      </div>
      {sandboxed === false && <div className={css.sandboxWarning} role="status">{t('sandbox.warning')}</div>}
      {error !== undefined && <div className={css.failure} role="status">{error.code !== undefined && error.description !== undefined
        ? t('load.failed.detail', { code: String(error.code), description: error.description })
        : t('load.failed')}</div>}
      {failure !== undefined && <div className={css.failure} role="alert">{t(`error.${failure}`)}</div>}
      {activeInitFailure !== undefined && (
        <div className={css.failure} role="alert" data-init-failure={activeInitFailure}>
          {t(`init.failed.${activeInitFailure}`)}
        </div>
      )}
      {engineFailure !== undefined && <div className={css.failure} role="alert">{t(`error.${engineFailure}`)}</div>}
      <div className={css.content} aria-busy={frame.loading}>
        <div id={viewportId} className={css.viewport} aria-label={t('type.label')} />
        {restoreTarget !== undefined && <section className={css.restore} aria-label={t('restore.previous')}>
          <p className={css.restoreLabel}>{t('restore.previous')}</p>
          <p className={css.restoreTitle}>{restoreTarget.title}</p>
          <p className={css.restoreUrl}>{restoreTarget.url}</p>
          <Button variant="primary" size="sm" disabled={mountEpoch === 0} onClick={() => { restore(tab.id) }}>
            {t('restore.action')}
          </Button>
        </section>}
        {restoreTarget === undefined && target === undefined && !frame.loading && error === undefined && (
          startPage.status === 'ready'
            ? <StartPage data={startPage} t={t} actions={shortcuts} open={openShortcutUrl}
              sessionId={sessionId} tabId={tab.id} getTriggerProps={getTriggerProps} />
            : <div className={css.placeholder}>
              <div className={css.start}>{t(startPage.status === 'loading' ? 'startpage.loading' : 'start')}</div>
            </div>
        )}
        {restoreTarget === undefined && frame.loading && error === undefined && <div className={css.placeholder}>
          <div className={css.start}>{t('loading')}</div>
        </div>}
      </div>
      {unknown && <p className={css.limit}>{t('address.unknown')}</p>}
      <EngineSettingsDialog open={enginesOpen} data={startPage} t={t} actions={engines}
        onClose={() => { setEnginesOpen(false) }} />
      <ShortcutDialog open={state?.shortcutDraft !== undefined} shortcut={undefined} seed={state?.shortcutDraft}
        t={t} actions={shortcuts} onClose={() => { dismissShortcut(tab.id) }} />
    </div>
  )
}
