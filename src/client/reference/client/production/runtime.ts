/**
 * Production runtime: the object the assembly builds and the unit tests drive.
 *
 * It ties together the injected HTTP client, the per-session draft store, the
 * durable asset store, the additive pending-delivery queue (tombstone +
 * idempotent intents), the cancellable poller, the ordered submission seam and
 * the production revealer. Every dependency is injected; NO host module is
 * imported at runtime, so this file compiles and runs standalone.
 *
 * ACK rule (§12.1): a final `phase: 'acknowledged'` is sent ONLY after
 *   1. every required image asset is durably bound (real bytes + optional host
 *      attachment receipt), and
 *   2. the ordered group is durably saved with the user's question/caret intact.
 * Otherwise the delivery stays visible on the server and is retried next poll.
 * The runtime NEVER auto-submits: the user sends the message themselves.
 *
 * @module dsh-browser-reference/production/runtime
 */
import type { KeyValueStorage, OrderedReferenceGroup } from '../types.ts'
import { referenceOwnerKey } from '../../../../reference-owner.ts'
import { createDeliveryQueue, type DeliveryQueue } from '../pending-delivery.ts'
import type { TextPosition } from '../ordered-submission.ts'
import {
  capturePreservation,
  createSessionDraftStore,
  preservationIntact,
  preserveAndAppend,
  reflectionFromDelivery,
  type HostInputFace,
  type SessionDraftStore,
  type StoredReflection,
} from './draft-adapter.ts'
import { createAssetStore, type AssetStore } from './asset-store.ts'
import { requiredAssetKeys, toOrderedGroup } from './snapshot-adapter.ts'
import {
  buildCardViewModel,
  type CardViewModel,
} from './reference-card.ts'
import { encodeBrowserRefUri, parseBrowserRefUri } from '../scheme.ts'
import type { RevealStatus } from '../types.ts'
import {
  createSubmissionSeam,
  SOURCE_LINK_LABEL,
  type HostPromptContentPart,
  type SubmissionSeam,
} from './production-submission.ts'
import {
  createProductionRevealer,
  type ProductionRevealer,
  type RevealOwner,
} from './reveal.ts'
import {
  createCancellationSource,
  createDeliveryPoller,
  type CancellationSource,
  type DeliveryPoller,
  type PollerScheduler,
} from './delivery-client.ts'
import type {
  AssetResponse,
  DeliveriesResponse,
  DeliveryAckPhase,
  DeliveryRecord,
  ExportFormat,
} from './protocol.ts'
import type { ReferenceHttpClient } from './http-transport.ts'
import { availabilityOf, type AvailabilityState } from './availability.ts'

export interface AdmitAssetResult {
  readonly receiptId?: string
}

export interface ProductionRuntimeOptions {
  readonly http: ReferenceHttpClient
  readonly storage: KeyValueStorage
  readonly initialSessionId: string
  /** Resolve the host input face for one DSH session (inputActions + input snapshot). */
  readonly hostInputFor: (sessionId: string) => HostInputFace
  /**
   * Host image/file attachment admission. Given a fetched asset it returns an
   * optional durable `receiptId`; `{}`/undefined means inline real bytes.
   * Throwing leaves the asset unbound so the next poll retries.
   */
  readonly admitAsset?: (asset: AssetResponse, sessionId: string) => Promise<AdmitAssetResult | undefined>
  readonly now?: () => number
  readonly pollIntervalMs?: number
  readonly scheduler?: PollerScheduler
  readonly textPosition?: TextPosition
  /** Shared abort source; when absent one is created and exposed on the runtime. */
  readonly cancellation?: CancellationSource
  readonly queueKey?: string
}

export type ApplyOutcome =
  | { readonly kind: 'skipped'; readonly reason: 'wrong-session' | 'tombstoned' | 'queue-deleted' | 'consumed' }
  | { readonly kind: 'rendered' }
  | { readonly kind: 'recovered'; readonly from: 'snapshot' }
  | { readonly kind: 'waiting-assets'; readonly missing: readonly string[] }
  | { readonly kind: 'save-failed'; readonly reason: string }
  | { readonly kind: 'ack-pending'; readonly reason: string }
  | {
    readonly kind: 'acknowledged'
    readonly draftRev: number
    readonly assetKeys: readonly string[]
    readonly phases: readonly DeliveryAckPhase[]
  }

export interface PollReport {
  readonly sessionId: string
  readonly since: number
  readonly outcomes: readonly { readonly intentId: string; readonly outcome: ApplyOutcome }[]
  /** Per-delivery processing errors, kept OUT of the transport's lastError. */
  readonly internalErrors?: readonly string[]
}

/** One immutable dock view: stable identity until the runtime actually changes. */
export interface DockSnapshot {
  readonly sessionId: string
  readonly revision: number
  readonly cards: readonly CardViewModel[]
  readonly availability: AvailabilityState
  /** Outcome of the last "回到原文" attempt, so a failure is never silent. */
  readonly reveal?: { readonly status: string; readonly message: string }
  /** Why a captured reference has not reached the composer yet, in one sentence. */
  readonly issue?: string
}

/**
 * Human copy for a reveal attempt; only failures are worth interrupting for.
 *
 * Each failure names its own cause. One shared sentence for all of them made a
 * page that merely scrolled away read as "the sidebar browser is broken".
 */
const REVEAL_MESSAGES: Readonly<Record<string, string>> = {
  revealed: '',
  cancelled: '已取消定位。',
  superseded: '已切换到更新的定位请求。',
  'unknown-reference': '这条引用已不在当前会话中，无法回到原文。',
  'session-mismatch': '这条引用属于另一个会话，无法在当前会话定位。',
  'not-found': '这条引用的原文记录已不存在。',
  'session-unavailable': '侧栏网页已不在原来的标签页里，无法回到原文。',
  'page-mismatch': '侧栏当前打开的是另一个页面，无法定位原文。',
  missing: '侧栏页面里已找不到这段文字，页面内容可能已变化。',
  ambiguous: '这段文字在页面里出现多处，无法确定是哪一处。',
  unavailable: '侧栏网页没有响应，无法定位原文（页面可能正在加载或已关闭）。',
}

/**
 * Why a captured reference is not on screen yet.
 *
 * The delivery stays on the server and is retried, so the card eventually
 * appears; until then the dock has to say so. A capture that silently produces
 * nothing is the single most confusing state this feature can be in.
 */
const DELIVERY_ISSUES: Readonly<Record<string, string>> = {
  'waiting-assets': '引用里的图片还在读取，稍后会自动加入。',
  'save-failed': '引用已捕获，但当前输入框暂不可写，恢复后会自动加入。',
  'ack-pending': '引用已加入，正在确认…',
}

/** 插入引文的最大尝试次数；超过即放弃，避免每轮轮询重复写入。 */
const MAX_INSERT_ATTEMPTS = 3

export interface ProductionRuntime {
  currentSessionId(): string
  /** 订阅会话切换（会话 id 从空变成已知时也要通知）；返回取消订阅。 */
  onSessionChange(listener: (sessionId: string) => void): () => void
  setSession(sessionId: string): void
  /** 每次 dock 渲染时把当前草稿交给运行时：草稿由非空变空即视为已发送，退役本会话的引用。 */
  noteDraft(sessionId: string, draft: string): void
  /** One poll cycle; also the body of the interval. Returns a content-level report. */
  pollOnce(): Promise<PollReport | undefined>
  start(): void
  stop(): void
  dispose(): void
  readonly disposed: boolean
  readonly poller: DeliveryPoller
  readonly cancellation: CancellationSource
  /** Dock cards for the current session (content-complete view models). */
  cards(): readonly CardViewModel[]
  /**
   * Stable, declarative view of the dock: the SAME object identity until
   * something actually changed. `subscribe` + this method are what the React
   * dock reads through `useSyncExternalStore`, so a delivery that lands in the
   * background repaints without the user typing.
   */
  snapshot(): DockSnapshot
  /** Subscribe to dock changes (delivery, comment edit, removal, session switch). */
  subscribe(listener: () => void): () => void
  /**
   * Explicit delivery availability. A 404 -> plugin-too-old, a malformed body
   * -> delivery-unavailable, a network failure -> offline, success -> ok.
   * Never a silent "empty but healthy" state.
   */
  availability(): AvailabilityState
  /** All sessions' reflections, for reveal routing. */
  ownerFor(referenceId: string): RevealOwner | undefined
  /** Ordered submission seam the host calls at service.ts:302. */
  readonly submission: SubmissionSeam
  projectContent(input: { uploaded: readonly HostPromptContentPart[]; text: string }): readonly HostPromptContentPart[]
  /** Remove a card for good: tombstoned locally and dropped on the plugin side. */
  removeCard(referenceId: string): Promise<void>
  /** Jump the sidebar browser back to a reference's原文 and highlight it. */
  revealReference(referenceId: string, partId?: string): Promise<RevealStatus>
  /**
   * "Open this URL in the sidebar browser", supplied by the client shell.
   *
   * Reveal needs it to actually GO to the source: when the sidebar shows
   * another page (or none at all) the only useful answer is to open the stored
   * URL there and try again, not to explain that it could not.
   */
  setSourceOpener(opener: ((url: string, signal: AbortSignal) => Promise<{ readonly pageId: string }>) | undefined): void
  /** 一条引用的可展示详情（消息胶囊悬停卡用）。 */
  referenceDetail(referenceId: string): (StoredReflection & { readonly sessionId: string; readonly card: CardViewModel }) | undefined
  /** Activate a canonical `dsh-browser-ref:` URI (reply-side link bridge). */
  activateUri(uri: string): Promise<RevealStatus>
  /** Edit the draft's own copy of the user's note (§5); never rewrites the snapshot. */
  setComment(referenceId: string, comment: string): boolean
  /** Production revealer (activate a `dsh-browser-ref:` link). */
  readonly revealer: ProductionRevealer
  exportBundle(format: ExportFormat, sessionId?: string): Promise<Uint8Array>
  importBundle(zip: Uint8Array): Promise<unknown>
  /** Introspection for tests/recovery assertions. */
  draftState(sessionId?: string): Readonly<ReturnType<SessionDraftStore['state']>>
  assetStore(sessionId?: string): AssetStore
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Build the fully-wired production runtime. */
export function createProductionRuntime(options: ProductionRuntimeOptions): ProductionRuntime {
  const http = options.http
  const storage = options.storage
  const now = options.now ?? (() => Date.now())
  const admitAsset = options.admitAsset
  const hostInputFor = options.hostInputFor
  const cancellation = options.cancellation ?? createCancellationSource()
  let current = referenceOwnerKey(options.initialSessionId)
  /** 会话切换的订阅者：侧栏页要在 id 到手后立刻收到，而不是只能靠下一次询问。 */
  const sessionListeners = new Set<(sessionId: string) => void>()
  /** 每条引用的插入尝试次数（本运行时实例内有效），用于限次重试。 */
  const insertAttempts = new Map<string, number>()
  /** 上一次看到的草稿文本，用于识别「发送后草稿被清空」。 */
  let lastDraft = ''
  let disposed = false

  // --- declarative dock state -------------------------------------------------
  // The dock is a React component: it reads `snapshot()` through
  // `useSyncExternalStore(runtime.subscribe, runtime.snapshot)`. `dirty` is
  // bumped only when the visible content actually changed, so an idle poll
  // never re-renders the card tree (a re-render would steal focus from the
  // comment editor while the user is typing).
  let dirty = 0
  let published = 0
  let cachedSnapshot: DockSnapshot | undefined
  const listeners = new Set<() => void>()
  // `undefined` until the first publish, so startup itself is not a change.
  let lastAvailabilityStatus: string | undefined

  let lastReveal: DockSnapshot['reveal']
  /**
   * Silences the per-attempt hint while `revealReference` retries after opening
   * the source page: only the outcome the person ends up with is reported.
   */
  let mutedReveal = 0
  let sourceOpener: ((url: string, signal: AbortSignal) => Promise<{ readonly pageId: string }>) | undefined
  let sourceOpening: AbortController | undefined
  let revealIntent = 0
  let lastIssue: string | undefined
  // A failed "回到原文" used to stay on screen forever: the hint was only
  // rewritten by the NEXT reveal attempt, so recovering the sidebar never
  // cleared it. Failures now expire; successes are silent immediately.
  const REVEAL_HINT_MS = 5_000
  let revealTimer: ReturnType<typeof setTimeout> | undefined
  const clearRevealHint = (): void => {
    if (revealTimer === undefined) return
    clearTimeout(revealTimer)
    revealTimer = undefined
  }
  const showReveal = (status: string): void => {
    clearRevealHint()
    lastReveal = { status, message: REVEAL_MESSAGES[status] ?? '' }
    markDirty()
    publish()
    if (lastReveal.message === '') return
    revealTimer = setTimeout(() => {
      revealTimer = undefined
      lastReveal = undefined
      markDirty()
      publish()
    }, REVEAL_HINT_MS)
    const unref = (revealTimer as unknown as { unref?: () => void }).unref
    if (typeof unref === 'function') unref.call(revealTimer)
  }
  const activateUri = async (uri: string): Promise<RevealStatus> => {
    const parsed = parseBrowserRefUri(uri)
    if (parsed !== undefined) return revealReference(parsed.referenceId, parsed.partId)
    revealIntent += 1
    sourceOpening?.abort()
    showReveal('unknown-reference')
    return 'unknown-reference'
  }

  // --- wake-on-visible --------------------------------------------------------
  // Chromium throttles a hidden renderer's timers to about one per minute. A
  // capture made while the window was in the background used to surface up to
  // 41 s later — the "界面不会自动更新" report. Poll immediately when the window
  // regains focus instead of waiting for the throttled interval.
  let stopWake: (() => void) | undefined

  const markDirty = (): void => { dirty += 1 }

  const publish = (): void => {
    const status = availabilityOf(poller.lastError).status
    // `undefined` means "never published"; treat it as the initial healthy
    // state so the FIRST outage (404 / offline / malformed body) also bumps
    // dirty and notifies the dock, instead of leaving a cached "ok" banner up.
    const previous = lastAvailabilityStatus ?? 'ok'
    if (status !== previous) dirty += 1
    lastAvailabilityStatus = status
    if (dirty === published) return
    published = dirty
    cachedSnapshot = undefined
    for (const listener of [...listeners]) listener()
  }

  const stores = new Map<string, SessionDraftStore>()
  const assets = new Map<string, AssetStore>()

  const draftStoreFor = (sessionId: string): SessionDraftStore => {
    let store = stores.get(sessionId)
    if (store === undefined) {
      store = createSessionDraftStore(storage, sessionId)
      stores.set(sessionId, store)
    }
    return store
  }
  const assetStoreFor = (sessionId: string): AssetStore => {
    let store = assets.get(sessionId)
    if (store === undefined) {
      store = createAssetStore(storage, sessionId)
      assets.set(sessionId, store)
    }
    return store
  }

  // The delivery queue is independent of localStorage: a consumed marker on
  // the Host prevents an old draft from returning after a quota-blocked exit.
  const pendingConsumptions = new Map<string, { readonly sessionId: string; readonly intentId: string }>()
  let consuming: Promise<void> | undefined
  const flushConsumptions = (): Promise<void> => {
    if (http.consume === undefined) return Promise.resolve()
    if (consuming !== undefined) return consuming
    const consume = http.consume.bind(http)
    const task = (async () => {
      for (const [key, pending] of pendingConsumptions) {
        try {
          await consume(pending.sessionId, pending.intentId)
          if (pendingConsumptions.get(key) === pending) pendingConsumptions.delete(key)
        } catch { /* the next poll or accepted send retries the durable marker */ }
      }
    })().finally(() => { if (consuming === task) consuming = undefined })
    consuming = task
    return task
  }

  // Reuse the additive pending-delivery queue: intent-id idempotency +
  // durable tombstone (a removed reference stays removed under late retries).
  const queue: DeliveryQueue = createDeliveryQueue({
    storage,
    ...(options.queueKey === undefined ? {} : { key: options.queueKey }),
    onApply: () => { /* final ACK is awaited explicitly, not fired here */ },
  })

  /**
   * Retry the durable archive of any session whose accepted send left a pending
   * marker (a localStorage quota failure during phase 2). Idempotent: a store
   * with nothing pending returns immediately, and a store whose archive already
   * succeeded has an empty marker. Driven by the poller, by the next commit and
   * by the host's retry hook, so the sent message's provenance is completed as
   * soon as quota recovers — without ever re-sending or re-ACKing anything.
   */
  const flushPendingArchives = (): void => {
    for (const store of stores.values()) {
      try { store.flushPendingArchive() } catch { /* keep the pending marker for the next retry */ }
    }
  }

  const requiredKeys = (delivery: DeliveryRecord): readonly string[] =>
    [...new Set([...delivery.requiredAssets, ...requiredAssetKeys(delivery.snapshot)])]

  /** Bind every required asset, returning the keys still missing. */
  const bindAssets = async (delivery: DeliveryRecord, sessionId: string): Promise<readonly string[]> => {
    const store = assetStoreFor(sessionId)
    const required = requiredKeys(delivery)
    for (const key of required) {
      if (store.get(key) !== undefined) continue
      try {
        const asset = await http.assetBase64(key)
        let receiptId: string | undefined
        if (admitAsset !== undefined) {
          const result = await admitAsset(asset, sessionId)
          receiptId = result?.receiptId
        }
        store.bind(asset, receiptId)
      } catch {
        // A transient asset/admission failure leaves the key unbound; the
        // delivery stays visible server-side and is retried on the next poll.
      }
    }
    return store.missing(required)
  }

  const makeReflection = (delivery: DeliveryRecord, state: StoredReflection['deliveryState']): StoredReflection => {
    const group = toOrderedGroup(delivery.snapshot)
    const base = reflectionFromDelivery(delivery, group, now())
    return { ...base, deliveryState: state }
  }

  /**
   * Reference ids whose durable save THIS process has confirmed. A persisted
   * reflection alone is NOT proof: after a host `persistDraft` failure the card
   * is already in the store, and the old `hasReference` short-circuit ACKed the
   * next poll without ever re-checking the "durably saved with the user's text
   * intact" gate. A restart starts empty and simply re-validates — the already
   * appended card is never deleted.
   */
  const confirmedSaved = new Set<string>()
  const savedKey = (sessionId: string, referenceId: string): string => `${sessionId}\u0000${referenceId}`

  /** Ensure the group + reflection exist; returns the saved CAS revision. */
  const ensureDraft = (
    delivery: DeliveryRecord,
    sessionId: string,
    state: StoredReflection['deliveryState'],
  ): { readonly ok: boolean; readonly draftRev: number; readonly reason?: string } => {
    const store = draftStoreFor(sessionId)
    const key = savedKey(sessionId, delivery.referenceId)
    if (store.hasReference(delivery.referenceId)) {
      store.setDeliveryState(delivery.referenceId, state)
      if (confirmedSaved.has(key)) return { ok: true, draftRev: store.state().draftRev }
      // The card is already appended, but we have no proof this process durably
      // saved it with the question/caret intact. Re-run the persistence +
      // preservation checks before allowing an ACK (never drop the card).
      const host = hostInputFor(sessionId)
      const before = capturePreservation(host)
      let saveSucceeded = false
      try {
        host.persistDraft()
        store.persist()
        saveSucceeded = true
      } catch {
        saveSucceeded = false
      }
      const preserved = preservationIntact(host, before)
      if (saveSucceeded && preserved) {
        confirmedSaved.add(key)
        return { ok: true, draftRev: store.state().draftRev }
      }
      return {
        ok: false,
        draftRev: store.state().draftRev,
        reason: !saveSucceeded ? 'persist failed' : 'user text/caret changed',
      }
    }
    const reflection = makeReflection(delivery, state)
    const result = preserveAndAppend({
      host: hostInputFor(sessionId),
      store,
      makeReflection: () => reflection,
    })
    if (result.ok) {
      confirmedSaved.add(key)
      return { ok: true, draftRev: result.draftRev }
    }
    if (result.status === 'duplicate') {
      store.ensureReflection(reflection)
      confirmedSaved.add(key)
      return { ok: true, draftRev: store.state().draftRev }
    }
    const reason = !result.saveSucceeded ? 'persist failed'
      : !result.preserved ? 'user text/caret changed' : result.status
    return { ok: false, draftRev: result.draftRev, reason }
  }


  /**
   * Insert one delivery as a native reference chip, when the host exposes the editor entry point.
   * @param delivery - the delivery being reflected into the draft.
   * @param sessionId - owning Session.
   */
  const insertChip = (delivery: DeliveryRecord, sessionId: string): boolean => {
    const host = hostInputFor(sessionId)
    const snapshot = delivery.snapshot as {
      readonly source?: { readonly title?: string }
      readonly parts?: readonly { readonly type?: string; readonly kind?: string; readonly text?: string }[]
    }
    const title = snapshot.source?.title
    // 快照部件的判别字段是 `type`（`TextReferencePart.type === 'text'`），不是 `kind`。
    const quoteText = (snapshot.parts ?? [])
      .filter(part => (part.type ?? part.kind) === 'text')
      .map(part => part.text ?? '').join('\n').trim()

    // 只插入**标记行**，不插入引文正文：
    //   · 消息里出现整段原文属于信息泄露（用户明确要求只留胶囊）；
    //   · 标记行让草稿非空，上游发送闸门因此放行（「只有引用也能发」）；
    //   · 引文内容本身保存在引用快照里，点胶囊可以查看/回到原文。
    const index = (draftStoreFor(sessionId).state().reflections ?? []).length
    const label = title === undefined || title === ''
      ? `${SOURCE_LINK_LABEL} ${index}`
      : `${SOURCE_LINK_LABEL} ${index}：${title}`
    const marker = `[${label}](${encodeBrowserRefUri({ referenceId: delivery.referenceId })})`
    // 插入需要编辑器里有光标：确认按钮是在侧栏 iframe 里点的，先聚焦编辑器。
    try { host.focusEditor?.() } catch { /* 没有编辑器就交给下面的失败路径 */ }
    try {
      if (host.insertText(host.captureInsertion(), marker)) return true
    } catch {
      // 文本插入失败时退回下面旧内核的芯片通道。
    }
    // 3) 宿主若提供原生引用芯片（旧内核），仍然优先走它。
    if (typeof host.insertReference !== 'function') return false
    const quote = quoteText
    const uri = encodeBrowserRefUri({ referenceId: delivery.referenceId })
    try {
      return host.insertReference({
        source: 'browser-reference',
        ref: uri,
        label: title !== undefined && title !== '' ? title : '网页引用',
        appearance: 'session',
        clipboardText: quote === '' ? (title ?? uri) : quote,
      }, host.captureInsertion())
    } catch {
      return false
    }
  }

  const processDelivery = async (delivery: DeliveryRecord, sessionId: string): Promise<ApplyOutcome> => {
    if (delivery.sessionId !== sessionId) return { kind: 'skipped', reason: 'wrong-session' }
    const store = draftStoreFor(sessionId)
    if (delivery.state === 'consumed') {
      // The Host already consumed this reference. `retire` clears the in-memory
      // draft even when its durable write fails (see draft-adapter), so the
      // quote cannot leak into the next message. The queue tombstone is the
      // same idempotent call `consumeSubmitted` guards: a full localStorage
      // must NOT make `prepare()` throw and block the user from sending again.
      store.retire([delivery.referenceId], [makeReflection(delivery, 'acknowledged')])
      try { queue.markDeleted(delivery.referenceId) } catch { /* tombstone is idempotent; the poller retries */ }
      try { store.flushPendingArchive() } catch { /* preserve the pending archive for retry */ }
      markDirty()
      return { kind: 'skipped', reason: 'consumed' }
    }
    if (store.isTombstoned(delivery.referenceId)) return { kind: 'skipped', reason: 'tombstoned' }
    const group: OrderedReferenceGroup = toOrderedGroup(delivery.snapshot)
    const capture = queue.capture({ intentId: delivery.intentId, sessionId, group })
    if (capture.status === 'deleted') return { kind: 'skipped', reason: 'queue-deleted' }

    const required = requiredKeys(delivery)
    await bindAssets(delivery, sessionId)
    const assetStore = assetStoreFor(sessionId)

    if (delivery.state === 'acknowledged') {
      // An acknowledged delivery still has to re-fetch any asset that was not
      // durably bound the first time. A transient asset failure used to leave
      // the card rendered with zero images and the projection full of
      // `image unavailable` placeholders, with the cursor already past the
      // delivery so nothing ever retried. `waiting-assets` is RETRYABLE: it
      // pins the cursor below this sequence so the next poll keeps calling
      // bindAssets until every required asset is bound. No ACK, no re-send.
      const missing = assetStore.missing(required)
      if (missing.length > 0) return { kind: 'waiting-assets', missing }
      // Only render the card; recover the full group from the frozen snapshot
      // when a restart left our draft empty. No ACK, no re-send.
      const existed = store.hasReference(delivery.referenceId)
      const draft = ensureDraft(delivery, sessionId, 'acknowledged')
      if (!draft.ok) return { kind: 'save-failed', reason: draft.reason ?? 'recovery failed' }
      // 引文只在**这张卡第一次出现时**插入编辑器。旧代码不看 `existed`，于是每条已确认的投递在
      // 每轮轮询里都再插一次：几十轮下来草稿被同一段引文灌满（界面上一整屏引号），而且每次插入
      // 都改一次草稿修订号。恢复路径（重启后重建卡片）本来就该只还原卡片，不重放插入。
      // 记账放在**草稿 store**里（持久化）：运行时实例会被 dock 重挂载重建，内存记账跟着丢，
      // 同一条投递就会被反复插进草稿（界面上一整屏引号）。
      // 先记账再插：插入失败（编辑器被锁、修订号变动）时若不留记录，就会每个轮询周期重试一次，
      // 界面表现为引文每秒叠加一条。记账是「这条引用已经处理过」，重试交给用户动作。
      // 限次重试：插入可能因为编辑器还没聚焦或修订号刚变而失败，但绝不能每轮都试——
      // 那会让引文在界面上每秒叠加一条。三次仍不成功就记账放弃，重试交给用户动作。
      if (!store.hasInserted(delivery.referenceId)) {
        const attempts = insertAttempts.get(delivery.referenceId) ?? 0
        if (attempts >= MAX_INSERT_ATTEMPTS) {
          store.markInserted(delivery.referenceId)
          insertAttempts.delete(delivery.referenceId)
        } else {
          insertAttempts.set(delivery.referenceId, attempts + 1)
          if (insertChip(delivery, sessionId)) {
            store.markInserted(delivery.referenceId)
            insertAttempts.delete(delivery.referenceId)
          }
        }
      }
      return existed ? { kind: 'rendered' } : { kind: 'recovered', from: 'snapshot' }
    }

    // 'prepared' | 'draft-applied': gate the ACK on assets + a durable draft.
    const missing = assetStore.missing(required)
    if (missing.length > 0) return { kind: 'waiting-assets', missing }

    const draft = ensureDraft(delivery, sessionId, delivery.state)
    if (!draft.ok) return { kind: 'save-failed', reason: draft.reason ?? 'draft not saved' }
    if (draft.draftRev < 1) return { kind: 'save-failed', reason: 'no saved draft revision' }

    const phases: DeliveryAckPhase[] = []
    try {
      if (delivery.state === 'prepared') {
        await http.ack({
          intentId: delivery.intentId,
          draftRev: draft.draftRev,
          assetKeys: required,
          phase: 'draft-applied',
        })
        phases.push('draft-applied')
      }
      await http.ack({
        intentId: delivery.intentId,
        draftRev: draft.draftRev,
        assetKeys: required,
        phase: 'acknowledged',
      })
      phases.push('acknowledged')
    } catch (error: unknown) {
      return { kind: 'ack-pending', reason: errorMessage(error) }
    }
    store.setDeliveryState(delivery.referenceId, 'acknowledged')
    queue.acknowledge(delivery.intentId)
    return { kind: 'acknowledged', draftRev: draft.draftRev, assetKeys: required, phases }
  }

  /**
   * Outcomes that must be retried. The server returns `sequence > since`, so a
   * cursor that advanced past them would strand the reference forever: the
   * card would never appear even after the network recovered.
   */
  const RETRYABLE: ReadonlySet<ApplyOutcome['kind']> = new Set(['waiting-assets', 'save-failed', 'ack-pending'])

  const runCycle = async (
    response: DeliveriesResponse,
    sessionId: string,
    isActive?: () => boolean,
  ): Promise<PollReport> => {
    // Recover any archive an accepted send left pending when storage was at
    // quota. Idempotent and write-free when nothing is pending.
    flushPendingArchives()
    await flushConsumptions()
    const outcomes: { intentId: string; outcome: ApplyOutcome }[] = []
    let since = draftStoreFor(sessionId).state().since
    // Lowest sequence that still has unfinished work. The cursor may not pass it.
    let blockedAt = Number.POSITIVE_INFINITY
    // A record belonging to another session is not ours to skip past: advancing
    // the cursor for it would drop a delivery of OUR own that shares the range.
    let foreign = false
    // True while every record seen so far belongs to another session.
    let foreignOnly = true
    let issue: string | undefined
    // Processing errors are recorded here, NEVER written into the transport's
    // lastError (that would make availabilityOf misreport "plugin not started").
    const internalErrors: string[] = []
    for (const delivery of response.deliveries) {
      // A session switch can land while a previous cycle is still awaiting a
      // delivery. Stop before touching the OLD session again (no ACK, no cursor).
      if (isActive !== undefined && !isActive()) {
        return { sessionId, since, outcomes, ...(internalErrors.length > 0 ? { internalErrors } : {}) }
      }
      let outcome: ApplyOutcome
      try {
        outcome = await processDelivery(delivery, sessionId)
      } catch (error: unknown) {
        // One malformed delivery must not abort the whole batch or strand the
        // cursor. Record it as retryable and keep processing the rest.
        const lastCycleError = errorMessage(error)
        internalErrors.push(lastCycleError)
        outcome = { kind: 'ack-pending', reason: lastCycleError }
      }
      outcomes.push({ intentId: delivery.intentId, outcome })
      if (outcome.kind === 'skipped' && outcome.reason === 'wrong-session') { foreign = true; continue }
      foreignOnly = false
      if (outcome.kind !== 'skipped') markDirty()
      if (RETRYABLE.has(outcome.kind)) {
        if (delivery.sequence < blockedAt) blockedAt = delivery.sequence
        if (issue === undefined) issue = DELIVERY_ISSUES[outcome.kind]
      } else if (delivery.sequence > since) {
        since = delivery.sequence
      }
    }
    // 临时诊断：把这一轮每个投递的处置结果挂到 window，定位「有投递但不上卡」。
    // The banner follows the newest cycle: it appears while work is stuck and
    // clears by itself as soon as that work lands.
    if (lastIssue !== issue) { lastIssue = issue; markDirty() }
    // A batch made only of OTHER sessions' deliveries used to pin the cursor at
    // `since` forever, replaying the same records every 1.5 s. With no own
    // unfinished work it is safe to jump to the queue's global high-water mark.
    const noRetryable = blockedAt === Number.POSITIVE_INFINITY
    const highest = foreignOnly && foreign && noRetryable
      ? Math.max(since, response.sequence)
      : foreign ? since : Math.max(since, response.sequence)
    // Retryable work pins the cursor below itself; the next poll asks for it again.
    const next = noRetryable ? highest : Math.min(highest, blockedAt - 1)
    // setSince short-circuits when the value is unchanged (no needless
    // JSON.stringify + localStorage write on a steady-state poll).
    draftStoreFor(sessionId).setSince(next)
    return { sessionId, since: next, outcomes, ...(internalErrors.length > 0 ? { internalErrors } : {}) }
  }

  let lastReport: PollReport | undefined
  /** 只有显式 start() 之后，setSession 才自动重起轮询（测试里用 pollOnce 手动驱动）。 */
  let pollingRequested = false
  const poller = createDeliveryPoller({
    http,
    getSessionId: () => current,
    getSince: () => draftStoreFor(current).state().since,
    onCycle: async (response, sessionId, isActive) => {
      const report = await runCycle(response, sessionId, isActive)
      // A switch mid-cycle invalidates this (OLD session) report.
      if (isActive !== undefined && !isActive()) return
      lastReport = report
      // Publish from the poll path too: the interval is what delivers a card
      // while the user is not touching the UI.
      publish()
    },
    // A settled poll must publish even when onCycle never ran (network failure
    // / 404 / plugin not running), otherwise useSyncExternalStore keeps the
    // cached "ok" banner on screen forever.
    onSettled: () => { publish() },
    ...(options.pollIntervalMs === undefined ? {} : { intervalMs: options.pollIntervalMs }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    cancellation,
  })

  /**
   * Retire the references a just-accepted send carried, in TWO phases.
   *
   * They are now message content, not draft state: leaving them in the store
   * made the next send attach the same quote again. The old single-step archive
   * copied the full FrozenSnapshot into `sent` and persisted BEFORE removing it
   * — at a tight localStorage quota that copy threw, so the removal never ran,
   * the card stayed, the next message repeated
   * the reference, and the throw bubbled out of the send as a false failure
   * even though the Host had already accepted the prompt.
   *
   * Phase 1 (`retire`) is a light, atomic MOVE out of the draft groups into a
   * `pendingArchive` marker: it never copies the full snapshot, so it succeeds
   * even at that quota. This is the step that MUST leave no draft residue.
   * Phase 2 (`flushPendingArchive`) writes the archive into `sent`, deduplicated
   * by referenceId; it may fail on quota and is then retried, with the pending
   * marker surviving until it succeeds. Neither phase can turn an accepted send
   * into a failure: the whole operation is best-effort and never throws.
   *
   * Only `referenceIds` — the set frozen when the content was projected — are
   * consumed. A reference added while the send was in flight stays in the draft.
   * @param sessionId - the session whose references were submitted.
   * @param referenceIds - exactly the references that send carried.
   */
  const consumeSubmitted = (sessionId: string, referenceIds: readonly string[]): Promise<void> => {
    const store = draftStoreFor(sessionId)
    for (const reflection of store.state().reflections) {
      if (referenceIds.includes(reflection.referenceId)) {
        pendingConsumptions.set(JSON.stringify([sessionId, reflection.intentId]), { sessionId, intentId: reflection.intentId })
      }
    }
    try {
      // Phase 1: atomically retire (no full-snapshot copy; always clears the draft).
      const retired = store.retire(referenceIds)
      for (const referenceId of retired) {
        try { queue.markDeleted(referenceId) } catch { /* tombstone is idempotent; the poller retries */ }
      }
      // Phase 2: durable archive, deduplicated by referenceId. A quota failure
      // keeps the pending marker for the next commit / poll / retrySubmitted.
      store.flushPendingArchive()
    } catch {
      // Never let a LOCAL cleanup error bubble out: the Host already accepted
      // the message. Any pending marker is flushed by the poller / next commit.
    }
    markDirty()
    publish()
    return flushConsumptions()
  }

  const tracksSubmissions = new Set<string>()
  const submission = createSubmissionSeam({
    bind: async (sessionId, hostRequestId, intentIds) => {
      if (tracksSubmissions.has(sessionId)) await http.bindSubmission?.(sessionId, hostRequestId, intentIds)
    },
    groupsFor: sessionId => draftStoreFor(sessionId).state().groups,
    submitted: consumeSubmitted,
    assetsFor: sessionId => assetStoreFor(sessionId),
    // Real page titles make the sent message's source link readable. ownerFor
    // resolves draft, pendingArchive and sent reflections, so a link produced
    // by this seam keeps its title even after the card has cleared.
    sourceTitleFor: referenceId => ownerFor(referenceId)?.label,
    commentsFor: sessionId => {
      const notes = new Map<string, string>()
      for (const reflection of draftStoreFor(sessionId).state().reflections) {
        if (reflection.comment !== undefined && reflection.comment !== '') {
          notes.set(reflection.referenceId, reflection.comment)
        }
      }
      return notes
    },
    ...(options.textPosition === undefined ? {} : { textPosition: options.textPosition }),
  })

  // Idempotent retry hook for the host. `createSubmissionSeam.commit` consumes
  // its per-send token, so a plain re-commit after a failed cleanup would be a
  // no-op; this hook instead flushes any pending archive directly. It NEVER
  // re-sends a message and NEVER re-ACKs. The assembly registers THIS SAME
  // object as `browserReferenceSubmission`, so service.ts can reach it.
  Object.assign(submission, {
    prepare: async (sessionId: string): Promise<void> => {
      sessionId = referenceOwnerKey(sessionId)
      if (http.consume === undefined) return
      const state = draftStoreFor(sessionId).state()
      const visible = new Set(state.groups.map(group => group.referenceId))
      if (visible.size === 0) return
      // Reconcile just the cards the user can submit. New incoming captures
      // and cursor advancement belong to the regular session poll.
      const response = await http.deliveries(sessionId, state.since)
      if (response.tracksSubmissions === true) tracksSubmissions.add(sessionId)
      else tracksSubmissions.delete(sessionId)
      if (response.unverified?.some(id => visible.has(id))) throw new Error('会话正在恢复，请稍后发送网页引用')
      for (const delivery of response.deliveries) {
        if (delivery.sessionId === sessionId && delivery.state === 'consumed' && visible.has(delivery.referenceId)) {
          await processDelivery(delivery, sessionId)
        }
      }
      publish()
    },
    retrySubmitted: (_sessionId: string, _requestId?: string): void => {
      flushPendingArchives()
      void flushConsumptions()
    },
  })

  const referenceDetail = (referenceId: string): (StoredReflection & { readonly sessionId: string; readonly card: CardViewModel }) | undefined => {
    draftStoreFor(current)
    for (const [sessionId, store] of stores) {
      // A reference carried by a sent message lives in the archive, not in the
      // draft: its source link must keep working after the card clears. It may
      // also sit in `pendingArchive` between an accepted send's retire and the
      // durable archive (quota failure), so resolve that window too — otherwise
      // the sent message's link would read "来源不可用" until quota recovers.
      const reflection = store.state().reflections.find(entry => entry.referenceId === referenceId)
        ?? store.sentReflection(referenceId)
        ?? store.pendingReflection(referenceId)
      if (reflection === undefined) continue
      const index = store.state().reflections.indexOf(reflection) + 1
      return { ...reflection, sessionId, card: buildCardViewModel(reflection, assetStoreFor(sessionId), index || 1) }
    }
    return undefined
  }

  const ownerFor = (referenceId: string): RevealOwner | undefined => {
    const detail = referenceDetail(referenceId)
    if (detail === undefined) return undefined
    const { snapshot } = detail
    return {
      sessionId: referenceOwnerKey(snapshot.owner.sessionId ?? detail.sessionId),
      browserSessionId: detail.browserSessionId,
      label: snapshot.source.title,
      ...(snapshot.source.frameRoute === undefined ? {} : { frameRoute: snapshot.source.frameRoute }),
      ...(snapshot.source.frameSelector === undefined ? {} : { frameSelector: snapshot.source.frameSelector }),
    }
  }

  const revealer = createProductionRevealer({
    http,
    resolveOwner: ownerFor,
    currentSessionId: () => current,
    onActivate: activateUri,
    // A failed reply-side source link (linkSpec.onActivate) now surfaces the
    // same dock hint as the document-level bridge (B6). A retry in progress
    // stays quiet: intermediate "still on the wrong page" hints would flash
    // while the source page is loading.
    report: status => { if (mutedReveal === 0) showReveal(status) },
  })

  const revealReference = async (referenceId: string, partId?: string): Promise<RevealStatus> => {
    sourceOpening?.abort()
    const opening = new AbortController()
    sourceOpening = opening
    const intent = ++revealIntent
    const sessionId = current
    const active = (): boolean => !disposed && intent === revealIntent && current === sessionId
    const uri = encodeBrowserRefUri({ referenceId, ...(partId === undefined ? {} : { partId }) })
    const attempt = async (sourcePageId?: string): Promise<RevealStatus> => {
      if (!active()) return 'superseded'
      mutedReveal += 1
      try { return await revealer.activate(uri, { sourcePageId }) }
      finally { mutedReveal -= 1 }
    }
    let status = await attempt()
    try {
      const url = referenceDetail(referenceId)?.snapshot.source.pageUrl
      if (active() && (status === 'session-unavailable' || status === 'page-mismatch') && url && sourceOpener !== undefined) {
        const ready = await sourceOpener(url, opening.signal)
        status = await attempt(ready.pageId)
      }
    } catch {
      // A tab-open refusal is not a reveal acknowledgement.
    }
    if (!active()) return 'superseded'
    showReveal(status)
    return status
  }

  const snapshot = (): DockSnapshot => {
    const availability = availabilityOf(poller.lastError)
    // The availability status is part of the cached view: a transport that went
    // from ok to offline must rebuild the snapshot even when no card changed,
    // otherwise the banner would only appear on the next unrelated repaint.
    if (cachedSnapshot !== undefined
      && cachedSnapshot.availability.status === availability.status
      && cachedSnapshot.issue === lastIssue) {
      return cachedSnapshot
    }
    const store = draftStoreFor(current)
    const assetStore = assetStoreFor(current)
    const cards = store.state().reflections
      .filter(reflection => !store.isTombstoned(reflection.referenceId))
      .map((reflection, index) => buildCardViewModel(reflection, assetStore, index + 1))
    cachedSnapshot = {
      sessionId: current,
      revision: published,
      cards,
      availability,
      ...lastReveal === undefined || lastReveal.message === '' ? {} : { reveal: lastReveal },
      ...lastIssue === undefined ? {} : { issue: lastIssue },
    }
    return cachedSnapshot
  }

  /**
   * Remove a card's references for good.
   *
   * Removal is final: the card is tombstoned in the draft store, dropped from
   * the delivery queue and removed on the plugin side in one step, so the next
   * send simply does not see it (there is no window in which it can be undone).
   */
  const removeReferences = (sessionId: string, ids: readonly string[]): void => {
    if (ids.length === 0) return
    const store = draftStoreFor(sessionId)
    for (const referenceId of ids) {
      const reflection = store.state().reflections.find(entry => entry.referenceId === referenceId)
      const intentId = reflection?.intentId ?? findIntentId(queue, referenceId)
      store.remove(referenceId)
      queue.markDeleted(referenceId)
      if (intentId !== undefined) {
        void http.remove(intentId).catch(() => undefined)
      }
    }
    markDirty()
    publish()
  }

  const runtime: ProductionRuntime = {
    currentSessionId: () => current,
    onSessionChange(listener) {
      sessionListeners.add(listener)
      return () => { sessionListeners.delete(listener) }
    },
    noteDraft(sessionId, draft) {
      if (disposed) return
      const previous = lastDraft
      lastDraft = draft
      // 上游接受消息后会清空草稿：这一刻把本会话的引用全部退役，输入框里的胶囊随之消失。
      // 之前没有任何人调用提交缝（上游补丁已删），所以发完消息输入框还留着上一次的胶囊。
      if (draft.trim() !== '' || previous.trim() === '') return
      const store = draftStoreFor(sessionId)
      const ids = store.state().groups.map(group => group.referenceId)
      if (ids.length === 0) return
      try {
        store.retire(ids)
        store.flushPendingArchive()
        for (const id of ids) { try { queue.markDeleted(id) } catch { /* 幂等 */ } }
      } catch { /* 本地清理失败不该影响已发送的消息 */ }
      markDirty()
      publish()
    },
    setSession(sessionId) {
      sessionId = referenceOwnerKey(sessionId)
      if (disposed || sessionId === current) return
      sourceOpening?.abort()
      revealIntent += 1
      clearRevealHint()
      lastReveal = undefined
      lastIssue = undefined
      // A switch must not hand the NEW conversation the OLD session's report.
      lastReport = undefined
      current = sessionId
      // Lazily materialise the new session's stores from persisted state so a
      // switch instantly exposes its recovered cards/assets/cursor.
      draftStoreFor(sessionId)
      assetStoreFor(sessionId)
      poller.setSession(sessionId)
      // 自愈：dev 下插件 fiber 可能被热替换重挂载，旧实例的 disposer 会停掉轮询，而 dock 仍挂在
      // 页面上。此时「有投递却永远不上卡、发送永远禁用」。会话每次绑定都确认轮询活着，停了就重起。
      if (pollingRequested && !disposed && !poller.isPolling()) poller.start()
      for (const listener of sessionListeners) listener(sessionId)
      markDirty()
      publish()
    },
    async pollOnce() {
      const response = await poller.pollOnce()
      publish()
      return response === undefined ? undefined : lastReport
    },
    start() {
      pollingRequested = true
      poller.start()
      if (stopWake !== undefined || typeof document === 'undefined' || typeof window === 'undefined') return
      const wake = (): void => {
        if (document.visibilityState === 'hidden') return
        void poller.pollOnce().catch(() => undefined)
      }
      window.addEventListener('focus', wake)
      document.addEventListener('visibilitychange', wake)
      stopWake = () => {
        window.removeEventListener('focus', wake)
        document.removeEventListener('visibilitychange', wake)
      }
    },
    stop() {
      stopWake?.()
      stopWake = undefined
      poller.stop()
    },
    dispose() {
      if (disposed) return
      clearRevealHint()
      stopWake?.()
      stopWake = undefined
      poller.dispose()
      revealer.dispose()
      queue.dispose()
      for (const store of stores.values()) store.dispose()
      for (const assetStore of assets.values()) assetStore.dispose()
      stores.clear()
      assets.clear()
      disposed = true
      sourceOpening?.abort()
    },
    get disposed() { return disposed },
    poller,
    cancellation,
    cards() {
      return snapshot().cards
    },
    snapshot,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    availability() {
      return availabilityOf(poller.lastError)
    },
    ownerFor,
    submission,
    projectContent({ uploaded, text }) {
      return submission.buildContent({ sessionId: current, uploaded, text })
    },
    setComment(referenceId, comment) {
      if (disposed) return false
      for (const store of stores.values()) {
        if (store.state().reflections.some(entry => entry.referenceId === referenceId)) {
          const changed = store.setComment(referenceId, comment)
          if (changed) { markDirty(); publish() }
          return changed
        }
      }
      // A card that was never materialised in a live store (recovered later).
      return false
    },
    async removeCard(referenceId) {
      const store = draftStoreFor(current)
      if (!store.state().reflections.some(entry => entry.referenceId === referenceId)) return
      removeReferences(current, [referenceId])
    },
    revealReference,
    setSourceOpener(opener) { sourceOpener = opener },
    referenceDetail,
    activateUri,
    revealer,
    exportBundle(format, sessionId) {
      return http.exportBundle(format, sessionId ?? current)
    },
    importBundle(zip) { return http.importBundle(zip) },
    draftState(sessionId) { return draftStoreFor(sessionId ?? current).state() },
    assetStore(sessionId) { return assetStoreFor(sessionId ?? current) },
  }

  return runtime
}

/** Recover an intent id from the queue's persisted deliveries by referenceId. */
function findIntentId(queue: DeliveryQueue, referenceId: string): string | undefined {
  return queue.snapshot().find(delivery => delivery.referenceId === referenceId)?.intentId
}
