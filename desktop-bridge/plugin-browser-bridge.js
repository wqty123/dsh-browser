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

/** Handle one JSON request line; every answer is a JSON line too. */
async function handle(request) {
  const op = String(request?.op ?? '')
  // Who is asking. Declared once, for every op, because the first attempt at this put `owner` in
  // the allocation path only and the reuse path — which every later call takes — stayed blind,
  // so one session was handed another's page and counted another's tabs as its own.
  const owner = typeof request?.owner === 'string' && request.owner !== '' ? request.owner : 'anonymous'
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
    const url = request.url === undefined ? '' : String(request.url)
    // Materialize a sidebar guest, optionally navigating it.
    //
    // The sidebar browser creates its guest lazily: an un-navigated sidebar is
    // only an address bar and owns no webContents at all, so "there is no guest"
    // is the normal state rather than a failure. When one already exists this is
    // a no-op; otherwise the shell's own UI is driven to open the right sidebar
    // and submit an address — the same thing a human would do, and the only
    // supported way to make the sidebar own a page.
    // `newTab: true` means "open ANOTHER browser page, in a new tab of this same sidebar".
    //
    // This is a different request from the first one, because the host's browser tab is created
    // in two steps and the bridge previously assumed one. Measured on the running shell:
    //
    //   create the tab (Ctrl+T, or the strip's "+")  -> a 浏览器 tab exists, but NO webview
    //   navigate inside that tab                     -> the webview appears
    //
    // So a caller that just asks for "a tab" waits forever for a guest that only appears when
    // something navigates, while a caller that navigates gets one immediately. Hence: make the
    // tab, activate it, and let the normal address-bar route below do the navigating.
    if (request.newTab === true) {
      const shellForNewTab = webContents.getAllWebContents().find(contents => contents.getType() === 'window')
      if (shellForNewTab === undefined) throw new Error('no shell window to drive')
      const before = new Set(webContents.getAllWebContents().filter(c => c.getType() === 'webview').map(c => c.id))
      // Ctrl+T is the host's own shortcut for browser.new (registered for desktop:windows as
      // primary+KeyT). A real key event through the Input domain reaches the shortcut table;
      // a synthesized DOM KeyboardEvent does not.
      const key = (type) => sendCdp(shellForNewTab.id, 'Input.dispatchKeyEvent', {
        type,
        modifiers: 2,
        windowsVirtualKeyCode: 84,
        nativeVirtualKeyCode: 84,
        code: 'KeyT',
        key: 't',
        ...type === 'keyDown' ? { text: 't' } : {},
      })
      await key('keyDown')
      await key('keyUp')
      // The new tab starts on the guide page, so it has no address bar until it is the active
      // tab. Activate the newest 浏览器 tab, then fall through to the address route, which will
      // navigate it and thereby materialize its guest.
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250))
        const activated = await sendCdp(shellForNewTab.id, 'Runtime.evaluate', {
          expression: `(() => {
            const strip = document.querySelector('[class*=_tabStrip]');
            if (strip === null) return 'NO_STRIP';
            const rows = Array.from(strip.querySelectorAll('button,[role=tab],[class*=tab]'));
            const browserTabs = rows.filter(r => ((r.getAttribute('aria-label') || '') + ' ' + (r.textContent || '')).trim().indexOf('浏览器') === 0);
            if (browserTabs.length === 0) return 'NO_BROWSER_TAB';
            browserTabs[browserTabs.length - 1].click();
            return 'ACTIVATED:' + String(browserTabs.length);
          })()`,
          returnByValue: true,
        })
        if (String(activated?.result?.value ?? '').startsWith('ACTIVATED')) break
      }
      void before
    }
    // Which guest belongs to THIS caller.
    //
    // The owner ledger was added to the allocation path and NOT to this one, so a session calling
    // here was handed `existing[0]` — whatever tab happened to be first, including another
    // session's. That is exactly the cross-session bleed the ledger was introduced to stop:
    // session B was given session A's page, and A's tabs were counted as B's when deciding how
    // many more to create.
    //
    // Only a guest this owner already holds is reused; a claimed guest held by someone else is
    // invisible here, and an unclaimed one is adopted on the spot (it is nobody's yet).
    const owner = typeof request.owner === 'string' && request.owner !== '' ? request.owner : 'anonymous'
    pruneClaims()
    let reuseId = request.newTab === true ? undefined : [...claims.entries()]
      .find(([guest, holder]) => holder === owner && guestById(guest) !== undefined)?.[0]
    // An unclaimed webview is free to take: nobody has asked for it, and leaving it would make
    // this caller create a tab it does not need.
    if (reuseId === undefined && request.newTab !== true) {
      const unclaimedGuest = webContents.getAllWebContents()
        .filter(contents => contents.getType() === 'webview')
        .find(contents => !claims.has(contents.id))
      if (unclaimedGuest !== undefined) {
        claims.set(unclaimedGuest.id, owner)
        reuseId = unclaimedGuest.id
      }
    }
    if (reuseId !== undefined) {
      if (request.url !== undefined && String(request.url) !== '') {
        await sendCdp(reuseId, 'Page.navigate', { url: String(request.url) })
      }
      return { ok: true, created: false, id: reuseId, owner, reused: true }
    }
    const existing = []
    const shell = webContents.getAllWebContents().find(contents => contents.getType() === 'window')
    if (shell === undefined) throw new Error('no shell window to drive')
    // With `newTab` the tab was just created and is sitting on its GUIDE page, whose address bar
    // does not exist yet — the guide is a list of page types, and the browser page is what one of
    // them creates.
    //
    // `shellPrepareSidebar` must therefore NOT run in that state: its whole job is "no address bar
    // -> click the launcher card", and on a guide page that card IS the browser page, so every
    // retry created another one. That is the reported "it keeps creating new browser entries".
    // The guide page has to be turned into a browser page exactly once, and only then is there an
    // address bar to type into.
    const addressBarVisible = async () => String(await sendCdp(shell.id, 'Runtime.evaluate', {
      expression: `(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden';
        };
        return Array.from(document.querySelectorAll('input')).some(i => visible(i)
          && /HTTP|地址|url/i.test((i.placeholder || '') + (i.getAttribute('aria-label') || ''))) ? 'YES' : 'NO';
      })()`,
      returnByValue: true,
    }))?.result?.value
    let prepared
    // Set when the launcher card has been clicked, so the no-url route below cannot click it a
    // second time: `newTab` already does that when the tab is still a guide page, and two clicks
    // make two pages. One card click per call, which is the same rule the retry loop needed.
    let cardClicked = false
    if (request.newTab === true && await addressBarVisible() === 'YES') {
      // Already a browser page (the guide was consumed elsewhere, or the host went straight
      // there). Nothing to open, and clicking anything here would create a second one.
      prepared = { result: { value: 'FOCUSED' } }
    } else if (request.newTab === true) {
      // On the guide page: click its browser entry ONCE, then look for the address bar.
      const opened = await sendCdp(shell.id, 'Runtime.evaluate', {
        expression: `(() => {
          const clickables = (root, out = []) => {
            for (const node of root.querySelectorAll('button,[role=button]')) {
              out.push(node);
              if (node.shadowRoot) clickables(node.shadowRoot, out);
            }
            return out;
          };
          const labelOf = (node) => ((node.textContent || '') + ' ' + (node.getAttribute('aria-label') || '')).trim();
          // The card carries both halves; the strip's own tab carries only the title, and a
          // prefix match would hit it instead and merely switch tabs.
          const card = clickables(document).find(n => {
            const own = (n.textContent || '').trim();
            if (own.length > 24) return false;
            return /浏览器/.test(own) && /浏览网页/.test(own);
          });
          if (card === undefined) return 'NO_CARD';
          card.click();
          return 'CLICKED_CARD';
        })()`,
        returnByValue: true,
      })
      const cardVerdict = String(opened?.result?.value ?? '')
      if (cardVerdict === 'CLICKED_CARD') cardClicked = true
      // One click, then wait for the address bar it produces.
      let focused = 'NO_ADDRESS_BAR'
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 250))
        if (await addressBarVisible() === 'YES') { focused = 'FOCUSED'; break }
      }
      prepared = { result: { value: `${cardVerdict}/${focused}` } }
    } else {
      // 1. Open the sidebar and put the caret in its address field IF that field is
      //    reachable. It is not always: the sidebar may show another panel, or the
      //    browser tab may be present but not active, in which case no address input
      //    exists in the document at all. That must not be fatal — the restore route
      //    below needs no address bar, and treating "no input" as a hard error is
      //    exactly what made the first call after a restart fail.
      prepared = await sendCdp(shell.id, 'Runtime.evaluate', {
        expression: shellPrepareSidebar(),
        returnByValue: true,
      })
    }
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
            const pickAddressInput = () => {
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
                const s = getComputedStyle(el);
                return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
              };
              const labelOf = (i) => (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '');
              const all = Array.from(document.querySelectorAll('input')).filter(visible);
              // The shell's own address bar first, by its exact placeholder, so a page that
              // merely mentions a URL cannot win. Both spellings of the parenthesis are listed
              // because the placeholder is localized.
              const exact = all.filter(i => /^\s*输入\s*HTTP\(S\)\s*地址\s*$/.test(i.placeholder || '')
                || /^(Enter|Type)\s+(an\s+)?HTTP\(S\)\s+address/i.test(i.placeholder || ''));
              if (exact.length > 0) return exact[0];
              // Otherwise any VISIBLE field that looks like an address bar.
              const loose = all.filter(i => /HTTP|地址|url/i.test(labelOf(i)));
              return loose.length > 0 ? loose[0] : undefined;
            };
            const input = pickAddressInput();
            if (input === undefined) return 'NO_ADDRESS_BAR';
            input.focus();
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
      // No url — and this is the ordinary case, not an edge one.
      //
      // The host reaches here FIRST with no url, because the command that opens a view is
      // `documentStamp`, which evaluates a script rather than navigating; `Page.navigate` comes
      // afterwards and carries the address. So "there is nothing to type" must still produce a
      // usable page, or the first browser_open of every session dies waiting for a guest that
      // nobody created. That was the real shape of "it worked the first time once".
      //
      // The route: the same launcher card the newTab path uses, clicked once. It creates the
      // browser page, empty, and the host navigates it a moment later. The restore affordance is
      // tried only after that, because on this desktop it reports RESTORED for an element that
      // restores nothing.
      //
      // Skipped entirely if the newTab path above already clicked the card: two clicks make two
      // pages, and this route runs after that one.
      const created = cardClicked
        ? { result: { value: 'ALREADY_CLICKED' } }
        : await sendCdp(shell.id, 'Runtime.evaluate', {
        expression: `(() => {
          const clickables = (root, out = []) => {
            for (const node of root.querySelectorAll('button,[role=button]')) {
              out.push(node);
              if (node.shadowRoot) clickables(node.shadowRoot, out);
            }
            return out;
          };
          const card = clickables(document).find(n => {
            const own = (n.textContent || '').trim();
            if (own.length > 24) return false;
            return /浏览器/.test(own) && /浏览网页/.test(own);
          });
          if (card === undefined) return 'NO_CARD';
          card.click();
          return 'CLICKED_CARD';
        })()`,
        returnByValue: true,
      })
      const cardVerdict = String(created?.result?.value ?? '')
      // Only when the card was NOT clicked: if it was, a browser page exists and the restore
      // probe would either find nothing or — worse, given what that probe reports on this
      // desktop — claim to have restored into a page that is already there.
      if (cardVerdict !== 'CLICKED_CARD' && cardVerdict !== 'ALREADY_CLICKED') {
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
    }
    // A deliberate no-op guard rather than a dead branch to clean up: this block used to be
    // conditional on the restore route not having run, the condition was removed, and unwrapping
    // the braces now would re-indent sixty lines of the most delicate code in this file for no
    // behavioural change. The rule this project runs on is not to disturb what works.
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
            const pickAddressInput = () => {
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
                const s = getComputedStyle(el);
                return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
              };
              const labelOf = (i) => (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '');
              const all = Array.from(document.querySelectorAll('input')).filter(visible);
              // The shell's own address bar first, by its exact placeholder, so a page that
              // merely mentions a URL cannot win. Both spellings of the parenthesis are listed
              // because the placeholder is localized.
              const exact = all.filter(i => /^\s*输入\s*HTTP\(S\)\s*地址\s*$/.test(i.placeholder || '')
                || /^(Enter|Type)\s+(an\s+)?HTTP\(S\)\s+address/i.test(i.placeholder || ''));
              if (exact.length > 0) return exact[0];
              // Otherwise any VISIBLE field that looks like an address bar.
              const loose = all.filter(i => /HTTP|地址|url/i.test(labelOf(i)));
              return loose.length > 0 ? loose[0] : undefined;
            };
            const input = pickAddressInput();
            if (input === undefined) return 'NO_ADDRESS_BAR';
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
    //
    // Only a guest that was NOT there before counts. `created[0]` is simply the first webview in
    // the process: with tabs already open the check is true immediately, so this returned someone
    // else's tab, navigated it to the requested url and reported `created: true`. That is both
    // halves of the reported symptom — "it says it failed" and "the page turned up in another
    // session's tab" — from one line. The set difference is the guest this call made.
    const before = new Set(webContents.getAllWebContents().filter(c => c.getType() === 'webview').map(c => c.id))
    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500))
      const fresh = webContents.getAllWebContents()
        .filter(contents => contents.getType() === 'webview')
        .filter(contents => !before.has(contents.id))
      if (fresh.length > 0) {
        // Now that a guest exists, navigation is a plain CDP call: no UI involved.
        if (url !== '') {
          await sendCdp(fresh[0].id, 'Page.navigate', { url }).catch(() => undefined)
        }
        claims.set(fresh[0].id, owner)
        return { ok: true, created: true, id: fresh[0].id, via: restored?.result?.value === 'RESTORED' ? 'restore' : 'address', owner }
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

    // Who is asking, and which guests are already theirs.
    //
    // The sidebar is ONE surface shared by every DSH session, and each session is its own
    // process with its own in-memory view map — so a session could only see its OWN claims and
    // would happily adopt a tab another session had opened. That is how a URL opened in one
    // session showed up in another's sidebar. The ledger therefore lives HERE, in the single
    // process that owns the sidebar, and the plugin passes a per-process owner id.
    const owner = typeof request.owner === 'string' && request.owner !== '' ? request.owner : 'anonymous'
    pruneClaims()
    const mine = new Set()
    for (const [guest, holder] of claims) if (holder === owner) mine.add(guest)

    // Tabs that exist but belong to nobody: safe to hand out. Tabs held by another owner are
    // never returned, which is the whole point — one session no longer drives another's page.
    const unclaimed = (ids) => ids.filter(id => !claims.has(id) || claims.get(id) === owner)

    const rounds = 30
    let lastVerdict = ''
    let sawControl = false
    // Each control is clicked AT MOST ONCE. Clicking is what creates a tab, so a click inside
    // the retry loop spawns one tab per round — the previous version clicked the guide card up
    // to 30 times and opened a dozen browsers. Retrying means waiting and re-reading the DOM,
    // never re-clicking: the strip is the human's surface, and a loop must not spray into it.
    let clickedPlus = false
    let clickedGuide = false
    for (let attempt = 0; attempt < rounds; attempt++) {
      const guests = webContents.getAllWebContents().filter(contents => contents.getType() === 'webview')
      // Hand back ONLY this owner's tabs plus tabs nobody has claimed, and claim what we hand
      // out. Returning every guest — which is what this did — is how one session ended up
      // driving another session's page: the ids were real, but the callers were not their owners.
      const available = unclaimed(guests.map(contents => contents.id))
      // Reclaim ours first so repeated calls from the same session are stable, then fill the
      // remainder from unclaimed tabs, then — only if still short — grow the strip.
      const ordered = [...mine, ...available.filter(id => !mine.has(id))]
      if (ordered.length >= want) {
        const chosen = ordered.slice(0, want)
        for (const id of chosen) claims.set(id, owner)
        return { ok: true, ids: chosen, verdict: lastVerdict, owner, claimed: chosen }
      }
      // Two steps, because one is not a tab. Measured on this shell: the strip's "+" control
      // (`aria-label 新标签页`) adds a START PAGE tab — a guide page listing the page types —
      // and produces no webview at all. The guest only comes from the guide entry on that new
      // tab, whose title is 浏览器 and whose command is browser.new. The loop previously did the
      // first step and then waited for a guest that could never appear, reporting "the control
      // was found and clicked, but no new guest appeared" — accurate, and pointing at the wrong
      // thing.
      if (!clickedPlus || !clickedGuide) {
        const acted = await sendCdp(shell.id, 'Runtime.evaluate', {
          expression: `(() => {
            const labelOf = (node) => ((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '') + ' ' + (node.getAttribute('title') || '')).trim();
            const clickables = (root, out = []) => {
              for (const node of root.querySelectorAll('button,[role=button]')) {
                out.push(node);
                if (node.shadowRoot) clickables(node.shadowRoot, out);
              }
              return out;
            };
            const all = clickables(document);
            const state = { plus: ${clickedPlus ? 'false' : 'true'}, guide: ${clickedGuide ? 'false' : 'true'} };
            // A tab that is still a guide page: give it its browser page. This is the step that
            // turns a start-page tab into a real webview.
            //
            // Identified by BOTH halves of the card, not by a prefix. The card carries the title
            // 浏览器 and the description 浏览网页, while a tab in the strip carries only the
            // title — so a prefix test would match the strip's own tab and merely switch to it,
            // which looks like "clicked and nothing happened" and would burn a round per visit.
            // The length bound keeps a container that happens to mention both out of it.
            if (state.guide) {
              const isCard = (n) => {
                const own = (n.textContent || '').trim();
                if (own.length > 24) return false;
                return /浏览器/.test(own) && /浏览网页/.test(own);
              };
              const guide = all.find(isCard);
              if (guide !== undefined) { guide.click(); return 'CLICKED_GUIDE' }
            }
            // Otherwise the strip needs another tab first; the guide appears on it, and the next
            // round takes the step above.
            // The strip's "+" control. Measured on this shell: the page carries TWO of them, one
            // visible and one not — the same shape as the hidden address input in issue #25, and
            // find() takes whichever comes first in the DOM. Clicking the hidden one does
            // nothing, which reads as "the click had no effect" rather than as a missing control.
            if (state.plus) {
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
                const s = getComputedStyle(el);
                return s.display !== 'none' && s.visibility !== 'hidden';
              };
              const plus = all.filter(visible).find(n => /新标签页|新建标签|new tab/i.test(labelOf(n)));
              if (plus !== undefined) { plus.click(); return 'CLICKED_PLUS' }
            }
            return 'WAITING';
          })()`,
          returnByValue: true,
        })
        lastVerdict = String(acted?.result?.value ?? '')
        if (lastVerdict === 'CLICKED_GUIDE') clickedGuide = true
        if (lastVerdict === 'CLICKED_PLUS') clickedPlus = true
        if (lastVerdict !== 'WAITING') sawControl = true
      }
      await new Promise(resolve => setTimeout(resolve, 600))
    }
    if (!sawControl) {
      // The strip may genuinely have the tabs this owner needs while the "new tab" control is
      // unreachable — a clickable strip without a plus button. Report what we can serve before
      // declaring failure, so a session that already owns a tab is not told it has none.
      const guests = webContents.getAllWebContents().filter(contents => contents.getType() === 'webview')
      const available = unclaimed(guests.map(contents => contents.id))
      const ordered = [...mine, ...available.filter(id => !mine.has(id))]
      if (ordered.length > 0) {
        for (const id of ordered) claims.set(id, owner)
        return { ok: true, ids: ordered, verdict: 'NO_CONTROL_BUT_REUSED', owner, claimed: ordered }
      }
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

    // Visibility-aware and exact-first: the page holds hidden URL inputs too, and picking
    // one of those is issue #25 — the submit lands nowhere and the guest is never created.
    const addressInput = () => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      };
      const all = Array.from(document.querySelectorAll('input')).filter(visible);
      const exact = all.filter(i => /^\s*输入\s*HTTP\(S\)\s*地址\s*$/.test(i.placeholder || '')
        || /^(Enter|Type)\s+(an\s+)?HTTP\(S\)\s+address/i.test(i.placeholder || ''));
      const pool = exact.length > 0 ? exact : all.filter(i => /HTTP|地址|url/i.test((i.placeholder || '') + (i.getAttribute('aria-label') || '')));
      return pool.length > 0 ? [pool[0]] : [];
    };

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
    // The launcher card, identified by BOTH halves of its text.
    //
    // This used to be a prefix test, anchored at the start and accepting the bare word, which
    // also matches the browser TAB in the strip — its whole label is 浏览器. Clicking that only
    // switches to an existing tab: no page is created, so no address bar ever appears and the
    // caller polls to exhaustion. The card is the only element carrying the title AND the
    // description 浏览网页, and it is short, so both are required. The same rule is used on the
    // newTab path; two paths doing one job must not have two rules.
    for (const node of clickables()) {
      const own = (node.textContent || '').trim();
      const aria = node.getAttribute('aria-label') || '';
      const isCard = own.length <= 24 && /浏览器/.test(own) && /浏览网页/.test(own);
      if (isCard || /open browser|new browser tab/i.test(aria)) {
        node.click();
        return 'CLICKED_LAUNCHER';
      }
    }

    // 4. Last resort: the shortcut the host registers for browser.new. Dispatched on the
    //    document, which reaches a handler bound at the window level; it does NOT reach a
    //    shortcut table, so this is a fallback and not the primary route (the bridge sends a
    //    real Ctrl+T through the Input domain on the newTab path, which does).
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
