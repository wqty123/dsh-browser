/**
 * Cordis assembly entry (the `apply(ctx)` the standalone deploy patch loads).
 *
 * The host context is typed STRUCTURALLY: no `@deepseek-ai/cordis` runtime (or
 * type) import, so this package stays self-contained and compilable with
 * `types: []`. The real cordis Context satisfies this shape. `apply` wires:
 *   - an HTTP client over the plugin's loopback surface (host cookie),
 *   - the fully-injected production runtime,
 *   - the dock card into `conversation.input.overlay` (scope: session), i.e. the
 *     pill rail INSIDE the composer card, above the text surface,
 *   - the reply-side link into `conversation.user.text.node`,
 *   - the ordered submission seam exposed as `browserReferenceSubmission`,
 *   - cancellable polling started once and disposed through `ctx.effect`.
 *
 * React renders the dock and feedback through the host's shared platform
 * modules. The conversation service invokes the ordered submission hooks.
 *
 * @module dsh-browser-reference/production/assembly
 */
import { createMemoryStorage, type KeyValueStorage } from '../types.ts'
import {
  createFetchRequest,
  createReferenceHttpClient,
  type RequestLike,
} from './http-transport.ts'
import {
  createCancellationSource,
  type PollerScheduler,
} from './delivery-client.ts'
import {
  createProductionRuntime,
  type AdmitAssetResult,
  type DockSnapshot,
  type ProductionRuntime,
} from './runtime.ts'
import type { HostInputFace } from './draft-adapter.ts'
import type { AssetResponse } from './protocol.ts'
import type { TextPosition } from '../ordered-submission.ts'
import { ensureDockStyles } from './styles.ts'
import { buildBrowserRefLinkProps } from '../BrowserRefLink.tsx'
import { installReplyLinkBridge } from './reply-link-bridge.ts'
import { browserSourceRule } from './user-text-rule.ts'
import { decodeBrowserRefUri } from '../scheme.ts'
import { createElement as element } from 'react'
import { ReferenceDock } from './ReferenceDock.tsx'
import { ReferenceFeedback } from './ReferenceFeedback.tsx'
import { referenceCopy, referenceLabels, REFERENCE_LOCALE, type ReferenceLabels, type ReferenceLabelKey } from './reference-labels.ts'

/** Services this plugin needs from the host context (cordis `inject`). */
export const inject = [
  'slots', 'sessions', 'uiConversation', 'conversation', 'uiSession', 'locale',
] as const

/** Opaque element factory: the host passes its React.createElement. */
export type HostElementFactory = (
  tag: string,
  props: Readonly<Record<string, unknown>>,
  ...children: readonly unknown[]
) => unknown

export interface AssemblyConfig {
  /** Plugin loopback origin, e.g. `http://127.0.0.1:<port>`; '' = same origin. */
  readonly baseUrl?: string
  readonly storage?: KeyValueStorage
  readonly request?: RequestLike
  readonly fetchImpl?: Parameters<typeof createFetchRequest>[0]
  readonly initialSessionId?: string
  readonly hostInputFor?: (sessionId: string) => HostInputFace
  readonly admitAsset?: (asset: AssetResponse, sessionId: string) => Promise<AdmitAssetResult | undefined>
  readonly pollIntervalMs?: number
  readonly scheduler?: PollerScheduler
  readonly textPosition?: TextPosition
  /** Host React.createElement, used for the dock card and reply link. */
  readonly createElement?: HostElementFactory
  /**
   * Host `useSyncExternalStore`. When present the dock subscribes to the
   * runtime and repaints on its own; without it (SSR / unit calls) the dock
   * renders one static snapshot.
   */
  readonly useSnapshot?: SnapshotHook
  /**
   * Receives the dock's session-scope props on every render. The real
   * `conversation.input.chips` registration is handed `inputActions` for its
   * Session; this callback lets the plugin drive the host draft adapter from
   * those actions instead of requiring a separate `browserReferenceDeps`
   * service published by another package.
   */
  readonly onDockProps?: (props: unknown) => void
}

/**
 * Host-specific adapters that CANNOT live in a YAML `config` block (functions).
 * L01 publishes this bundle as a scope service before this plugin is applied,
 * e.g. `ctx.set('browserReferenceDeps', deps)` from ui-conversation's assembly,
 * or passes the same fields through `AssemblyConfig` in tests. Declaration of
 * this service on the host is an L01 wiring action, NOT done in this repo.
 */
export interface BrowserReferenceDeps {
  readonly hostInputFor: (sessionId: string) => HostInputFace
  readonly admitAsset?: (asset: AssetResponse, sessionId: string) => Promise<AdmitAssetResult | undefined>
  readonly createElement?: HostElementFactory
  readonly baseUrl?: string
}

/** Minimal structural face of the cordis Context this plugin touches. */
export interface HostContext {
  get(name: string): unknown
  /**
   * Declare AND publish a service in one call. Cordis rejects a bare `set()`
   * for a name that was never `provide()`d, so this is the primary path; the
   * value stays optional because declaring a name without a value is legal.
   */
  provide?(name: string, value?: unknown): unknown
  /** Fallback for a host that already provided the name. */
  set?(name: string, value: unknown): void
  effect(effect: () => void | (() => void), label: string): void
  readonly slots: {
    inject(name: string, producer: () => Iterable<unknown>): void
    register(registration: unknown, component: unknown): unknown
  }
}

function storageOrDefault(config: AssemblyConfig): KeyValueStorage {
  if (config.storage !== undefined) return config.storage
  if (typeof localStorage !== 'undefined') {
    return {
      getItem: (key) => { try { return localStorage.getItem(key) } catch { return null } },
      // A failed write (quota / disabled storage) MUST surface: the asset store
      // rolls its in-memory binding back and the draft's saveSucceeded becomes
      // false, so the delivery is retried instead of ACKed over a gap.
      setItem: (key, value) => { localStorage.setItem(key, value) },
      removeItem: (key) => { try { localStorage.removeItem(key) } catch { /* storage unavailable */ } },
    }
  }
  return createMemoryStorage()
}

function requestOrDefault(config: AssemblyConfig, cancellationSignal: () => AbortSignal | undefined): RequestLike {
  if (config.request !== undefined) return config.request
  if (config.fetchImpl !== undefined) return createFetchRequest(config.fetchImpl, cancellationSignal)
  if (typeof fetch !== 'undefined') {
    return createFetchRequest(
      (input, init) => fetch(input, init as unknown as RequestInit),
      cancellationSignal,
    )
  }
  throw new Error('ui-browser-reference: no HTTP request implementation provided')
}

/**
 * The registered dock component: it subscribes to the runtime through the
 * host's `useSyncExternalStore`, so a delivery that lands while the user is
 * idle repaints the rail by itself. `snapshot()` is a stable object identity, so
 * an unchanged poll does not re-render — which keeps the note editor's focus and
 * caret intact.
 */
export function createLiveCardDockComponent(
  runtime: ProductionRuntime,
  _createElement: HostElementFactory,
): (props?: unknown) => unknown {
  return (props?: unknown) => {
    // The repaint channel is the HOST's, not ours: the registration publishes
    // `hooks.dockCards` and the slot runtime binds it into a `useDockCards`
    // selector hook rendered by its own React. Calling React's hook here instead
    // failed on the real desktop — the client bundle's `react` is a second module
    // instance, so every hook threw "invalid hook call" and the dock never mounted.
    const face = props as {
      readonly useDockCards?: (selector: (value: DockSnapshot) => DockSnapshot) => DockSnapshot
      readonly noteDockProps?: (props: unknown) => void
      readonly t?: (key: ReferenceLabelKey, args?: { count: number }) => string
    } | undefined
    face?.noteDockProps?.(props)
    const view = face?.useDockCards === undefined ? runtime.snapshot() : face.useDockCards(value => value)
    // 这里曾经在 render 里写 `document.documentElement.dataset.dshChips`，为的是让上游发送闸门能读到
    // 胶囊数量（那需要改上游，已弃）。这条写入现在没有任何读方，却在**每次渲染**时改 `<html>` 的属性：
    // 每次写入都让整篇文档的样式失效 → 布局重算 → 所有 ResizeObserver（上游输入区自适应、主视觉 canvas）
    // 收到通知。它们的回调若再改一次尺寸，浏览器就报
    // `ResizeObserver loop completed with undelivered notifications.`，dev 下直接红屏。
    // 读数走 dock 自己的 snapshot，不再经文档属性传递。
    return element(ReferenceDock, {
      key: view.sessionId,
      sessionId: view.sessionId,
      cards: view.cards,
      labels: referenceLabels(face?.t, view.cards.length),
      actions: {
        onEditComment: (referenceId, comment) => { runtime.setComment(referenceId, comment) },
        onRemove: (referenceId) => { void runtime.removeCard(referenceId) },
        onReveal: (referenceId) => { void runtime.revealReference(referenceId) },
      },
      ...(view.issue === undefined ? {} : { notice: view.issue }),
    })
  }
}

/** The subset of React's `useSyncExternalStore` this package needs. */
export type SnapshotHook = <T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T) => T

/**
 * Build the reply-side link component over the injected element factory.
 *
 * `conversation.user.text.node` is a KEYED slot: the host hands a component
 * `{ node, raw, interactive }`, never a bare `uri`. The installed desktop has
 * no `browser-ref` node rule, so this registration is defensive — it must never
 * render a disabled button over `undefined`. A props shape without a canonical
 * browser-ref URI yields `null`, which keeps the host's raw-text fallback.
 * Live reply-side links are handled by {@link installReplyLinkBridge}.
 */
export function createReplyLinkComponent(
  runtime: ProductionRuntime,
  createElement: HostElementFactory,
): (props: unknown) => unknown {
  return (props: unknown) => {
    const typed = props as {
      readonly uri?: unknown
      readonly children?: string
      readonly raw?: unknown
      readonly node?: { readonly data?: { readonly uri?: unknown; readonly href?: unknown; readonly label?: string } }
      readonly useSourceReferences?: (selector: (value: DockSnapshot) => DockSnapshot) => DockSnapshot
    } | undefined
    typed?.useSourceReferences?.(value => value)
    // A bare `uri` is the documented programmatic shape (and what the existing
    // contract asserts). A keyed-slot owner has neither `uri` nor node data, so
    // it must fall back to the host's raw-text renderer instead of a disabled
    // button over `undefined`.
    const candidate = typed?.uri ?? typed?.node?.data?.uri ?? typed?.node?.data?.href
    if (typeof candidate !== 'string') return null
    // A plain https (or any non-canonical) URL must keep the host's raw-text
    // fallback; without this gate it was rendered as a disabled "来源不可用"
    // dead button. createBrowserRefRenderer applies the same scheme check.
    if (!candidate.startsWith(BROWSER_REF_SCHEME)) return null
    const dom = buildBrowserRefLinkProps(runtime.revealer.linkSpec(candidate, typed?.children ?? typed?.node?.data?.label))
    // This is the path a USER message takes, so it is the one the reader sees after sending: the
    // composer chip is a numbered badge plus a label, and without this split the sent pill is only
    // its outer shell ("胶囊只做了一半").
    const badge = splitSourceLabel(dom.children, createElement)
    return createElement('button', {
      type: dom.type,
      role: dom.role,
      'aria-disabled': dom['aria-disabled'],
      disabled: dom.disabled,
      ...(dom.className === undefined ? {} : { className: dom.className }),
      ...(dom.title === undefined ? {} : { title: dom.title }),
      onClick: dom.onClick,
      onKeyDown: dom.onKeyDown,
      onAuxClick: dom.onAuxClick,
      onMouseDown: dom.onMouseDown,
    }, badge ?? dom.children)
  }
}

/**
 * Global key shared with `ui-primitives/src/markdown/render.tsx`'s
 * `registerBrowserRefRenderer`. The client plugin and the low-level markdown
 * library never import each other; they meet only through this optional hook.
 * When the renderer is absent the markdown renderer keeps its original
 * `sanitizeUrl`/anchor behavior (backwards compatible).
 */
export const BROWSER_REF_RENDERER_GLOBAL = '__DSH_BROWSER_REF_RENDERER__'
/** Live-DOM diagnostic handle for the deployment-compatible link bridge. */
export const REPLY_LINK_BRIDGE_GLOBAL = '__DSH_BROWSER_REF_LINK_BRIDGE__'
export const BROWSER_REF_SCHEME = 'dsh-browser-ref:'

/**
 * Split the reply-side wire label back into the two halves the composer chip shows.
 *
 * `wireSubmissionContent` writes `引用来源 N：标题`; rendering that as one string leaves the sent pill
 * without the numbered badge the dock chip has, which is what "胶囊只做了一半" described.
 * @param label - the wire label.
 * @param createElement - the host's element factory.
 * @returns a badge + label pair, or undefined to keep the plain string.
 */
function splitSourceLabel(label: string | undefined, createElement: HostElementFactory): readonly unknown[] | undefined {
  if (label === undefined) return undefined
  const match = /^\s*(引用来源\s*\d+)\s*[：:]\s*(.*)$/u.exec(label)
  if (match === null) return undefined
  const number = /(\d+)/u.exec(match[1] ?? '')
  return [
    createElement('span', { className: 'dsh-browser-ref-badge', 'aria-hidden': 'true' }, number?.[1] ?? ''),
    createElement('span', { className: 'dsh-browser-ref-label' }, match[2] ?? ''),
  ]
}

/**
 * Build the reply-side `dsh-browser-ref:` link renderer. It is installed on
 * `globalThis` by `apply` so the host markdown renderer can divert only that
 * scheme to a dedicated button (never a system `href`), reusing the additive
 * `BrowserRefLink` contract through `buildBrowserRefLinkProps`.
 */
export function createBrowserRefRenderer(
  runtime: ProductionRuntime,
  createElement: HostElementFactory,
): (url: string, children: readonly unknown[], key: unknown) => unknown {
  return (url, children, key) => {
    if (!url.startsWith(BROWSER_REF_SCHEME)) return undefined
    const first = children[0]
    const label = typeof first === 'string' ? first : undefined
    const dom = buildBrowserRefLinkProps(runtime.revealer.linkSpec(url, label))
    // The composer chip is a numbered badge plus a label; the sent message used to be one run of
    // text, so the pill was only "half" of the same control. Split the wire label back into its two
    // halves so both surfaces have the identical anatomy.
    const badge = splitSourceLabel(dom.children, createElement)
    return createElement('button', {
      key,
      type: dom.type,
      role: dom.role,
      'aria-disabled': dom['aria-disabled'],
      disabled: dom.disabled,
      ...(dom.className === undefined ? {} : { className: dom.className }),
      ...(dom.title === undefined ? {} : { title: dom.title }),
      onClick: dom.onClick,
      onKeyDown: dom.onKeyDown,
      onAuxClick: dom.onAuxClick,
      onMouseDown: dom.onMouseDown,
    }, badge ?? dom.children)
  }
}

/**
 * Load the production feature into the host. Returns the runtime so the caller
 * (and unit tests) can drive/inspect it; also exposes the submission seam.
 */
export function apply(ctx: HostContext, config: AssemblyConfig = {}): ProductionRuntime {
  ensureDockStyles()
  const locale = ctx.get('locale') as { register(namespace: string, copy: Readonly<Record<string, ReferenceLabels>>): void | (() => void) } | undefined
  if (typeof locale?.register === 'function') ctx.effect(() => locale.register(REFERENCE_LOCALE, referenceCopy), 'ui-browser-reference: copy')
  // Functions cannot come from the YAML config block, so L01 publishes them as
  // a scope service; explicit config (tests / programmatic wiring) wins.
  const deps = ctx.get('browserReferenceDeps') as BrowserReferenceDeps | undefined
  const hostInputFor = config.hostInputFor ?? deps?.hostInputFor
  const admitAsset = config.admitAsset ?? deps?.admitAsset
  const elementFactory: HostElementFactory = config.createElement ?? deps?.createElement
    ?? ((tag, props, ...children) => ({ tag, props, children }))
  const baseUrl = config.baseUrl ?? deps?.baseUrl
  const cancellation = createCancellationSource()
  const http = createReferenceHttpClient({
    ...(baseUrl === undefined ? {} : { baseUrl }),
    request: requestOrDefault(config, () => cancellation.signal()),
  })
  const runtime = createProductionRuntime({
    http,
    storage: storageOrDefault(config),
    initialSessionId: config.initialSessionId ?? '',
    cancellation,
    hostInputFor: hostInputFor ?? (() => ({
      captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
      insertText: () => true,
      persistDraft: () => {},
      readText: () => '',
    })),
    ...(admitAsset === undefined ? {} : { admitAsset }),
    ...(config.pollIntervalMs === undefined ? {} : { pollIntervalMs: config.pollIntervalMs }),
    ...(config.scheduler === undefined ? {} : { scheduler: config.scheduler }),
    ...(config.textPosition === undefined ? {} : { textPosition: config.textPosition }),
  })

  // Expose the ordered submission seam for the host's real send path. Cordis
  // requires `provide()` before `set()` for a service name; a bare set throws
  // "cannot set property without provide" and would leave R05 unwired.
  // cordis: provide() DECLARES a service, set() assigns it. Passing the value to provide() only declared
  // the name, so the conversation service's ctx.get('browserReferenceSubmission') returned undefined and
  // every send ignored its references — the message went out with the typed text alone while the chips
  // stayed in the composer.
  if (typeof ctx.provide === 'function') {
    ctx.provide('browserReferenceSubmission')
    ctx.set?.('browserReferenceSubmission', runtime.submission)
  } else {
    ctx.set?.('browserReferenceSubmission', runtime.submission)
  }
  const disposeSubmission = undefined as unknown
  // Cordis services are visible along a fiber's ancestor chain only; this plugin and the conversation
  // service are siblings, so `ctx.get` from the sender could not see the seam and every send ignored its
  // references. A global mirror is the same escape hatch this module already uses for the markdown
  // renderer and the reply-link bridge.
  const submissionHost = globalThis as unknown as Record<string, unknown>
  submissionHost.__DSH_BROWSER_REF_SUBMISSION__ = runtime.submission
  if (disposeSubmission !== undefined && typeof (disposeSubmission as { dispose?: unknown }).dispose === 'function') {
    // Some cordis shapes return a disposer object rather than a function.
    ctx.effect(() => () => { (disposeSubmission as { dispose: () => void }).dispose() }, 'ui-browser-reference: submission service')
  }

  const cardComponent = createLiveCardDockComponent(runtime, elementFactory)
  const replyComponent = createReplyLinkComponent(runtime, elementFactory)

  // Divert only `dsh-browser-ref:` markdown destinations to the dedicated
  // button; the global hook is optional so old messages / builds without this
  // plugin keep their exact previous rendering.
  const globalHost = globalThis as unknown as Record<string, unknown>
  const browserRefRenderer = createBrowserRefRenderer(runtime, elementFactory)
  globalHost[BROWSER_REF_RENDERER_GLOBAL] = browserRefRenderer
  ctx.effect(() => () => {
    if (globalHost[BROWSER_REF_RENDERER_GLOBAL] === browserRefRenderer) {
      delete globalHost.__DSH_BROWSER_REF_RENDERER__
    }
  }, 'ui-browser-reference: markdown link renderer')

  // The deployed markdown renderer predates the optional hook above. A
  // document-level bridge is what makes `dsh-browser-ref:` links clickable in
  // the installed desktop without downgrading its frontend bundle.
  const replyLinkBridge = installReplyLinkBridge({
    isAvailable: uri => runtime.revealer.linkSpec(uri).available,
    activate: (uri) => { void runtime.activateUri(uri) },
    // 消息里的胶囊悬停时给出与输入栏一致的详情：标题、域名、原文、用户评论。
    cardFor: async (uri) => {
      let referenceId: string
      try {
        referenceId = decodeBrowserRefUri(uri).referenceId
      } catch {
        return undefined
      }
      return runtime.referenceDetail(referenceId)
    },
  })
  globalHost[REPLY_LINK_BRIDGE_GLOBAL] = replyLinkBridge
  ctx.effect(() => () => {
    if (globalHost[REPLY_LINK_BRIDGE_GLOBAL] === replyLinkBridge) {
      delete globalHost.__DSH_BROWSER_REF_LINK_BRIDGE__
    }
    replyLinkBridge.dispose()
  }, 'ui-browser-reference: reply link bridge')

  /**
   * The dock reads the Session id and the live draft off its owner props. The
   * rail it lands on declares no owner share, so the adapter rebuilds those two
   * fields from the Session standard kit (`sessionId`, `useInput`) the slot
   * runtime injects anyway.
   */
  const dockComponent = (props: unknown): unknown => {
    // 这一行是「只有引用发不出去」的根因所在：座位把标准 props（`sessionId`/`useInput`/`inputActions`）
    // 交给**组件**，而 `inject()` 工厂参数里没有它们。原实现只在注槽时用 `noteDockProps` 回传，
    // 于是 `inputActions` 恒为 undefined → `hostInputFor()` 里没有 `insertReference` → 引用只画成浮层
    // 胶囊、没进编辑器 → 上游闸门（rc.3：`draft.trim()==='' && attachments===0`）判为空 → 发送禁用。
    // 在组件里回传真实 props，`inputActions.insertReference` 才能拿到，胶囊才会成为原生引用节点。
    config.onDockProps?.(props)
    const face = props as {
      readonly sessionId?: string
      readonly useInput?: (
        selector: (state: { readonly draft?: string }) => { readonly draft?: string },
      ) => { readonly draft?: string }
    } | undefined
    const input = face?.useInput === undefined ? undefined : face.useInput(value => value)
    // Delegated by call rather than through an element so the seat renders the
    // dock itself: one React boundary, same hook order on every render.
    return cardComponent({
      ...(props as Readonly<Record<string, unknown>>),
      session: { sessionId: face?.sessionId ?? '' },
      input: { draft: input?.draft ?? '' },
    })
  }
  // 胶囊行属于输入框内部布局：注册进宿主在 composer card 里提供的 `conversation.input.chips`。
  // 注册到 `conversation.input.overlay` 会让胶囊浮在输入框之上——占位文字与附件图片都会与它重叠。
  ctx.slots.inject('conversation.input.chips', function* () {
    yield ctx.slots.register({
      name: 'conversation.input.chips', id: 'dsh-browser-reference', priority: 50,
      // The dictionary rides the same namespace `apply` registers with the host
      // locale service, so the rail's copy follows the active language.
      locale: REFERENCE_LOCALE,
      // `hooks.dockCards` becomes the component's `useDockCards` selector hook,
      // bound by the host's React; `noteDockProps` hands the Session-scope props
      // (session id, input actions) back to the runtime on each render.
      inject: () => ({
        hooks: { dockCards: { getSnapshot: () => runtime.snapshot(), subscribe: (listener: () => void) => runtime.subscribe(listener) } },
        noteDockProps: (props: unknown) => { config.onDockProps?.(props) },
      }),
    }, dockComponent)
  })
  ctx.slots.inject('conversation.user.text.node', function* () {
    yield ctx.slots.register({
      name: 'conversation.user.text.node', key: 'browser-ref', priority: 100,
      inject: () => ({ hooks: { sourceReferences: {
        getSnapshot: () => runtime.snapshot(), subscribe: (listener: () => void) => runtime.subscribe(listener),
      } } }),
    }, replyComponent)
  })
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register({
      name: 'shell.overlay', id: 'dsh-browser-reference-feedback',
      inject: () => ({ hooks: { referenceFeedback: {
        getSnapshot: () => runtime.snapshot(), subscribe: (listener: () => void) => runtime.subscribe(listener),
      } } }),
    }, (props: { readonly useReferenceFeedback?: (selector: (value: DockSnapshot) => DockSnapshot) => DockSnapshot }) => {
      const view = props.useReferenceFeedback?.(value => value) ?? runtime.snapshot()
      return element(ReferenceFeedback, view.reveal === undefined ? {} : { notice: view.reveal })
    })
  })

  // 投递泵必须在**任何可选集成之前**启动。旧顺序把它放在最后，于是后面任何一步（可选的
  // `uiConversation.userText` 注册等）抛错时，dock 已经渲染、会话也绑好了，唯独轮询没起来：
  // 现象就是「引用卡片永远不出现、发送一直禁用」，而外层 try/catch 把它吞成静默失败。
  runtime.start()
  ctx.effect(() => () => { runtime.dispose() }, 'ui-browser-reference: production runtime')

  const textOwner = ctx.get('uiConversation') as {
    readonly userText?: { register(rule: typeof browserSourceRule): () => void }
  } | undefined
  if (textOwner?.userText !== undefined) {
    try {
      ctx.effect(() => textOwner.userText?.register(browserSourceRule), 'ui-browser-reference: source text rule')
    } catch {
      // 文本来源高亮是可选的展示增强：注册失败不能拖垮引用投递。
    }
  }
  return runtime
}
