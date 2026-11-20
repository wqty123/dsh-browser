/**
 * Client plugin entry: what the DSH client bundle actually loads.
 *
 * The bundle contract is `export const inject` + `export function apply(ctx,
 * config)`; everything else here exists to supply the two things a YAML row
 * cannot carry:
 *   - `createElement` / `useSyncExternalStore` ← React, a shared platform module.
 *   - `hostInputFor` and the active Session id ← the Session-scope props the
 *     `conversation.input.chips` registration receives on every render
 *     (`session`, `input`, `inputActions`).
 *
 * Both come from inside this package, so no separate `browserReferenceDeps`
 * service has to be published by another package.
 *
 * @module dsh-browser-reference/plugin
 */
import { createElement } from 'react'
import { referenceOwnerKey } from '../../../reference-owner.ts'
import {
  apply as applyProduction,
  type AssemblyConfig,
  type HostContext,
  type HostElementFactory,
} from './production/assembly.ts'
import type { HostInputFace } from './production/draft-adapter.ts'
import type { ProductionRuntime } from './production/runtime.ts'
import type { ReferenceChipInsert } from './types.ts'

/** Slots render the dock, uiConversation parses source links, and locale supplies labels. */
export const inject = ['slots', 'uiConversation', 'locale']

/** The caret span the host editor hands out (`captureInsertion`). */
interface CaretSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

/** `SessionInput.actions`, as handed to a Session-scope slot registration. */
interface SlotInputActions {
  captureInsertion(): CaretSpan
  insertText(text: string, span: CaretSpan): boolean
  persistDraft(): void
  /**
   * Insert a real reference chip into the editor — the same entry point the host's own built-in
   * references use. Going through this instead of a decorator portal is what makes a web reference
   * behave like a native one: the editor owns its content, its draft persistence, its caret guard and
   * its send gating.
   */
  insertReference?(ref: ReferenceChipInsert, span: CaretSpan): boolean
  insertQuote?(text: string, summary?: string): boolean
}

/** Session-scope props the `conversation.input.chips` registration receives. */
interface DockProps {
  readonly sessionId?: string
  readonly session?: { readonly sessionId?: string }
  readonly input?: { readonly draft?: string }
  readonly inputActions?: SlotInputActions
}

/** Per-Session input face, so an async delivery never lands in another draft. */
interface InputBinding {
  readonly sessionId: string
  readonly face: HostInputFace
}

/** The slice of the shell's sidebar service this plugin drives. */
interface SidebarRightService {
  /** Open — or re-aim — one session's `browser` tab at `url`. */
  openTabIn(sessionId: string, kind: string, options?: { readonly params?: { readonly url?: string } }): void
}

interface SidebarScope {
  readonly sidebarRight: SidebarRightService
}

const inertFace: HostInputFace = {
  captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
  insertText: () => false,
  persistDraft: () => { throw new Error('browser reference input is not bound to its conversation') },
  readText: () => '',
}

export function apply(ctx: HostContext, config: AssemblyConfig = {}): ProductionRuntime {
  const bindings = new Map<string, InputBinding>()

  const bindingFor = (sessionId: string): HostInputFace =>
    (sessionId === '' ? undefined : bindings.get(sessionId)?.face) ?? inertFace

  const runtime: ProductionRuntime = applyProduction(ctx, {
    ...config,
    createElement: (config.createElement ?? createElement) as unknown as HostElementFactory,
    hostInputFor: bindingFor,
    onDockProps: (props) => {
      config.onDockProps?.(props)
      const dock = props as DockProps | undefined
      const rawSession = dock?.sessionId ?? dock?.session?.sessionId
      const sessionId = typeof rawSession === 'string' ? referenceOwnerKey(rawSession) : undefined
      const actions = dock?.inputActions
      if (typeof sessionId !== 'string' || sessionId === '') { runtime.setSession(''); return }
      // The visible Session becomes the active one: this is what makes the
      // default entry poll a real conversation instead of the empty id, and it
      // keeps an async delivery bound to the Session it belongs to.
      runtime.setSession(sessionId)
      if (actions === undefined) return
      const readDraft = (): string => {
        const text = dock?.input?.draft
        return typeof text === 'string' ? text : ''
      }
      const face: HostInputFace = {
        captureInsertion: () => actions.captureInsertion(),
        insertText: (span, text) => actions.insertText(text, span),
        persistDraft: () => { actions.persistDraft() },
        // Only used to prove the typed question was not disturbed; the
        // authoritative guard remains the editor's `draftRev` compare-and-set.
        readText: readDraft,
        // 插入引文需要编辑器里有光标。确认按钮是在**侧栏 iframe 里**点的，那一刻焦点不在输入框，
        // `insertQuote` 会静默失败（引文与标记都没进草稿）。插之前先把光标放回编辑器。
        focusEditor: () => {
          try {
            const editor = document.querySelector('[contenteditable="true"]')
            if (editor instanceof HTMLElement) editor.focus()
          } catch {
            // 文档里没有编辑器时无需处理：调用方按失败重试。
          }
        },
        // rc.3 的门径：编辑器原生「原子引用」插入。插进去以后 `InputState.draft` 会展开成引文、
        // `occurrences` 增加，上游发送闸门不再判空——「只有引用也能发」由此成立，且不改上游。
        ...(typeof actions.insertQuote === 'function'
          ? { insertQuote: (text: string, summary?: string) => actions.insertQuote?.(text, summary) === true }
          : {}),
        ...(typeof actions.insertReference === 'function'
          ? { insertReference: (ref: ReferenceChipInsert, span: CaretSpan) => actions.insertReference?.(ref, span) === true }
          : {}),
      }
      const binding: InputBinding = { sessionId, face }
      bindings.set(sessionId, binding)
      // 每次 dock 渲染把当前草稿交给运行时：草稿由非空变空即「消息已被接受」，需要退役本会话的引用，
      // 否则发完消息输入框里还留着上一次的胶囊。
      try { runtime.noteDraft(sessionId, readDraft()) } catch { /* 清理是尽力而为 */ }
    },
  })

  // 侧栏页（同源 guest）需要知道「这条引用属于哪个会话」。旧实现把应答放在设置面板里，于是
  // 只在设置页打开时才成立；现在由客户端半自己应答：页面加载时会 postMessage 询问，这里回当前的
  // 会话 id，并把已知的同源 iframe 一并推一遍（会话切换后已加载的页面也能收到）。
  if (typeof window !== 'undefined') {
    // 页面可能在会话还没绑定好之前就发问（面板先挂载、dock props 后到）。早退会让它永远拿不到
    // 会话 id，引用就落到空会话上——于是「卡片不出现、发送被禁用」。挂起的询问在这里等 id 到手
    // 再回，而不是丢掉。
    const pendingAsks = new Set<{ readonly source: Window; readonly origin: string }>()
    const answer = (ask: { readonly source: Window; readonly origin: string }, sessionId: string): void => {
      try {
        ask.source.postMessage({ type: 'dsh.sidebar.session', sessionId }, ask.origin)
      } catch {
        // 跨源或已卸载的窗口：它不是我们的侧栏页，忽略。
      }
    }
    const respond = (event: MessageEvent): void => {
      const data = event.data as { readonly type?: string } | null
      if (data === null || data.type !== 'dsh.sidebar.session.request') return
      const source = event.source as Window | null
      if (source === null) return
      const ask = { source, origin: event.origin }
      const sessionId = runtime.currentSessionId()
      if (sessionId === '') { pendingAsks.add(ask); return }
      answer(ask, sessionId)
    }
    window.addEventListener('message', respond)
    runtime.onSessionChange((sessionId) => {
      for (const ask of pendingAsks) answer(ask, sessionId)
      pendingAsks.clear()
    })
    ctx.effect(() => () => { window.removeEventListener('message', respond) }, 'ui-browser-reference: guest session responder')
  }

  // "回到原文" must actually go there: the sidebar browser tab is the only place
  // the quote can be shown. The sidebar service is a sibling package, so this is
  // an optional injection — a host without a sidebar keeps the honest "cannot
  // locate" answer instead of pretending.
  // 「回到原文」必须永远成立：侧栏关着就打开、开着就换页、页面不在就新建标签。
  // 旧实现依赖 `ctx.inject(['sidebarRight'], …)` 回调在 apply 期拿到服务；注入不成立时
  // opener 始终是 undefined，点击只会得到「侧栏网页已不在原来的标签页里」。
  // 改为**点击那一刻**从容器里取服务：只要宿主有侧栏，就一定跳得过去。
  runtime.setSourceOpener(async (url) => {
    const sessionId = runtime.currentSessionId()
    if (sessionId === '') throw new Error('reference source requires a conversation')
    const service = ctx.get('sidebarRight') as {
      openTabIn?: (sessionId: string, kind: string, options?: unknown) => void | Promise<unknown>
    } | undefined
    if (typeof service?.openTabIn !== 'function') throw new Error('sidebar tab API is unavailable')
    await service.openTabIn(sessionId, 'browser', { params: { url } })
  })
  return runtime
}
