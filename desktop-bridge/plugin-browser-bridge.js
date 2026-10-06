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
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, webContents } from 'electron'

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
function endpointFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
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
const claims = new Map()

/**
 * When this module was loaded, and the protocol generation it speaks.
 *
 * The bridge is imported once by `main.js` at boot, so editing the file changes nothing until the
 * host process restarts. That makes "did my restart actually load the new bridge?" a real question
 * — and a run that cannot answer it will blame the new code for the old code's behaviour. The
 * acceptance script compares this against the file's mtime and says so before testing anything.
 */
const LOADED_AT = new Date().toISOString()
const PROTOCOL = 2

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

/** Forget claims whose guest no longer exists, so a closed tab's id is not held forever. */
function pruneClaims() {
  const live = new Set(webContents.getAllWebContents().filter(c => c.getType() === 'webview').map(c => c.id))
  for (const id of [...claims.keys()]) if (!live.has(id)) claims.delete(id)
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
async function sendCdp(id, method, params) {
  const guest = guestById(id)
  if (guest === undefined || guest.isDestroyed()) throw new Error(`guest ${id} is not available`)
  const previous = queues.get(id) ?? Promise.resolve()
  const next = previous.then(async () => {
    const current = guestById(id)
    if (current === undefined || current.isDestroyed()) throw new Error(`guest ${id} is not available`)
    if (!current.debugger.isAttached()) current.debugger.attach('1.3')
    return await current.debugger.sendCommand(method, params ?? {})
  })
  // Keep the chain alive on failure so one bad command does not wedge the guest.
  queues.set(id, next.catch(() => undefined))
  return await next
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
 * @param url - address to load when a panel has to be opened; empty to only read.
 * @returns the renderer's verdict, normalized so a malformed answer is a named failure.
 */
async function evaluatePanelService(shellId, sessionId, url) {
  const expression = `(() => {
    const api = globalThis.__dshBuiltinBrowser;
    if (api === undefined || api === null || typeof api.openPanel !== 'function') {
      return JSON.stringify({ ok: false, reason: 'the plugin client half is not loaded in this window' });
    }
    try {
      return JSON.stringify(api.openPanel(${JSON.stringify(String(sessionId))}, ${JSON.stringify(String(url ?? ''))}));
    } catch (error) {
      return JSON.stringify({ ok: false, reason: String((error && error.message) || error) });
    }
  })()`
  // `executeJavaScript`, NOT the debugger/CDP path.
  //
  // Measured on the running shell: the debugger attachment to the shell WINDOW is unreliable — its
  // commands hang, repeatedly and for minutes, while the same channel to a guest page answers at
  // once. Nothing here needs the protocol: it is one synchronous call on a global the plugin itself
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
      reason: parsed?.reason === undefined ? undefined : String(parsed.reason),
      panel: parsed?.panel === true,
      created: parsed?.created === true,
      guestId: typeof parsed?.guestId === 'number' && Number.isFinite(parsed.guestId) ? parsed.guestId : null,
      url: typeof parsed?.url === 'string' ? parsed.url : '',
      // A refusal carries what the renderer found, so the reason is actionable rather than a guess.
      found: parsed?.found === undefined ? undefined : parsed.found,
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
    return current !== '' && (current === url || current.startsWith(url))
  } catch (error) {
    return false
  }
}

/** Handle one JSON request line; every answer is a JSON line too. */
async function handle(request) {
  const op = String(request?.op ?? '')
  // Who is asking. Declared once, for every op, because the first attempt at this put `owner` in
  // the allocation path only and the reuse path — which every later call takes — stayed blind,
  // so one session was handed another's page and counted another's tabs as its own.
  const owner = typeof request?.owner === 'string' && request.owner !== '' ? request.owner : 'anonymous'
  // Which build is answering. The acceptance script asks this first, because everything else it
  // measures is meaningless if the host is still running the previous bridge.
  if (op === 'version') {
    return { ok: true, loadedAt: LOADED_AT, protocol: PROTOCOL }
  }
  if (op === 'list') {
    const all = webContents.getAllWebContents().map(describe)
    // A guest claimed by another owner is not this caller's to see or to drive. Its id, url and
    // title are that session's business; handing them over is how a session came to list pages it
    // never opened. The shell window is always reported: it is what every op drives.
    const mineOrFree = all.filter(g => g.type !== 'webview' || !claims.has(g.id) || claims.get(g.id) === owner)
    return { ok: true, guests: mineOrFree, sidebar: mineOrFree.filter(g => g.type === 'webview') }
  }
  if (op === 'cdp') {
    const id = Number(request.id)
    if (!Number.isFinite(id)) throw new Error('cdp requires a numeric id')
    const result = await sendCdp(id, String(request.method ?? ''), request.params)
    return { ok: true, result, bridgeRequestId: request.bridgeRequestId }
  }
  if (op === 'ensureSidebar') {
    // This conversation's OWN panel, opened through the shell's own navigation — never by
    // simulating input.
    //
    // Every earlier version of this op drove the sidebar the way a human does: Ctrl+T, then a
    // click on the 「浏览器」guide card, then typing into the address bar. All three land on the
    // conversation the shell is DISPLAYING, because the shell routes keys and clicks to what it
    // shows. So a page asked for while the human read another conversation was opened into THAT
    // one, waiting for the screen to come back cost ten seconds, and when it never came back the
    // retry loop left a tab per round. Three separate symptoms — "it opened in the wrong place",
    // "it says it failed", "it opened a dozen browsers" — are one property of that path.
    //
    // The renderer can name the conversation instead. `openTabIn(sessionId, …)` is the shell's
    // own navigation aimed at ONE conversation, and it does not read what is on screen at all —
    // so this op no longer has an opinion about which conversation is displayed, and there is no
    // path from here to somebody else's sidebar. DOM is not touched: the call is evaluated on the
    // global the plugin's own client half published.
    const url = request.url === undefined ? '' : String(request.url)
    const shell = webContents.getAllWebContents().find(contents => contents.getType() === 'window')
    if (shell === undefined) throw new Error('no shell window to drive')
    if (!/^session-/.test(owner)) {
      throw new Error('this host supplied no conversation id, so its own panel cannot be identified')
    }

    const ask = async (withUrl) => {
      const answer = await evaluatePanelService(shell.id, owner, withUrl ? url : '')
      if (answer.ok !== true) {
        // Carry the renderer's own findings into the failure: it is the side that can see why the
        // lookup missed, and a bare "not mounted" leaves the next reader guessing between a real
        // absence and a lookup that reads the wrong place.
        const detail = answer.found === undefined ? '' : ' — renderer found ' + JSON.stringify(answer.found)
        throw new Error(String(answer.reason) + detail)
      }
      return answer
    }

    // Already has a page: reuse it. This is the common case after the first open of a session.
    const first = await ask(url !== '')
    if (first.guestId !== null) {
      claims.set(first.guestId, owner)
      if (!guestShows(first.guestId, url)) {
        await sendCdp(first.guestId, 'Page.navigate', { url }).catch(() => undefined)
      }
      return { ok: true, created: false, id: first.guestId, via: 'panel', owner }
    }

    // A tab was placed, but this conversation is not the one the shell is displaying.
    //
    // The shell renders the sidebar of the conversation it SHOWS. A background conversation's panel
    // exists in its own surface store — which is exactly why the tab could be placed at all — but
    // it has no DOM, so no webview attaches and no amount of waiting would produce one. Waiting
    // would turn a true statement into a timeout, and the page is genuinely there: it appears the
    // moment the conversation is shown.
    if (first.panel === false) {
      throw new Error(
        'a panel was placed in this conversation\'s sidebar, but its page can only attach while the '
        + 'conversation is the one displayed — show it and the page appears',
      )
    }

    // A guest attaches asynchronously once the renderer creates the webview. Poll INSIDE this
    // conversation's panel, so a guest appearing in any other conversation cannot satisfy the wait
    // — the scoping is what makes the wait safe.
    const deadline = Date.now() + (url === '' ? 4_000 : 20_000)
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250))
      const polled = await ask(false)
      if (polled.guestId === null) continue
      claims.set(polled.guestId, owner)
      if (!guestShows(polled.guestId, url)) {
        await sendCdp(polled.guestId, 'Page.navigate', { url }).catch(() => undefined)
      }
      return { ok: true, created: true, id: polled.guestId, via: 'panel', owner }
    }
    throw new Error(
      'this conversation\'s browser panel produced no page within its budget '
      + '(the shell placed no guest in this conversation\'s own sidebar)',
    )
  }
  if (op === 'showTab') {
    // Bring one browser guest to the front — the "switch to this tab" half of opening a page.
    //
    // Without this the desktop bridge had no way to satisfy `showView`, so its host
    // implementation was an empty method and a newly opened page stayed behind whatever the
    // human was looking at. Reported as issue #23; the other two carriers already did this
    // (the self-hosted window re-adds the view, the system browser calls Page.bringToFront).
    //
    // The tab belongs to the renderer, so the same reasoning as `ensureTabs` applies: drive the
    // sidebar's own control. A tab is matched by the title it shows, which is what the sidebar
    // renders from the guest — the guest's id is not exposed in the DOM.
    const viewId = Number(request.viewId)
    if (!Number.isFinite(viewId)) throw new Error('showTab needs a viewId')
    const guest = webContents.fromId(viewId)
    if (guest === undefined) throw new Error(`showTab: no guest with id ${viewId}`)
    // Only a guest this caller holds may be brought forward. Without the check, one session could
    // switch the sidebar to another session's page — moving the human's view out from under it.
    pruneClaims()
    if (claims.has(viewId) && claims.get(viewId) !== owner) {
      throw new Error(`showTab: guest ${viewId} belongs to another session`)
    }
    claims.set(viewId, owner)
    const shell = webContents.getAllWebContents().find(contents => contents.getType() === 'window')
    if (shell === undefined) throw new Error('no shell window to drive')
    const wantTitle = String(guest.getTitle() ?? '').trim()
    const clicked = await evaluateInPanel(shell.id, owner, 'Runtime.evaluate', {
      expression: `(() => {
        const scan = (root, out) => {
          for (const node of root.querySelectorAll('button,[role=button],[role=tab],a')) {
            out.push(node);
            if (node.shadowRoot) scan(node.shadowRoot, out);
          }
          return out;
        };
        const nodes = scan(document, []);
        for (const frame of Array.from(document.querySelectorAll('iframe'))) {
          try { if (frame.contentDocument) scan(frame.contentDocument, nodes) } catch { /* cross-origin */ }
        }
        const label = (n) => ((n.getAttribute('aria-label') || '') + ' ' + (n.textContent || '') + ' ' + (n.getAttribute('title') || '')).trim();
        const want = ${JSON.stringify(wantTitle)};
        // Exact title first, then the tab-like control whose label contains it: a strip may
        // decorate the label with a close button, and a prefix match would hit the wrong tab
        // when one title contains another.
        let hit = nodes.find(n => want !== '' && label(n) === want);
        if (hit === undefined) hit = nodes.find(n => want !== '' && label(n).includes(want) && /tab|page|标签/i.test(n.getAttribute('role') || n.className || ''));
        if (hit === undefined) hit = nodes.find(n => want !== '' && label(n).includes(want));
        if (hit === undefined) return 'NO_TAB_FOR_TITLE';
        hit.click();
        return 'CLICKED';
      })()`,
      returnByValue: true,
    })
    const verdict = String(clicked?.result?.value ?? '')
    if (verdict !== 'CLICKED') {
      throw new Error(`could not bring the page to the front (${verdict}; wanted "${wantTitle}")`)
    }
    return { ok: true, verdict }
  }
  if (op === 'closeSidebarBrowser') {
    // Release the sidebar's browser pages by closing the tabs that host them.
    //
    // This is the desktop equivalent of "close the browser window": the guests are
    // destroyed, so that agent's session ends and its next use starts a fresh page —
    // while cookies and history live in the partition and on disk, and therefore
    // survive (requirements §3).
    //
    // `titles` narrows the release to specific pages. It matters as soon as more
    // than one session is running: each one owns its own tab (requirements §4), and
    // ending one session must not tear down another's page. With no titles given the
    // call means "release everything", which is only appropriate when the caller
    // knows it owns them all.
    //
    // The comment above said that; the code below did not enforce it. It closed every webview
    // whose title matched — and with no filter, EVERY webview — regardless of which session held
    // it. So one session's `browser_reset_session` could destroy another session's page, which is
    // the worst version of the bleed: not merely seeing someone else's tab, but closing it.
    //
    // Ownership is now the outer bound: only guests this owner holds are candidates at all, and
    // the title filter narrows further within them.
    pruneClaims()
    const wanted = Array.isArray(request.titles) ? request.titles.map(title => String(title).slice(0, 24)).filter(title => title !== '') : undefined
    const guests = webContents.getAllWebContents()
      .filter(contents => contents.getType() === 'webview')
      .filter(contents => claims.get(contents.id) === owner)
    const titles = []
    for (const guest of guests) {
      try {
        if (guest.isDestroyed()) continue
        const title = guest.getTitle()
        // With a filter, only the guest we intend to close contributes its title —
        // otherwise a tab belonging to another session could match by accident.
        if (wanted !== undefined && !wanted.some(w => title.startsWith(w))) continue
        titles.push(title)
      } catch { /* gone mid-read */ }
    }
    if (guests.length === 0) return { ok: true, closed: 0 }
    const shell = webContents.getAllWebContents().find(contents => contents.getType() === 'window')
    if (shell === undefined) throw new Error('no shell window to drive')
    if (titles.length === 0 && wanted !== undefined) return { ok: true, closed: 0 }
    const clicked = await evaluateInPanel(shell.id, owner, 'Runtime.evaluate', {
      expression: `(() => {
        const wanted = ${JSON.stringify(titles.map(title => title.slice(0, 24)))};
        let closed = 0;
        for (const tab of Array.from(document.querySelectorAll('[role=tab]'))) {
          const label = (tab.textContent || '').trim();
          if (!wanted.some(w => label.startsWith(w))) continue;
          const own = Array.from(tab.querySelectorAll('button')).find(b => /关闭|close/i.test((b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '')));
          const sibling = Array.from(tab.parentElement ? tab.parentElement.querySelectorAll('button') : []).find(b => /关闭|close/i.test((b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '')));
          const button = own ?? sibling;
          if (button !== undefined) { button.click(); closed += 1; }
        }
        return closed;
      })()`,
      returnByValue: true,
    })
    return { ok: true, closed: Number(clicked?.result?.value ?? 0) }
  }
  if (op === 'collapseSidebar') {
    // Fold the sidebar away so the agent works without occupying the screen. The
    // guest keeps running — collapsing is presentation, exactly as §3 asks.
    const shell = webContents.getAllWebContents().find(contents => contents.getType() === 'window')
    if (shell === undefined) throw new Error('no shell window to drive')
    const folded = await evaluateInPanel(shell.id, owner, 'Runtime.evaluate', {
      expression: `(() => {
        const button = Array.from(document.querySelectorAll('button')).find(b => /收起右侧边栏/.test((b.getAttribute('aria-label') || '') + (b.textContent || '')));
        if (button === undefined) return 'NOT_OPEN';
        button.click();
        return 'COLLAPSED';
      })()`,
      returnByValue: true,
    })
    return { ok: true, result: folded?.result?.value, bridgeRequestId: request.bridgeRequestId }
  }
  throw new Error(`unknown op ${JSON.stringify(op)}`)
}


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
function publishEndpoint(port, token) {
  const payload = {
    port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  try {
    const file = endpointFile()
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
export function stop() {
  const current = globalThis[ACTIVE]
  globalThis[ACTIVE] = undefined
  if (!current) return
  try { clearInterval(current.keepalive) } catch { /* ignore */ }
  try { current.server.close() } catch { /* already closed */ }
  try { app.off('will-quit', current.onQuit) } catch { /* ignore */ }
}

/** Start the bridge: loopback listener + published endpoint file + token. */
export function start() {
  stop()
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
  const server = createServer(socket => {
    let buffer = ''
    let authed = false
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line === '') continue
        let request
        try { request = JSON.parse(line) } catch { socket.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n'); continue }
        if (!authed) {
          if (request.token !== token) { socket.write(JSON.stringify({ ok: false, error: 'bad token' }) + '\n'); socket.destroy(); return }
          authed = true
          // The authenticating message is NOT a command: a client that sends the
          // token on its own line would otherwise be answered `unknown op ""`.
          // (A client may also put the token on its first real request; both work.)
          if (typeof request.op !== 'string' || request.op === '') continue
        }
        void handle(request)
          // The request id is stamped HERE, at the single point where every answer is written,
          // rather than on the handful of returns that happened to remember it.
          //
          // The parent matches replies to requests by this id; when it is missing the parent
          // marks the whole connection id-less and serialisable, which drops every reply back
          // to arrival order and makes it reject in-flight requests when a second call
          // arrives. Only two of this bridge's nine reply paths carried the field, so most
          // operations permanently degraded the connection they used.
          .then(answer => socket.write(JSON.stringify({ ...answer, bridgeRequestId: request.bridgeRequestId }) + '\n'))
          .catch(error => socket.write(JSON.stringify({ ok: false, error: String(error?.message ?? error), bridgeRequestId: request.bridgeRequestId }) + '\n'))
      }
    })
    socket.on('error', () => { /* client went away */ })
  })
  server.on('error', error => { console.error('[dsh-browser-bridge] listen failed:', error) })
  // Loopback only, port chosen by the OS: the endpoint file is the discovery
  // mechanism, so a fixed port would only add collisions.
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    if (publishEndpoint(port, token)) {
      console.log(`[dsh-browser-bridge] listening on 127.0.0.1:${port} (pid ${process.pid})`)
    }
  })
  // Re-publish: a reader must never be handed an endpoint owned by a dead shell.
  const keepalive = setInterval(() => {
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    if (port !== 0) publishEndpoint(port, token)
  }, 15_000)
  keepalive.unref?.()
  const onQuit = () => stop()
  app.on('will-quit', onQuit)
  globalThis[ACTIVE] = { server, keepalive, onQuit }
  return server
}
