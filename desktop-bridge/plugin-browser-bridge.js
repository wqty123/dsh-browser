/**
 * Plugin browser bridge (desktop side).
 *
 * WHY THIS EXISTS
 * The `dsh-builtin-browser` plugin runs inside the Node-mode desktop host, where
 * no Electron API exists — so today it spawns its own Electron window, completely
 * parallel to the desktop shell. To make the sidebar carry the agent's page
 * instead (one page, human and agent on it), somebody with Electron access has to
 * own the view. That somebody is this process.
 *
 * WHAT IT DOES
 * Exposes the desktop's webview guests (the sidebar browser's pages) over a
 * token-authenticated loopback socket, and forwards CDP to them through
 * `webContents.debugger`. It deliberately does NOT create windows or views yet:
 * the first question is whether a sidebar guest can be driven from outside at
 * all, and that is what `list` + `cdp` answer.
 *
 * HOW IT IS STARTED
 * `lib/main.js` imports this module once the app is ready (see the bridge import
 * appended before its `export {}`), and the endpoint is published to
 * `$DSH_HOME/dsh-builtin-browser-bridge.json` so the plugin can find it without
 * any user configuration.
 */
import { createServer, connect as netConnect } from 'node:net'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { writeFileSync, mkdirSync, readFileSync, unlinkSync, constants } from 'node:fs'
import { open, mkdir, unlink, link, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { app, webContents } from 'electron'
import { sidebarProxyConfig, parseSystemProxy, normalizeGuestUserAgent, shouldFallbackToSystemProxy, DEFAULT_SIDEBAR_PROXY_BYPASS } from './guest-proxy.mjs'

/**
 * The conversation's sidebar panel exists but the shell is not displaying that conversation, so no
 * webview has attached yet. A TRANSIENT display state, not a lost carrier (issue #37).
 *
 * Carried across the socket so the plugin can tell it apart from "this panel can never work": the
 * two used to share one `sidebar unavailable (...)` string, and the plugin treated both as a dead
 * carrier — switching to a self-hosted window and losing the open page, when showing the
 * conversation would have brought the page back.
 */
const PANEL_NOT_DISPLAYED = 'panel-not-displayed'
const PANEL_INITIALIZING = 'panel-initializing'

/**
 * An Error carrying a stable code, so the code survives the socket as a field rather than as text a
 * caller has to pattern-match.
 * @param {string} code - the stable identifier.
 * @param {string} message - the human-readable explanation.
 * @returns {Error} the error, with `code` set.
 */
function codedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Absolute path of the endpoint file the plugin reads.
 *
 * The fallback has to match the plugin's own (`process.env.DSH_HOME ??
 * homedir()/.dsh`, see src/browser-electron/desktop-bridge-host.ts). With a
 * bare `?? ''` an unset DSH_HOME resolves to the process CWD, so the endpoint
 * landed beside the app — while the plugin looked in ~/.dsh and never found it.
 * The failure is silent in both directions: discovery returns undefined and the
 * plugin quietly falls back to a self-hosted window, with no error anywhere.
 * Measured on DSH Desktop 0.2.0-rc.2, launched from a shortcut (no DSH_HOME in
 * its environment).
 */
function endpointFile(dshHome) {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'dsh-builtin-browser-bridge.json')
}

/** One CDP command against a guest, serialized per guest. */
const queues = new Map()

/**
 * Which owner holds which sidebar guest.
 *
 * The sidebar is a single surface shared by every DSH session, and each session runs in its own
 * plugin process with its own in-memory view map. A session could therefore only see its OWN
 * claims, and would adopt any tab it found — including one another session had opened. The
 * symptom was a URL opened in one session appearing in another's sidebar, with the first
 * session reporting failure.
 *
 * The ledger lives here because this process is the one that owns the sidebar, so it is the only
 * place where "who holds what" can be a single shared fact. Owners are per-process ids supplied
 * by the plugin; an entry is dropped when its guest disappears so a closed tab can be reused.
 */
const handles = new Map()
const retiredHandles = new Set()
const retiredSessions = new Set()
// Only pending URL opens participate. A passive guest lookup never cancels a navigation.
const pendingSidebarOpens = new Map()
const activeRequests = new Set()

/**
 * When this module was loaded, and the protocol generation it speaks.
 *
 * The bridge is imported once by `main.js` at boot, so editing the file changes nothing until the
 * host process restarts. That makes "did my restart actually load the new bridge?" a real question
 * — and a run that cannot answer it will blame the new code for the old code's behaviour. The
 * acceptance script compares this against the file's mtime and says so before testing anything.
 */
const LOADED_AT = new Date().toISOString()
const PROTOCOL = 4

/**
 * The DOM root of THIS conversation's sidebar, as JavaScript to embed in a page script.
 *
 * The shell mounts one sidebar per conversation. Only one is on screen, but every conversation's
 * panel is addressable — each carries its conversation id on the React fiber of its tab strip
 * (measured on the running app: two containers, two ids). So an operation belongs to the panel of
 * the conversation that asked, and NOT to whatever happens to be on screen.
 *
 * That distinction is the whole bug: driving "whatever is on screen" meant an operation issued
 * while the human read another conversation typed into THAT conversation's address bar and
 * navigated its page. Scoping every query to this root is what makes sessions unable to interfere
 * with each other — there is no path from here to somebody else's panel.
 *
 * @param sessionId - the conversation this process serves (the request's `owner`).
 * @returns an expression evaluating to the panel element, or null when there is none.
 */
function panelRootExpression(sessionId) {
  return `(() => {
    const sessionOf = (el) => {
      const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (key === undefined) return null;
      let fiber = el[key];
      let depth = 0;
      while (fiber !== null && fiber !== undefined && depth < 60) {
        const props = fiber.memoizedProps;
        if (props !== null && typeof props === 'object' && typeof props.sessionId === 'string') return props.sessionId;
        fiber = fiber.return;
        depth += 1;
      }
      return null;
    };
    const wanted = ${JSON.stringify(String(sessionId))};
    const mine = Array.from(document.querySelectorAll('[class*=_tabStrip]')).find(el => sessionOf(el) === wanted);
    if (mine === undefined) return null;
    return mine.closest('[class*=_tabHost]') ?? mine.parentElement ?? mine;
  })()`
}

/**
 * Run a page script against THIS conversation's panel.
 *
 * Rather than editing ten DOM queries to use a different root — and leaving the eleventh to be
 * forgotten — the document-level lookups are redirected for the duration of the script. Every
 * existing query then answers from the right panel without knowing it, and a script that would
 * have reached somebody else's panel finds nothing instead.
 *
 * The redirection is synchronous and restored in a `finally`, so React's own event handlers (which
 * capture their references) are unaffected.
 *
 * @param shellId - the shell window's webContents id.
 * @param expression - the page script to run.
 * @param sessionId - the conversation this process serves.
 * @returns the CDP answer, or a synthetic NO_PANEL verdict.
 */
async function evaluateInPanel(shellId, sessionId, method, params) {
  // Only a real conversation id can be matched against the shell's panels. A host that could not
  // supply one keeps the previous, unscoped behaviour: losing the scoping beats losing every DOM
  // path, and the ownership guard treats such a host the same way.
  if (typeof sessionId !== 'string' || !sessionId.startsWith('session-')) {
    return sendCdp(shellId, method, params)
  }
  if (method !== 'Runtime.evaluate' || typeof params?.expression !== 'string') {
    return sendCdp(shellId, method, params)
  }
  const body = params.expression
  const script = `(() => {
    const panel = ${panelRootExpression(sessionId)};
    if (panel === null) return JSON.stringify({ noPanel: true });
    const realQuery = document.querySelector.bind(document);
    const realQueryAll = document.querySelectorAll.bind(document);
    document.querySelector = (selector) => panel.querySelector(selector);
    document.querySelectorAll = (selector) => panel.querySelectorAll(selector);
    try {
      return (${body});
    } finally {
      document.querySelector = realQuery;
      document.querySelectorAll = realQueryAll;
    }
  })()`
  const shell = guestById(shellId)
  if (shell === undefined || shell.isDestroyed()) return { result: { value: 'NO_SHELL' } }
  // `executeJavaScript`, for the same measured reason as `evaluatePanelService`: the debugger
  // attachment to the shell WINDOW hangs while the same channel to a guest page answers at once.
  // These calls are the same kind — one synchronous page script whose answer is a string — so none
  // of them needs the protocol. The reply keeps the CDP shape because every caller reads
  // `answer.result.value`.
  let value
  try {
    value = await shell.executeJavaScript(script, true)
  } catch (error) {
    return { result: { value: '' } }
  }
  // `typeof` below already tolerates an absent value; the fallback keeps the shape explicit for
  // the scanner in tests/bridge-reply-shape.test.mjs, which exists because a bare read of a reply
  // once made a probe answer `undefined` forever.
  const text = typeof value === 'string' ? value : ''
  if (text.includes('"noPanel":true')) {
    return { result: { value: 'NO_PANEL' } }
  }
  return { result: { value: text } }
}


function guestById(id) {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.id === id) return contents
  }
  return undefined
}

/** Describe one candidate guest. */
function describe(contents) {
  let url = ''
  let title = ''
  try { url = contents.getURL() } catch { /* destroyed */ }
  try { title = contents.getTitle() } catch { /* destroyed */ }
  return {
    id: contents.id,
    type: contents.getType(),
    url,
    title,
    destroyed: contents.isDestroyed(),
  }
}

/**
 * Send one CDP command to a guest, attaching its debugger on first use.
 * Attaching is per-webContents and idempotent; a destroyed guest drops the
 * attachment so a later guest with a recycled id is not mistaken for this one.
 */
const CDP_COMMAND_TIMEOUT_MS = 15_000
const timedOutGuests = new WeakSet()

async function sendCdp(id, method, params, checkCurrent) {
  const guest = guestById(id)
  if (guest === undefined || guest.isDestroyed()) throw new Error(`guest ${id} is not available`)
  const previous = queues.get(id) ?? Promise.resolve()
  const guarded = previous.then(async () => {
    checkCurrent?.()
    const current = guestById(id)
    if (current !== guest || current.isDestroyed()) throw new Error(`guest ${id} is not available`)
    if (timedOutGuests.has(current)) throw new Error(`guest ${id} has a timed-out command; close and reopen its page before sending more commands`)
    let timer
    try {
      return await Promise.race([
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            // A renderer command cannot be cancelled reliably, even by detaching its debugger.
            // Never send another command to this page while its effects remain uncertain.
            timedOutGuests.add(current)
            reject(new Error(`cdp command ${method} on guest ${id} did not answer within ${CDP_COMMAND_TIMEOUT_MS}ms; close and reopen its page before sending more commands`))
          }, CDP_COMMAND_TIMEOUT_MS)
          timer.unref?.()
        }),
        execute(),
      ])
    } finally {
      clearTimeout(timer)
    }
    async function execute() {
      // Chromium's CDP keyboard handler can redirect a webview command to the embedder's
      // focused guest. Send text and keys to this exact guest instead, preserving OS focus.
      if (current.getType() === 'webview') {
        if (method === 'Input.insertText') {
          if (typeof params?.text !== 'string') throw new Error('Input.insertText requires text')
          await current.insertText(params.text)
          return {}
        }
        if (method === 'Input.dispatchKeyEvent') {
          const event = nativeKeyEvent(params)
          current.sendInputEvent(event)
          if (params.type === 'keyDown' && typeof params.text === 'string' && params.text !== '') {
            current.sendInputEvent({ ...event, type: 'char', keyCode: params.text })
          }
          return {}
        }
      }
      if (!current.debugger.isAttached()) current.debugger.attach('1.3')
      return await current.debugger.sendCommand(method, params ?? {})
    }
  })
  // Keep the chain alive on failure so one bad command does not wedge the guest.
  queues.set(id, guarded.catch(() => undefined))
  return await guarded
}

/** Convert CDP key data for Electron's per-webContents input channel. */
function nativeKeyEvent(params) {
  const type = params?.type
  if (!['keyDown', 'rawKeyDown', 'keyUp', 'char'].includes(type)) throw new Error('unsupported keyboard event type')
  const aliases = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', ' ': 'Space' }
  const key = type === 'char' ? params.text : params.key
  if (typeof key !== 'string' || key === '') throw new Error('keyboard event requires a key')
  const mask = Number(params.modifiers ?? 0)
  const modifiers = []
  for (const [bit, name] of [[1, 'alt'], [2, 'control'], [4, 'meta'], [8, 'shift']]) {
    if ((mask & bit) !== 0) modifiers.push(name)
  }
  if (params.isKeypad === true || params.location === 3) modifiers.push('isKeypad')
  if (params.autoRepeat === true) modifiers.push('isAutoRepeat')
  return { type: type === 'rawKeyDown' ? 'keyDown' : type, keyCode: type === 'char' ? key : aliases[key] ?? key, modifiers }
}

/** Download with this guest's authenticated session, streaming directly into an exclusive file. */
async function downloadGuest(guest, url, savePath) {
  let scheme
  try { scheme = new URL(String(url)).protocol } catch { scheme = undefined }
  if (typeof url !== 'string' || !['http:', 'https:'].includes(scheme)) {
    throw new Error('download requires an HTTP(S) URL')
  }
  if (typeof savePath !== 'string' || !isAbsolute(savePath)) throw new Error('download requires an absolute savePath')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 55_000)
  let file
  let reader
  let temporary
  const limit = 256 * 1024 * 1024
  try {
    const response = await guest.session.fetch(url, { credentials: 'include', signal: controller.signal })
    if (!response.ok) throw new Error('download HTTP ' + response.status)
    if (Number(response.headers.get('content-length') ?? 0) > limit) throw new Error('download too large (limit ' + limit + ' bytes)')
    await mkdir(dirname(savePath), { recursive: true })
    temporary = join(dirname(savePath), '.dsh-download-' + randomBytes(16).toString('hex') + '.part')
    file = await open(temporary, 'wx', 0o600)
    reader = response.body?.getReader()
    let total = 0
    if (reader !== undefined) {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        total += chunk.value.byteLength
        if (total > limit) throw new Error('download too large (limit ' + limit + ' bytes)')
        for (let offset = 0; offset < chunk.value.byteLength;) {
          const { bytesWritten } = await file.write(chunk.value, offset, chunk.value.byteLength - offset)
          if (bytesWritten === 0) throw new Error('download file write made no progress')
          offset += bytesWritten
        }
      }
    }
    await file.close()
    file = undefined
    controller.signal.throwIfAborted()
    try {
      await link(temporary, savePath)
    } catch (error) {
      if (!['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'ENOSYS'].includes(error?.code)) throw error
      await copyFile(temporary, savePath, constants.COPYFILE_EXCL)
    }
  } finally {
    controller.abort()
    await file?.close().catch(() => {})
    await reader?.cancel().catch(() => {})
    if (temporary !== undefined) await unlink(temporary).catch(() => {})
    clearTimeout(timer)
  }
}

/**
 * Ask the shell's renderer for THIS conversation's browser panel, and report its guest.
 *
 * The renderer is the only side that knows which sidebar belongs to which conversation: the
 * shell mounts one per conversation and keeps the DSH session id on each. The plugin's own
 * client half carries that knowledge and publishes it as `globalThis.__dshBuiltinBrowser`; it
 * calls the shell's `openTabIn(sessionId, …)`, which navigates BY CONVERSATION ID rather than
 * by what the shell happens to be displaying.
 *
 * Nothing here inspects the DOM, dispatches a key, or clicks an element — it evaluates one call
 * on a global the plugin itself published, and that global does the scoping internally.
 *
 * @param shellId - the shell window's webContents id.
 * @param sessionId - the conversation that asked (the request's `owner`).
 * @param url - address to load when a panel has to be opened.
 * @returns the renderer's verdict, normalized so a malformed answer is a named failure.
 */
async function evaluatePanelService(shellId, sessionId, url, viewId, guestId, deadline = Date.now() + 30_000, transactionId) {
  const target = JSON.stringify({
    viewId, deadline, transactionId,
    ...Number.isSafeInteger(guestId) && guestId > 0 ? { guestId } : {},
  })
  const expression = `(async () => {
    const api = globalThis.__dshBuiltinBrowser;
    if (!api || api.panelProtocol < 5 || typeof api.initializePanel !== 'function') {
      return JSON.stringify({ ok: false, code: 'panel-initialization-failed', reason: 'reload the browser plugin client for transactional sidebar initialization' });
    }
    try {
      const answer = await api.initializePanel(${JSON.stringify(String(sessionId))}, ${JSON.stringify(String(url ?? ''))}, ${target});
      answer.backgroundRendering = typeof api.isBackgroundRendering === 'function'
        && api.isBackgroundRendering(${JSON.stringify(String(sessionId))}) === true;
      return JSON.stringify(answer);
    } catch (error) {
      return JSON.stringify({ ok: false, code: error?.code, reason: String(error?.message ?? error) });
    }
  })()`
  // `executeJavaScript`, NOT the debugger/CDP path.
  //
  // Measured on the running shell: the debugger attachment to the shell WINDOW is unreliable — its
  // commands hang, repeatedly and for minutes, while the same channel to a guest page answers at
  // once. Nothing here needs the protocol: it is one transaction on a global the plugin itself
  // published. `executeJavaScript` reaches the page's main world directly, with no attachment to go
  // stale and no reply to be lost. The guest path keeps CDP, because driving a PAGE genuinely needs
  // it (`Runtime.evaluate`, `Page.*`, `Input.*`).
  const shell = guestById(shellId)
  if (shell === undefined || shell.isDestroyed()) {
    return { ok: false, reason: 'the shell window is gone', panel: false, guestId: null, url: '' }
  }
  let value
  try {
    value = await shell.executeJavaScript(expression, true)
  } catch (error) {
    return {
      ok: false,
      reason: 'the shell refused the panel request: ' + String((error && error.message) || error),
      panel: false,
      guestId: null,
      url: '',
    }
  }
  if (typeof value !== 'string' || value === '') {
    return { ok: false, reason: 'the shell did not answer the panel request', panel: false, guestId: null, url: '' }
  }
  try {
    const parsed = JSON.parse(value)
    return {
      ok: parsed?.ok === true,
      ...typeof parsed?.code === 'string' ? { code: parsed.code } : {},
      rendererNavigation: parsed?.rendererNavigation === true,
      reason: parsed?.reason === undefined ? undefined : String(parsed.reason),
      panel: parsed?.panel === true,
      created: parsed?.created === true,
      navigating: parsed?.navigating === true,
      backgroundRendering: parsed?.backgroundRendering === true,
      ...typeof parsed?.displayed === 'boolean' ? { displayed: parsed.displayed } : {},
      guestId: typeof parsed?.guestId === 'number' && Number.isFinite(parsed.guestId) ? parsed.guestId : null,
      ...typeof parsed?.tabId === 'string' ? { tabId: parsed.tabId } : {},
      url: typeof parsed?.url === 'string' ? parsed.url : '',
      // A refusal carries what the renderer found, so the reason is actionable rather than a guess.
      found: parsed?.found === undefined ? undefined : parsed.found,
      ...parsed?.initialization !== null && typeof parsed?.initialization === 'object'
        ? { initialization: parsed.initialization } : {},
    }
  } catch (error) {
    return { ok: false, reason: 'the shell answered a shape this bridge does not understand', panel: false, guestId: null, url: '' }
  }
}

/** Whether a guest is already showing the requested address (so no navigation is needed). */
function guestShows(id, url) {
  if (url === '') return true
  const guest = guestById(id)
  if (guest === undefined) return false
  try {
    const current = guest.getURL()
    // A raw prefix match mistakes https://example.com.evil/ for https://example.com.
    return current === url || current.startsWith(`${url}?`) || current.startsWith(`${url}#`)
  } catch (error) {
    return false
  }
}

// A new native sidebar tab starts its own loadURL before it exposes a guest. Confirm the
// committed main frame (including HTTP redirects) without interrupting that load with CDP.
async function committedSidebarNavigation(id, url) {
  const history = await sendCdp(id, 'Page.getNavigationHistory', {})
  const entry = history.entries?.[history.currentIndex]
  if (!entry) return undefined
  const wanted = new URL(url).href
  if (entry.userTypedURL !== wanted && entry.url !== wanted) return undefined
  const { frameTree } = await sendCdp(id, 'Page.getFrameTree', {})
  const frame = frameTree?.frame
  if (!frame || typeof frame.id !== 'string' || frame.id === '' || typeof frame.loaderId !== 'string' || frame.loaderId === '') return undefined
  if (frame.unreachableUrl) throw codedError('panel-navigation-failed', 'the sidebar could not load ' + frame.unreachableUrl)
  // The main frame and history must acknowledge the same committed document.
  if (frame.url + (frame.urlFragment ?? '') !== entry.url) return undefined
  return { frameId: frame.id, loaderId: frame.loaderId }
}

/**
 * Which kind of frame the sidebar browser panel is built from, on this shell.
 *
 * The official panel renders as a `<webview>` only where the shell exposes `dshDesktop.browser`
 * AND enables `webviewTag`; where it does neither it renders as an `<iframe>`. An iframe has no
 * webContents, no `getWebContentsId()` and therefore no CDP endpoint — and every tool this plugin
 * offers is built on CDP. So a bridge adopted against one cannot work, and reports a failure on
 * every call instead of falling back to a carrier that does.
 *
 * Measured on DSH Desktop 2.0.17: `lib/preload.cjs` exposes only `protocolVersion`, and the shell
 * window sets `webviewTag: false`. Neither is something the plugin can repair, and both are visible
 * from the renderer — which is why this is read rather than inferred from a timeout 20 seconds
 * later.
 *
 * Read WITHOUT a conversation, because the answer is a property of the shell rather than of any
 * panel: both conditions are fixed when the window is created. That also keeps the liveness probe
 * owner-less, which it must stay — it is not acting for anyone.
 *
 * @param shellId - the shell window's webContents id, when one is visible.
 * @returns 'webview' | 'iframe' | 'none' (no panel yet) | 'unknown' (could not be read).
 */
async function sidebarFrameKind(shellId) {
  if (typeof shellId !== 'number') return 'unknown'
  try {
    // `executeJavaScript`, not the debugger: the same measured reason as every other shell-side
    // read — an attachment to the shell WINDOW hangs while the same call answers immediately.
    const shell = guestById(shellId)
    if (shell === undefined || shell.isDestroyed()) return 'unknown'
    const value = await shell.executeJavaScript(`(() => {
      const el = document.querySelector('[data-sidebar-browser-frame]');
      if (el === null || el === undefined) return 'none';
      return el.getAttribute('data-sidebar-browser-frame') || 'unknown';
    })()`, true)
    return typeof value === 'string' && value !== '' ? value : 'unknown'
  } catch {
    // An unreadable panel is not evidence of an iframe: 'unknown' keeps discovery from refusing a
    // carrier merely because this probe ran before the panel existed.
    return 'unknown'
  }
}

/** Read the exact guest set from the named conversation's renderer, never from free globals. */
async function panelGuestIds(shell, owner) {
  if (!/^session-/.test(owner)) return []
  const value = await shell.executeJavaScript(`(() => {
    const api = globalThis.__dshBuiltinBrowser;
    if (!api || typeof api.panelGuests !== 'function') {
      throw new Error('sidebar page identity API is unavailable; refresh or upgrade the browser plugin client');
    }
    return JSON.stringify(api.panelGuests(${JSON.stringify(owner)}));
  })()`, true)
  let ids
  try { ids = JSON.parse(value) } catch { throw new Error('invalid sidebar page identity reply; refresh or upgrade the browser plugin client') }
  if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('invalid sidebar page identity reply; refresh or upgrade the browser plugin client')
  }
  return ids
}

/** Handle one JSON request line; every answer is a JSON line too. */
async function handle(request, signal) {
  signal?.throwIfAborted()
  if (['owner', 'id', 'viewId', 'logicalViewId'].some(key => Object.hasOwn(request, key))) {
    throw codedError('BROWSER_HANDLE_REQUIRED', 'the bridge requires canonical handles, not local ids')
  }
  const owner = ['ensureSidebar', 'cdp', 'download'].includes(request?.op) ? wireHandle(request.handle, 'tab').owner : undefined
  const controller = new AbortController()
  const checkCurrent = () => controller.signal.throwIfAborted()
  if (request?.op === 'ensureSidebar') request = { ...request,
    transactionId: request.transactionId ?? randomBytes(16).toString('hex'),
    deadline: Number.isFinite(request.deadline) ? request.deadline : Date.now() + 30_000,
  }
  checkCurrent()
  const shell = /^session-/.test(owner)
    ? webContents.getAllWebContents().find(contents => contents.getType() === 'window') : undefined
  const token = randomBytes(16).toString('hex')
  let held
  let releasePromise
  const release = () => {
    if (held === false) return Promise.resolve()
    const run = async () => {
      try {
        await shell.executeJavaScript(`globalThis.__dshBuiltinBrowser?.releaseRendering?.(${JSON.stringify(token)})`, true)
      } catch (error) { console.error('[dsh-browser-bridge] rendering hold release failed:', error) }
    }
    return held === undefined ? run() : releasePromise ??= run()
  }
  let rejectAborted
  const aborted = new Promise((_resolve, reject) => { rejectAborted = reject })
  const onAbort = () => {
    rejectAborted(controller.signal.reason)
    if (shell !== undefined) {
      void release()
      if (request.op === 'ensureSidebar') {
        void shell.executeJavaScript(`globalThis.__dshBuiltinBrowser?.cancelPanelInitialization?.(${JSON.stringify(owner)}, ${JSON.stringify(request.handle)}, ${JSON.stringify(request.transactionId)})`)
          .catch(error => console.error('[dsh-browser-bridge] initialization cancellation failed:', error))
      }
    }
  }
  const forwardAbort = () => controller.abort(signal.reason)
  controller.signal.addEventListener('abort', onAbort, { once: true })
  signal?.addEventListener('abort', forwardAbort, { once: true })
  activeRequests.add(controller)
  const timer = request?.op === 'ensureSidebar' ? setTimeout(() => controller.abort(
    codedError('BROWSER_DOCUMENT_TIMEOUT', 'sidebar initialization deadline expired')), Math.max(0, request.deadline - Date.now())) : undefined
  const run = async () => {
    try {
      checkCurrent()
      if (shell !== undefined) {
        held = await shell.executeJavaScript(`(async () => {
          const api = globalThis.__dshBuiltinBrowser;
          if (typeof api?.holdRendering !== 'function') return false;
          return api.holdRendering(${JSON.stringify(owner)}, ${JSON.stringify(token)});
        })()`, true) === true
      }
      checkCurrent()
      return await handleRequest(request, checkCurrent, controller)
    } finally {
      if (shell !== undefined) await release()
    }
  }
  try {
    return await Promise.race([run(), aborted])
  } finally {
    clearTimeout(timer)
    activeRequests.delete(controller)
    signal?.removeEventListener('abort', forwardAbort)
    controller.signal.removeEventListener('abort', onAbort)
    if (shell !== undefined) await release()
  }
}

async function handleRequest(request, checkCancelled, controller) {
  const op = String(request?.op ?? '')
  if (op !== 'ensureSidebar' && op !== 'cancelSidebar') return dispatch(request, checkCancelled)
  const scope = wireHandle(request.handle, 'tab')
  const key = request.handle
  if (op === 'cancelSidebar') {
    const pending = pendingSidebarOpens.get(key)
    if (typeof request.transactionId !== 'string' || pending?.transactionId !== request.transactionId) return { ok: true, cancelled: false }
    pending.cancelled = true
    pending.abort()
    const shell = webContents.getAllWebContents().find(contents => contents.getType() === 'window')
    if (shell) await shell.executeJavaScript(`globalThis.__dshBuiltinBrowser?.cancelPanelInitialization?.(${JSON.stringify(scope.owner)}, ${JSON.stringify(key)}, ${JSON.stringify(request.transactionId)})`)
    return { ok: true, cancelled: true }
  }
  const token = { transactionId: request.transactionId, cancelled: false,
    abort: () => controller.abort(codedError('BROWSER_NAVIGATION_CANCELLED', 'sidebar initialization was cancelled')) }
  pendingSidebarOpens.set(key, token)
  const checkCurrent = () => {
    checkCancelled?.()
    if (token.cancelled) throw codedError('BROWSER_NAVIGATION_CANCELLED', 'sidebar initialization was cancelled')
    if (pendingSidebarOpens.get(key) !== token) throw codedError('panel-navigation-superseded', 'a newer navigation was requested for this sidebar view')
  }
  try { return await dispatch(request, checkCurrent) }
  finally { if (pendingSidebarOpens.get(key) === token) pendingSidebarOpens.delete(key) }
}

function wireHandle(wire, kind) {
  const prefix = kind === 'tab' ? 'dsh-tab:v1:' : 'dsh-session:v1:'
  let values
  try {
    if (typeof wire !== 'string' || !wire.startsWith(prefix)) throw new Error()
    values = JSON.parse(decodeURIComponent(wire.slice(prefix.length)))
    if (!Array.isArray(values) || values.length !== (kind === 'tab' ? 3 : 2)
      || values.some(value => typeof value !== 'string' || value === '')) throw new Error()
    if (prefix + encodeURIComponent(JSON.stringify(values)) !== wire) throw new Error()
  } catch { throw codedError('BROWSER_HANDLE_INVALID', 'invalid or noncanonical browser handle') }
  const [owner, session, tab] = values
  const sessionKey = 'dsh-session:v1:' + encodeURIComponent(JSON.stringify([owner, session]))
  if (retiredHandles.has(wire) || retiredSessions.has(sessionKey)) throw codedError('BROWSER_HANDLE_STALE', 'the browser handle was released')
  return { owner, session, tab }
}

function retireHandle(handle) {
  handles.delete(handle)
  retiredHandles.add(handle)
}

function boundGuest(handle) {
  wireHandle(handle, 'tab')
  const entry = handles.get(handle)
  if (!entry || entry.guest.isDestroyed() || guestById(entry.guest.id) !== entry.guest) {
    retireHandle(handle)
    throw codedError('BROWSER_HANDLE_STALE', 'the browser tab handle is stale; list tabs again')
  }
  return entry.guest
}

function bindGuest(handle, guest) {
  const scope = wireHandle(handle, 'tab')
  const held = handles.get(handle)
  if (held && held.guest !== guest) throw codedError('BROWSER_HANDLE_STALE', 'the browser tab was rebound; list tabs again')
  for (const [key, entry] of handles) {
    if (entry.guest === guest && key !== handle
      && (entry.owner !== scope.owner || entry.session === scope.session)) retireHandle(key)
  }
  handles.set(handle, { ...scope, guest })
}

async function dispatch(request, checkCurrent) {
  checkCurrent?.()
  const op = String(request?.op ?? '')
  // Which build is answering. The acceptance script asks this first, because everything else it
  // measures is meaningless if the host is still running the previous bridge.
  if (op === 'version') {
    const api = globalThis[ACTIVE]?.api
    const home = resolve(api?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
    return { ok: true, loadedAt: LOADED_AT, protocol: PROTOCOL,
      bridgeVersion: api?.bridgeVersion, bridgeBuild: api?.bridgeBuild,
      homeId: createHash('sha256').update(process.platform === 'win32' ? home.toLowerCase() : home).digest('hex'),
      mainExtension: typeof api?.mainExtensions?.status === 'function'
        ? await api.mainExtensions.status('dsh-builtin-browser') : { code: 'DESKTOP_MAIN_EXTENSION_UNSUPPORTED' } }
  }
  const shell = webContents.getAllWebContents().find(contents => contents.getType() === 'window')
  if (op === 'list') {
    const frame = await sidebarFrameKind(shell?.id)
    if (request.handle === undefined) return { ok: true, protocol: PROTOCOL, frame }
    const scope = wireHandle(request.handle, 'session')
    const ids = shell === undefined ? [] : await panelGuestIds(shell, scope.owner)
    const sidebar = []
    for (const id of ids) {
      const guest = guestById(id)
      if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') continue
      let handle
      for (const [key, entry] of handles) {
        if (entry.owner === scope.owner && entry.session === scope.session && entry.guest === guest) { handle = key; break }
      }
      if (handle === undefined) handle = 'dsh-tab:v1:' + encodeURIComponent(JSON.stringify([scope.owner, scope.session, 'page:' + randomUUID()]))
      bindGuest(handle, guest)
      sidebar.push({ ...describe(guest), id: handle })
    }
    return { ok: true, protocol: PROTOCOL, sidebar, frame }
  }
  const scope = wireHandle(request.handle, op === 'collapseSidebar' || op === 'releaseSession' ? 'session' : 'tab')
  const owner = scope.owner
  if (op === 'releaseTab') {
    retireHandle(request.handle)
    return { ok: true }
  }
  if (op === 'releaseSession') {
    retiredSessions.add(request.handle)
    for (const [key, entry] of handles) {
      if (entry.owner === owner && entry.session === scope.session) retireHandle(key)
    }
    for (const [key, token] of pendingSidebarOpens) {
      const values = JSON.parse(decodeURIComponent(key.slice('dsh-tab:v1:'.length)))
      if (values[0] === owner && values[1] === scope.session) token.cancelled = true
    }
    return { ok: true }
  }
  if (op === 'ensureSidebar') {
    if (!shell) throw new Error('no shell window to drive')
    if (!/^session-/.test(owner)) throw new Error('this host supplied no conversation id, so its own panel cannot be identified')
    if (handles.has(request.handle)) boundGuest(request.handle)
    const url = request.url === undefined ? '' : String(request.url)
    const deadline = Number.isFinite(request.deadline) ? request.deadline : Date.now() + 30_000
    if (Date.now() >= deadline) throw codedError('BROWSER_INITIALIZATION_TIMEOUT', 'sidebar initialization deadline expired')
    checkCurrent?.()
    const first = await evaluatePanelService(shell.id, owner, url, request.handle, undefined, deadline, request.transactionId)
    checkCurrent?.()
    if (first.ok !== true) {
      const error = codedError(first.code || (first.reason === 'panel-not-displayed' ? PANEL_NOT_DISPLAYED : 'panel-initialization-failed'), 'sidebar unavailable (' + String(first.reason ?? 'renderer refused initialization') + ')')
      if (first.initialization) error.initialization = first.initialization
      throw error
    }
    if (first.guestId === null) throw codedError('BROWSER_DOCUMENT_UNACKNOWLEDGED', 'sidebar initialization did not acknowledge a guest')
    const guest = guestById(first.guestId)
    if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') throw codedError('BROWSER_GUEST_CLOSED', 'the acknowledged sidebar guest is gone')
    const existing = handles.get(request.handle)
    if (existing && existing.guest !== guest) throw codedError('BROWSER_HANDLE_STALE', 'the sidebar returned a replacement guest')
    let navigation
    if (first.rendererNavigation || (url !== '' && (first.created || first.navigating))) {
      if (first.initialization?.stage !== 'attached' || first.initialization.guestId !== String(first.guestId)) {
        throw codedError('BROWSER_DOCUMENT_UNACKNOWLEDGED', 'the native guest does not match its initialization receipt')
      }
      navigation = await committedSidebarNavigation(first.guestId, url)
      checkCurrent?.()
      if (!navigation) throw codedError('BROWSER_DOCUMENT_UNACKNOWLEDGED', 'the native guest did not acknowledge the requested document')
    }
    if (Date.now() >= deadline) throw codedError('BROWSER_DOCUMENT_TIMEOUT', 'sidebar initialization deadline expired')
    bindGuest(request.handle, guest)
    if (!request.attachOnly && !guestShows(guest.id, url)) {
      navigation = await sendCdp(guest.id, 'Page.navigate', { url }, checkCurrent)
      checkCurrent?.()
      if (navigation?.errorText) throw codedError('panel-navigation-failed', String(navigation.errorText))
    }
    return { ok: true, created: first.created, id: request.handle, via: 'panel', ...navigation ? { navigation } : {} }
  }
  if (op === 'collapseSidebar') {
    if (!shell) throw new Error('no shell window to drive')
    if (!/^session-/.test(owner)) throw new Error('collapseSidebar requires a conversation id')
    const folded = await evaluateInPanel(shell.id, owner, 'Runtime.evaluate', {
      expression: `(() => {
        const button = Array.from(document.querySelectorAll('button')).find(b => /收起右侧边栏/.test((b.getAttribute('aria-label') || '') + (b.textContent || '')));
        if (button === undefined) return 'NOT_OPEN';
        button.click();
        return 'COLLAPSED';
      })()`,
      returnByValue: true,
    })
    return { ok: true, result: folded?.result?.value ?? 'NOT_OPEN' }
  }
  if (op === 'adoptPage') {
    if (!handles.has(request.handle)) {
      const match = /^page:([1-9]\d*)$/.exec(scope.tab)
      const ids = shell === undefined ? [] : await panelGuestIds(shell, owner)
      const guest = match && ids.includes(Number(match[1])) ? guestById(Number(match[1])) : undefined
      if (!guest || guest.isDestroyed() || guest.getType() !== 'webview') throw codedError('BROWSER_HANDLE_STALE', 'the source page is not in this conversation panel')
      bindGuest(request.handle, guest)
    }
    boundGuest(request.handle)
    return { ok: true, id: request.handle }
  }
  const guest = boundGuest(request.handle)
  if (op === 'cdp') return { ok: true, result: await sendCdp(guest.id, String(request.method ?? ''), request.params, checkCurrent) }
  if (op === 'download') {
    await downloadGuest(guest, request.url, request.savePath)
    return { ok: true, path: request.savePath }
  }
  if (op === 'showTab') {
    if (!shell) throw new Error('no shell window to drive')
    const shown = await evaluatePanelService(shell.id, owner, '', request.handle, guest.id)
    if (shown.ok !== true || shown.guestId !== guest.id) throw new Error('could not select the requested sidebar tab: ' + String(shown.reason ?? 'the requested guest is not displayed yet'))
    return { ok: true, verdict: 'SELECTED' }
  }
  if (op === 'closePage') {
    if (!shell) throw new Error('no shell window to drive')
    const value = await shell.executeJavaScript(`(() => {
      const api = globalThis.__dshBuiltinBrowser;
      if (!api || typeof api.closePanelGuest !== 'function') throw new Error('sidebar close API is unavailable; refresh or upgrade the browser plugin client');
      return JSON.stringify(api.closePanelGuest(${JSON.stringify(owner)}, ${guest.id}));
    })()`, true)
    let answer
    try { answer = JSON.parse(value) } catch { throw new Error('invalid sidebar close reply') }
    if (answer?.ok !== true || answer.closed !== 1) throw new Error(String(answer?.reason ?? 'the sidebar did not close the requested page'))
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      if (guestById(guest.id) !== guest || guest.isDestroyed()) {
        for (const [key, entry] of handles) if (entry.guest === guest) retireHandle(key)
        return { ok: true, closed: 1 }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('the sidebar close action did not remove the requested page')
  }
  throw new Error(`unknown op ${JSON.stringify(op)}`)
}


/**
 * When the bridge instance currently running was constructed.
 *
 * Recorded once and republished unchanged, because a reader uses it to answer "how long has this
 * bridge been up". Refreshing it on every keepalive made it mean "the last keepalive" instead: a
 * reporter read two values 15 seconds apart, concluded the bridge had restarted, and only noticed
 * otherwise because the port had not changed. Each module evaluation gets its own value, so a
 * genuinely new instance is still reported as such.
 */
const instanceStartedAt = (() => {
  const at = new Date().toISOString()
  return () => at
})()

/**
 * Publish the endpoint, and keep it published.
 *
 * A single write at startup is not enough: two shells can overlap during a
 * restart (the outgoing one may write LAST, leaving the file pointing at a dead
 * pid), and a reader that trusts it then fails with ECONNREFUSED for reasons
 * that have nothing to do with the plugin. So the file is rewritten periodically
 * by the process that actually owns the listener, and readers are told the pid
 * so they can verify liveness themselves.
 */
function publishEndpoint(port, token, dshHome) {
  const payload = {
    port,
    token,
    pid: process.pid,
    startedAt: instanceStartedAt(),
    updatedAt: new Date().toISOString(),
  }
  try {
    const file = endpointFile(dshHome)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
    return true
  } catch (error) {
    console.error('[dsh-browser-bridge] could not publish the endpoint file:', error)
    return false
  }
}

/**
 * The running bridge instance, keyed on globalThis so it survives a reload.
 *
 * A cache-busted re-import evaluates a FRESH module instance with its own
 * module-level state. A plain module-scoped variable would therefore leave the
 * previous bridge running: two keepalives would alternate writing the endpoint
 * file and hand clients a port that is already closed. Symbol.for keeps the key
 * identical across every instance of this module.
 */
const ACTIVE = Symbol.for("dsh-builtin-browser.bridge.active")

/**
 * Stop the running bridge: clears its keepalive timer, closes its listener and
 * drops its quit hook. Idempotent and never throws, so the shell can call it
 * before re-importing an edited bridge.
 */
/** A webview caches its UA at WebContents creation, so each guest needs its own override. */
const uaConfiguredContents = new WeakSet()
/** `did-fail-load` handlers attached by start(), keyed by WebContents. */
const fallbackHandlers = new Map()
/** Guest session -> the exact proxy config we applied (absent = OS settings are in charge). */
const proxyApplied = new WeakMap()

/** Cheap liveness check so a stopped proxy daemon never stays pinned into the guest session. */
function proxyReachable(authority) {
  const at = String(authority).lastIndexOf(':')
  if (at <= 0) return Promise.resolve(false)
  const host = String(authority).slice(0, at)
  const port = Number(String(authority).slice(at + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false)
  return new Promise(resolve => {
    const socket = netConnect({ host, port })
    let done = false
    const finish = ok => { if (done) return; done = true; socket.destroy(); resolve(ok) }
    socket.setTimeout(400, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Release a previously applied override and let Chromium follow the OS again. */
async function releaseGuestProxy(session) {
  try { await session.setProxy({ mode: 'system' }) } catch { /* older Electron */ }
  try { await session.closeAllConnections?.() } catch { /* older Electron */ }
  proxyApplied.delete(session)
  console.log('[dsh-browser-bridge] sidebar guest proxy released (no live proxy)')
}

/**
 * Give a Sidebar guest a normal-browser identity and a proxy policy.
 *
 * Two independent site-side problems are solved here:
 *  - "使用环境异常" / security-check banners: Electron's default UA advertises
 *    the app name and Electron version, so many sites classify the embedded
 *    webview as an unofficial/automated client.
 *  - CloudFront/WAF "Request blocked" 403: first-party DeepSeek hosts must not
 *    be forced through a rules proxy's overseas exit node.
 */
async function applySidebarGuestProxy(contents) {
  try {
    if (contents.getType() !== 'webview') return
    const session = contents.session
    if (!session) return

    // UA is per WebContents: a second tab in an already-configured partition
    // still caches the UA it was created with, so check each guest separately.
    if (process.env.DSH_SIDEBAR_UA !== 'off' && !uaConfiguredContents.has(contents)) {
      const sessionUa = typeof session.getUserAgent === 'function' ? session.getUserAgent() : ''
      const contentsUa = typeof contents.getUserAgent === 'function' ? contents.getUserAgent() : ''
      const clean = normalizeGuestUserAgent(sessionUa || contentsUa)
      const raw = sessionUa || contentsUa
      if (clean && raw !== clean) {
        // Only a guest whose UA was actually replaced counts as configured: a
        // rejected setUserAgent (older Electron, locked session) must stay
        // retryable instead of being remembered as "done" while the site keeps
        // seeing `Electron/…` and shows its "unsupported client" banner.
        let applied = true
        if (sessionUa && sessionUa !== clean) {
          if (typeof session.setUserAgent === 'function') {
            try { await session.setUserAgent(clean) } catch (error) {
              applied = false
              console.warn('[dsh-browser-bridge] sidebar guest UA (session) rejected:', error && error.message)
            }
          } else applied = false
        }
        if (contentsUa && contentsUa !== clean) {
          if (typeof contents.setUserAgent === 'function') {
            try { await contents.setUserAgent(clean) } catch (error) {
              applied = false
              console.warn('[dsh-browser-bridge] sidebar guest UA (contents) rejected:', error && error.message)
            }
          } else applied = false
        }
        if (applied) {
          console.log('[dsh-browser-bridge] sidebar guest UA:', clean)
          uaConfiguredContents.add(contents)
        }
      } else {
        // Nothing to strip (already clean) or no UA to read: remember it so a
        // clean guest is not re-checked on every guest creation.
        uaConfiguredContents.add(contents)
      }
    }

    // Proxy policy is partition-wide, but the OS setting can change while the
    // app is running (VPN / rules proxy switched on or off). Re-evaluate on
    // every new guest so a later tab picks up the current setting.
    // DEFAULT: direct. Forcing the OS rules proxy onto the guest measured
    // 15-20x slower page loads (baidu 21.6s vs 1.1s), and that proxy is also
    // what returned CloudFront 403 for first-party hosts.
    const mode = process.env.DSH_SIDEBAR_PROXY_MODE ?? 'direct'
    if (mode === 'system' || mode === 'off') {
      if (proxyApplied.has(session)) await releaseGuestProxy(session)
      return
    }
    // resolveProxy reports OUR config once fixed_servers is applied, so it is
    // only an OS reading while we have not overridden this session.
    let resolved = ''
    try { resolved = await session.resolveProxy('https://example.com/') } catch { /* no OS proxy */ }
    const explicitRules = process.env.DSH_SIDEBAR_PROXY_RULES
    const config = sidebarProxyConfig({
      mode,
      resolved,
      bypass: process.env.DSH_SIDEBAR_PROXY_BYPASS ?? DEFAULT_SIDEBAR_PROXY_BYPASS,
      rules: explicitRules,
    })
    const signature = config ? JSON.stringify(config) : ''
    const applied = proxyApplied.get(session)

    // A proxy daemon that has stopped listening must not stay pinned: every
    // non-bypassed site would fail with ERR_PROXY_CONNECTION_FAILED until the
    // app restarts. Release it and fall back to the OS setting (DIRECT here).
    if (applied && !explicitRules && mode !== 'direct') {
      const parsed = parseSystemProxy(resolved)
      if (!parsed || !(await proxyReachable(parsed.authority))) {
        await releaseGuestProxy(session)
        return
      }
    }
    if (!config) {
      // No proxy right now: leave the session in system mode so a proxy
      // enabled later is picked up without an app restart.
      if (applied) await releaseGuestProxy(session)
      return
    }
    if (applied === signature) return
    if (!explicitRules && config.mode === 'fixed_servers') {
      const parsed = parseSystemProxy(resolved)
      if (!parsed || !(await proxyReachable(parsed.authority))) {
        if (applied) await releaseGuestProxy(session)
        return
      }
    }
    await session.setProxy(config)
    // Pooled sockets created under the previous proxy would keep using it.
    try { await session.closeAllConnections?.() } catch { /* older Electron */ }
    proxyApplied.set(session, signature)
    console.log('[dsh-browser-bridge] sidebar guest proxy:', JSON.stringify(config))
  } catch (error) {
    console.error('[dsh-browser-bridge] sidebar guest proxy failed:', error)
  }
}

export function stop() {
  for (const controller of activeRequests) controller.abort(codedError('bridge-request-abandoned', 'the bridge was disposed'))
  const current = globalThis[ACTIVE]
  globalThis[ACTIVE] = undefined
  // Detach BEFORE the early return: a reload replaces this module's `start()`,
  // and a listener left on a live webContents keeps a stale closure alive that
  // still calls setProxy()/loadURL() behind the new bridge's back.
  for (const [contents, handler] of fallbackHandlers) {
    try { contents.removeListener('did-fail-load', handler) } catch { /* destroyed */ }
  }
  fallbackHandlers.clear()
  if (!current) return
  try { clearInterval(current.keepalive) } catch { /* ignore */ }
  for (const socket of current.sockets ?? []) socket.destroy()
  try { current.server.close() } catch { /* already closed */ }
  try { current.application.off('will-quit', current.onQuit) } catch { /* ignore */ }
  try { current.application.off('web-contents-created', current.onGuestCreated) } catch { /* ignore */ }
  try {
    const file = endpointFile(current.api?.dshHome)
    const endpoint = JSON.parse(readFileSync(file, 'utf8'))
    if (endpoint.token === current.token && endpoint.pid === process.pid) unlinkSync(file)
  } catch { /* absent, unreadable, or owned by a replacement instance */ }
}

/** Start the bridge: loopback listener + published endpoint file + token. */
export function start(api) {
  const current = globalThis[ACTIVE]
  if (current) {
    if (api?.reload !== true) return current.server
    if (typeof current.stop === 'function') current.stop()
    else stop()
  }
  const application = api?.app ?? app
  // Sidebar guests are created by the shell at any time (including after a
  // bridge reload), so configure both the existing guests and every future one.
  // Default policy is direct, which is fast but useless on a machine whose
  // only route out is the local proxy. Retry such a session ONCE through the
  // OS proxy on a transport-level failure (DNS/connect/timeout), so "no proxy
  // configured" environments degrade to the old behaviour instead of a blank
  // page. HTTP errors (404/500) must not trigger this.
  const attachProxyFallback = (contents) => {
    if (contents.getType() !== 'webview' || fallbackHandlers.has(contents)) return
    const handler = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      if ((process.env.DSH_SIDEBAR_PROXY_MODE ?? 'direct') !== 'direct') return
      if (!shouldFallbackToSystemProxy(errorCode)) return
      void (async () => {
        try {
          const session = contents.session
          if (!session) return
          const resolved = await session.resolveProxy('https://example.com/').catch(() => '')
          const parsed = parseSystemProxy(resolved)
          if (!parsed || !(await proxyReachable(parsed.authority))) return
          const config = {
            mode: 'fixed_servers',
            proxyRules: parsed.rules,
            proxyBypassRules: process.env.DSH_SIDEBAR_PROXY_BYPASS ?? DEFAULT_SIDEBAR_PROXY_BYPASS,
          }
          await session.setProxy(config)
          proxyApplied.set(session, JSON.stringify(config))
          try { await session.closeAllConnections?.() } catch { /* older Electron */ }
          console.log('[dsh-browser-bridge] direct failed (' + errorCode + ' ' + errorDescription + '), retrying via system proxy:', parsed.authority)
          // The probe above takes a few hundred milliseconds. If the guest is
          // gone, or the user already started another navigation, reloading the
          // failed URL would silently drag them back to the old page.
          if (typeof contents.isDestroyed === 'function' && contents.isDestroyed()) return
          const currentUrl = typeof contents.getURL === 'function' ? contents.getURL() : validatedURL
          if (currentUrl !== validatedURL) return
          contents.loadURL(validatedURL).catch(() => undefined)
        } catch (error) {
          console.error('[dsh-browser-bridge] proxy fallback failed:', error)
        }
      })()
    }
    fallbackHandlers.set(contents, handler)
    contents.on('did-fail-load', handler)
  }

  const onGuestCreated = (_event, contents) => {
    if (contents.getType() === 'webview') contents.setWindowOpenHandler?.(() => ({ action: 'deny' }))
    void applySidebarGuestProxy(contents)
    attachProxyFallback(contents)
  }
  application.on('web-contents-created', onGuestCreated)
  for (const contents of webContents.getAllWebContents()) {
    onGuestCreated(undefined, contents)
  }
  // Drop any debugger attachment this process is still holding.
  //
  // An attachment belongs to the webContents, not to this module, so it outlives both the listener
  // and the reload `main.js` performs when the file changes. A stale one is the worst kind of
  // broken: `isAttached()` answers true, so the next bridge skips its own attach, and every command
  // sent into it hangs — no error, no reply, nothing to see. A bridge that has JUST started has no
  // attachments of its own, which makes whatever is attached right now a leftover: safe to drop,
  // and exact. (If DevTools happens to be open on the shell it loses that session; the shell itself
  // is unaffected, and that is the cheaper cost.)
  try {
    for (const contents of webContents.getAllWebContents()) {
      try { if (contents.debugger.isAttached()) contents.debugger.detach() } catch { /* gone */ }
    }
  } catch { /* no webContents at all; nothing to detach */ }
  const token = randomBytes(24).toString('hex')
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    const controller = new AbortController()
    let buffer = ''
    let authed = false
    socket.setEncoding('utf8')
    const authenticationDeadline = setTimeout(() => socket.destroy(), 5_000)
    authenticationDeadline.unref?.()
    socket.on('close', () => {
      sockets.delete(socket)
      clearTimeout(authenticationDeadline)
      controller.abort(codedError('bridge-request-abandoned', 'the bridge client disconnected'))
    })
    socket.on('data', chunk => {
      if (Buffer.byteLength(buffer, 'utf8') + Buffer.byteLength(chunk, 'utf8') > 32 * 1024 * 1024) {
        socket.destroy()
        return
      }
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        if (Buffer.byteLength(line, 'utf8') > (authed ? 32 * 1024 * 1024 : 64 * 1024)) {
          socket.destroy()
          return
        }
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '') continue
        let request
        try { request = JSON.parse(line) } catch {
          socket.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n')
          if (!authed) { socket.destroy(); return }
          continue
        }
        if (request === null || typeof request !== 'object' || Array.isArray(request)) {
          socket.write(JSON.stringify({ ok: false, error: 'request must be a JSON object' }) + '\n')
          socket.destroy()
          return
        }
        if (!authed) {
          if (request.token !== token) { socket.write(JSON.stringify({ ok: false, error: 'bad token' }) + '\n'); socket.destroy(); return }
          authed = true
          clearTimeout(authenticationDeadline)
          // The authenticating message is NOT a command: a client that sends the
          // token on its own line would otherwise be answered `unknown op ""`.
          // (A client may also put the token on its first real request; both work.)
          if (typeof request.op !== 'string' || request.op === '') continue
        }
        void handle(request, controller.signal)
          // The request id is stamped HERE, at the single point where every answer is written,
          // rather than on the handful of returns that happened to remember it.
          //
          // The parent matches replies to requests by this id; when it is missing the parent
          // marks the whole connection id-less and serialisable, which drops every reply back
          // to arrival order and makes it reject in-flight requests when a second call
          // arrives. Only two of this bridge's nine reply paths carried the field, so most
          // operations permanently degraded the connection they used.
          .then(answer => socket.write(JSON.stringify({ ...answer, bridgeRequestId: request.bridgeRequestId }) + '\n'))
          .catch(error => socket.write(JSON.stringify({
            ok: false,
            error: String(error?.message ?? error),
            // The code travels as a field, not as text: a caller must not have to recognize an
            // English sentence to know whether the carrier died or the conversation is just not on
            // screen (issue #37).
            ...error?.code === undefined ? {} : { code: String(error.code) },
            ...error?.initialization === undefined ? {} : { initialization: error.initialization },
            bridgeRequestId: request.bridgeRequestId,
          }) + '\n'))
      }
      // Authentication may share a TCP chunk with the first real (larger) command. Apply the
      // unauthenticated cap to that frame, not to bytes belonging to an authenticated successor.
      if (Buffer.byteLength(buffer, 'utf8') > (authed ? 32 * 1024 * 1024 : 64 * 1024)) socket.destroy()
    })
    socket.on('error', () => { /* client went away */ })
  })
  server.on('error', error => { console.error('[dsh-browser-bridge] listen failed:', error) })
  // Loopback only, port chosen by the OS: the endpoint file is the discovery
  // mechanism, so a fixed port would only add collisions.
  server.listen(0, '127.0.0.1', () => {
    if (globalThis[ACTIVE]?.server !== server) { server.close(); return }
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    if (publishEndpoint(port, token, api?.dshHome)) {
      console.log(`[dsh-browser-bridge] listening on 127.0.0.1:${port} (pid ${process.pid})`)
    }
  })
  // Re-publish: a reader must never be handed an endpoint owned by a dead shell.
  const keepalive = setInterval(() => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    if (port !== 0) publishEndpoint(port, token, api?.dshHome)
  }, 15_000)
  keepalive.unref?.()
  const onQuit = () => stop()
  application.on('will-quit', onQuit)
  globalThis[ACTIVE] = { server, keepalive, onQuit, onGuestCreated, stop, api, application, token, sockets }
  return server
}
