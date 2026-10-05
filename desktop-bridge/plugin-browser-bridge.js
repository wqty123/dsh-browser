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

/** Handle one JSON request line; every answer is a JSON line too. */
async function handle(request) {
  const op = String(request?.op ?? '')
  if (op === 'list') {
    const all = webContents.getAllWebContents().map(describe)
    return { ok: true, guests: all, sidebar: all.filter(g => g.type === 'webview') }
  }
  if (op === 'cdp') {
    const id = Number(request.id)
    if (!Number.isFinite(id)) throw new Error('cdp requires a numeric id')
    const result = await sendCdp(id, String(request.method ?? ''), request.params)
    return { ok: true, result, bridgeRequestId: request.bridgeRequestId }
  }
  if (op === 'ensureSidebar') {
    const url = request.url === undefined ? '' : String(request.url)
    // Materialize a sidebar guest, optionally navigating it.
    //
    // The sidebar browser creates its guest lazily: an un-navigated sidebar is
    // only an address bar and owns no webContents at all, so "there is no guest"
    // is the normal state rather than a failure. When one already exists this is
    // a no-op; otherwise the shell's own UI is driven to open the right sidebar
    // and submit an address — the same thing a human would do, and the only
    // supported way to make the sidebar own a page.
    const existing = webContents.getAllWebContents().filter(contents => contents.getType() === 'webview')
    if (existing.length > 0) {
      const first = existing[0]
      if (request.url !== undefined && String(request.url) !== '') {
        await sendCdp(first.id, 'Page.navigate', { url: String(request.url) })
      }
      return { ok: true, created: false, id: first.id }
    }
    const shell = webContents.getAllWebContents().find(contents => contents.getType() === 'window')
    if (shell === undefined) throw new Error('no shell window to drive')
    // 1. Open the sidebar and put the caret in its address field IF that field is
    //    reachable. It is not always: the sidebar may show another panel, or the
    //    browser tab may be present but not active, in which case no address input
    //    exists in the document at all. That must not be fatal — the restore route
    //    below needs no address bar, and treating "no input" as a hard error is
    //    exactly what made the first call after a restart fail.
    const prepared = await sendCdp(shell.id, 'Runtime.evaluate', {
      expression: shellPrepareSidebar(),
      returnByValue: true,
    })
    let verdict = String(prepared?.result?.value ?? '')
    // The last two verdicts mean the panel was only ASKED to open. It materialises
    // asynchronously — the shell has to construct the sidebar view — so acting immediately
    // finds no address bar and fails for a panel that is a moment away. Poll for it instead of
    // treating "not there yet" as "cannot be opened", which is the same mistake the first call
    // after a restart used to make.
    if (verdict === 'CLICKED_LAUNCHER' || verdict === 'SENT_CTRL_T') {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250))
        const probe = await sendCdp(shell.id, 'Runtime.evaluate', {
          expression: `(() => {
            const inputs = Array.from(document.querySelectorAll('input'))
              .filter(i => /HTTP|地址|url/i.test((i.placeholder || '') + (i.getAttribute('aria-label') || '')));
            if (inputs.length === 0) return 'NO_ADDRESS_BAR';
            inputs[inputs.length - 1].focus();
            return 'FOCUSED';
          })()`,
          returnByValue: true,
        })
        verdict = String(probe?.result?.value ?? '')
        if (verdict !== 'NO_ADDRESS_BAR') break
      }
    }
    // 2. Materialize a guest. Two routes, cheapest first:
    //    a. the sidebar's own "restore last page" affordance — it navigates
    //       without depending on how the address field handles focus or input;
    //    b. otherwise type into the address field and submit with REAL key input
    //       (synthetic events do not move React's controlled input, and the field
    //       also loses focus to re-renders, so both halves are needed).
    let submitVerdict = 'n/a'
    // The address route runs FIRST when a url was asked for, and the restore affordance is only
    // a fallback when there is none.
    //
    // It used to be the other way round, and that ordering was measured to be wrong: on this
    // desktop the restore probe reports RESTORED for an element that does not actually restore
    // anything, so the address route was skipped entirely and the guest was never materialised
    // — ensureSidebar returned prepare=FOCUSED, restore=RESTORED, submit=n/a and the sidebar
    // stayed empty. Driving the address bar instead is the route that works here; it produced
    // `{"created":true,"via":"address"}` against the same empty sidebar.
    let restored = { result: { value: 'NO_RESTORE' } }
    const haveUrl = url !== ''
    if (!haveUrl) {
      restored = await sendCdp(shell.id, 'Runtime.evaluate', {
        expression: `(() => {
          const nodes = Array.from(document.querySelectorAll('button,a,[role=button],div[role=link]'));
          const hit = nodes.find(n => {
            const own = (n.textContent || '').trim();
            if (own.length > 24) return false;
            return /^(恢复页面|恢复上次|恢复上次页面|上次打开)$/.test(own)
              || /恢复|restore/i.test(n.getAttribute('aria-label') || n.getAttribute('title') || '');
          });
          if (hit === undefined) return 'NO_RESTORE';
          hit.click();
          return 'RESTORED';
        })()`,
        returnByValue: true,
      })
    }
    if (true) {
      if (url !== '') {
        // Set the value the way React accepts it, then SUBMIT THE FORM.
        //
        // A dispatched Enter is not enough: the sidebar browser's toolbar is a
        // `<form>` whose submission is wired to an explicit control (aria-label
        // "前往" / "Go"), and implicit submission does not fire there — measured
        // on DSH 0.2.0-rc.2, where Enter left the field filled and the guest
        // uncreated. `requestSubmit()` goes through the same path the button
        // does, so it works with React's onSubmit and needs no localized label.
        const typed = await sendCdp(shell.id, 'Runtime.evaluate', {
          expression: `(() => {
            const inputs = Array.from(document.querySelectorAll('input')).filter(i => /HTTP|地址|url/i.test((i.placeholder || '') + (i.getAttribute('aria-label') || '')));
            if (inputs.length === 0) return 'NO_ADDRESS_BAR';
            const input = inputs[inputs.length - 1];
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, ${JSON.stringify(String(request.url ?? ''))});
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
            const form = input.form ?? input.closest('form');
            if (form) { form.requestSubmit(); return 'SUBMITTED_FORM'; }
            const button = input.parentElement
              ? input.parentElement.querySelector('button[type=submit],button')
              : null;
            if (button) { button.click(); return 'CLICKED_SUBMIT'; }
            return 'TYPED_ONLY';
          })()`,
          returnByValue: true,
        })
        submitVerdict = String(typed?.result?.value ?? 'n/a')
        // Enter stays as the last resort for sidebars without a form.
        if (submitVerdict === 'TYPED_ONLY') {
          for (const type of ['keyDown', 'keyUp']) {
            await sendCdp(shell.id, 'Input.dispatchKeyEvent', {
              type,
              key: 'Enter',
              code: 'Enter',
              windowsVirtualKeyCode: 13,
              nativeVirtualKeyCode: 13,
            })
          }
        }
      }
    }
    // The guest attaches asynchronously once the renderer creates the webview.
    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500))
      const created = webContents.getAllWebContents().filter(contents => contents.getType() === 'webview')
      if (created.length > 0) {
        // Now that a guest exists, navigation is a plain CDP call: no UI involved.
        if (url !== '') {
          await sendCdp(created[0].id, 'Page.navigate', { url }).catch(() => undefined)
        }
        return { ok: true, created: true, id: created[0].id, via: restored?.result?.value === 'RESTORED' ? 'restore' : 'address' }
      }
    }
    throw new Error(`the sidebar did not create a browser guest (prepare=${String(verdict)}, restore=${String(restored?.result?.value)}, submit=${submitVerdict})`)
  }
  if (op === 'ensureTabs') {
    // Grow the sidebar's browser tab strip to `count` tabs and report every guest.
    //
    // Tabs are the renderer's, so this cannot create them directly — it drives the
    // sidebar's own "new tab" control, the same affordance a human uses, and then
    // reports the guest ids. Whatever already exists is reused, so repeated calls
    // are cheap and a human-opened tab is never orphaned.
    //
    // "No control found" used to throw on the spot, and that was wrong: the strip is
    // rendered by the sidebar, so a page that opened correctly can still be a moment away
    // from having its control in the DOM — or the control can live where a plain
    // querySelectorAll cannot see it (a shadow root, or a frame). Throwing turned that
    // transient into a permanent failure and reported it as "the browser tab is not open"
    // even though the tab was open. Reported as issue #23.
    //
    // Now it is one more round's outcome: keep waiting, and only report it if every round
    // ended that way. The last thing each round saw is carried into the message, so a
    // failure says whether the control was missing or the click did nothing.
    const want = Math.max(1, Math.min(8, Number(request.count ?? 1)))
    const shell = webContents.getAllWebContents().find(contents => contents.getType() === 'window')
    if (shell === undefined) throw new Error('no shell window to drive')
    const rounds = 30
    let lastVerdict = ''
    let sawControl = false
    for (let attempt = 0; attempt < rounds; attempt++) {
      const guests = webContents.getAllWebContents().filter(contents => contents.getType() === 'webview')
      if (guests.length >= want) return { ok: true, ids: guests.map(contents => contents.id), verdict: lastVerdict }
      const clicked = await sendCdp(shell.id, 'Runtime.evaluate', {
        expression: `(() => {
          const seen = [];
          const scan = (root) => {
            for (const node of root.querySelectorAll('button,[role=button]')) {
              seen.push(node);
              const label = (node.getAttribute('aria-label') || '') + (node.textContent || '') + (node.getAttribute('title') || '');
              if (/新标签页|新建标签|new tab/i.test(label)) { node.click(); return true }
              // A control inside a shadow root or a frame is invisible to a flat query, which
              // is one of the ways this used to report "no control" for a strip that had one.
              if (node.shadowRoot) { if (scan(node.shadowRoot)) return true }
            }
            return false;
          };
          if (scan(document)) return 'CLICKED';
          for (const frame of Array.from(document.querySelectorAll('iframe'))) {
            try { if (frame.contentDocument && scan(frame.contentDocument)) return 'CLICKED' } catch { /* cross-origin */ }
          }
          return 'NO_NEW_TAB_CONTROL';
        })()`,
        returnByValue: true,
      })
      lastVerdict = String(clicked?.result?.value ?? '')
      if (lastVerdict === 'CLICKED') sawControl = true
      await new Promise(resolve => setTimeout(resolve, 600))
    }
    if (!sawControl) {
      throw new Error(
        'the sidebar exposes no new-tab control after ' + String(rounds) + ' attempts '
        + `(last verdict: ${lastVerdict || 'none'}) — the browser tab may not be open, or the `
        + 'control is somewhere this cannot reach',
      )
    }
    throw new Error(`the sidebar stopped at fewer than ${want} tabs (the control was found and clicked, but no new guest appeared)`)
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
    const shell = webContents.getAllWebContents().find(contents => contents.getType() === 'window')
    if (shell === undefined) throw new Error('no shell window to drive')
    const wantTitle = String(guest.getTitle() ?? '').trim()
    const clicked = await sendCdp(shell.id, 'Runtime.evaluate', {
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
    const wanted = Array.isArray(request.titles) ? request.titles.map(title => String(title).slice(0, 24)).filter(title => title !== '') : undefined
    const guests = webContents.getAllWebContents().filter(contents => contents.getType() === 'webview')
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
    const clicked = await sendCdp(shell.id, 'Runtime.evaluate', {
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
    const folded = await sendCdp(shell.id, 'Runtime.evaluate', {
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
 * In-page script that opens the right sidebar and focuses its address field.
 *
 * Only preparation happens here; the address itself is typed with real input
 * (see `ensureSidebar`), because a controlled React input ignores text assigned
 * through synthetic events.
 * @returns a self-contained expression evaluating to a short verdict string.
 */
function shellPrepareSidebar() {
  return `(() => {
    const labelOf = el => ((el.getAttribute && el.getAttribute('aria-label')) || el.textContent || '').trim();

    // Collect every clickable we might need, through shadow roots and frames: the launcher card
    // lives in the shell's start page and the sidebar controls live in its own tree, and a flat
    // query cannot see either if they are nested.
    const clickables = () => {
      const out = [];
      const scan = (root) => {
        for (const node of root.querySelectorAll('button,a,[role=button],[role=tab],div[tabindex]')) {
          out.push(node);
          if (node.shadowRoot) scan(node.shadowRoot);
        }
        for (const frame of Array.from(root.querySelectorAll('iframe'))) {
          try { if (frame.contentDocument) scan(frame.contentDocument) } catch { /* cross-origin */ }
        }
        return out;
      };
      return scan(document);
    };

    const addressInput = () => Array.from(document.querySelectorAll('input'))
      .filter(i => /HTTP|地址|url/i.test((i.placeholder || '') + (i.getAttribute('aria-label') || '')));

    // 1. Is there already an address bar? Then the sidebar is up; just focus it.
    const existing = addressInput();
    if (existing.length > 0) {
      existing[existing.length - 1].focus();
      return 'FOCUSED';
    }

    // 2. Try to open the right sidebar, if a control for that exists.
    let opened = false;
    for (const button of clickables()) {
      if (/打开右侧边栏|右侧边栏/.test(labelOf(button))) { button.click(); opened = true; break }
    }

    // 3. Nothing yet: drive the shell's own launcher. The start page offers a 「浏览器」 card
    //    (Ctrl+T) that opens the browser panel, and without this step the bridge simply gave up
    //    — reporting NO_ADDRESS_BAR for a panel that was never opened. Reported as issue #23:
    //    a human should not have to open the panel by hand before the agent can use it.
    const afterOpen = addressInput();
    if (afterOpen.length > 0) {
      afterOpen[afterOpen.length - 1].focus();
      return opened ? 'OPENED_AND_FOCUSED' : 'FOCUSED';
    }
    // The launcher card's textContent is the WHOLE card, not its title: measured on this
    // desktop it reads "浏览器浏览网页Ctrl+T" (title + subtitle + shortcut). Matching the
    // text against /^(浏览器)$/ therefore matched nothing and the panel was never asked to
    // open — the click silently did nothing and the caller then failed after its poll.
    //
    // Anchor at the START instead: the card begins with 浏览器, while the neighbouring
    // workspace-files card reads "工作区文件浏览会话工作区的文件Ctrl+P" and merely CONTAINS
    // 浏览 — an unanchored /浏览/ would click the wrong card. The aria-label branch is kept
    // for shells that label the control explicitly.
    const CARD = /^(浏览器|浏览网页|Browser)/;
    for (const node of clickables()) {
      const label = labelOf(node);
      const aria = node.getAttribute('aria-label') || '';
      if (CARD.test(label) || /open browser|new browser tab|浏览网页/i.test(aria)) {
        node.click();
        return 'CLICKED_LAUNCHER';
      }
    }

    // 4. Last resort: the keyboard shortcut the card advertises. Dispatched on the document so
    //    a handler bound at the window level still sees it.
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', code: 'KeyT', ctrlKey: true, bubbles: true }));
      return 'SENT_CTRL_T';
    } catch { /* fall through to the diagnostic */ }

    const inputs = Array.from(document.querySelectorAll('input'));
    return 'NO_ADDRESS_BAR:' + JSON.stringify(inputs.map(i => i.placeholder).slice(0, 6));
  })()`
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

/** Start the bridge: loopback listener + published endpoint file + token. */
export function start() {
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
  app.on('will-quit', () => {
    clearInterval(keepalive)
    try { server.close() } catch { /* already closed */ }
  })
  return server
}
