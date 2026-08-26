/**
 * Self-hosted Electron browser host (child side): the Electron main process
 * spawned by {@link RemoteElectronViewHost}. Owns one `BrowserWindow` PER
 * SESSION (each session's views live in their own window) plus a browser
 * toolbar (address bar, back/forward/reload, tab strip) that makes the
 * built-in browser usable as a real browser by the human — every window has
 * its own toolbar. Views are `WebContentsView`s driven over
 * `webContents.debugger` (CDP); user toolbar actions are routed back to the
 * parent so the agent and the human always share one tab/navigation model.
 *
 * Protocol (one JSON object per line, both directions):
 *   <- { id, op: 'ping' } | { id, op: 'createView', viewId } |
 *      { id, op: 'destroyView', viewId } | { id, op: 'showView', viewId } |
 *      { id, op: 'groupView', viewId, windowId, label? } |
 *      { id, op: 'command', viewId, method, params } |
 *      { id, op: 'userActionError', windowId, message }
 *   -> { id: 0, op: 'hello', token } (our FIRST message — proves we know the
 *      parent's stdin token; the parent refuses the connection otherwise)
 *   -> { id, ok: true, result? } | { id, ok: false, err }
 *   -> { id: 0, op: 'userAction', action } (fire-and-forget; no reply)
 *
 * The parent never parses stderr, so diagnostics may go there freely.
 * @module dsh-browser/browser-electron/host-main
 */
import { app, BrowserWindow, WebContentsView } from 'electron';
import { createInterface } from 'node:readline';
import { createConnection } from 'node:net';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
/**
 * The spawn token the parent sent via stdin (first line). Must be echoed in
 * our hello. Read from stdin so the token never appears in argv (WMI /
 * Process Explorer / /proc/*).

// Isolate this host's profile from the DSH app's default Electron userData:
// several Electron instances sharing Roaming\Electron fight over the GPU
// cache/session locks, which can leave the window without a display surface
// (capturePage then fails). A dedicated userData also persists cookies across
// host restarts (on top of browser_auth). Must run before app is ready.
try {
  const base = process.env.DSH_HOME ?? app.getPath('appData')
  app.setPath('userData', join(base, 'dsh-builtin-browser-host'))
} catch (error) {
  process.stderr.write(`[dsh-browser host] userData setup failed: ${String(error)}\n`)
}

/**
 * Read the spawn token. The parent sends it two ways and the child prefers
 * the first that yields a value:
 *   1. stdin (first line) — the secure channel on Unix/macOS;
 *   2. DSH_BROWSER_RPC_TOKEN env — the fallback on Windows, where Electron is
 *      a GUI-subsystem process and never receives piped stdin (the parent
 *      sets it in the spawn env for exactly this reason).
 * stdin wins over env so the parent's token never has to touch argv.
 */
let RPC_TOKEN = process.env.DSH_BROWSER_RPC_TOKEN ?? '';
const stdinDelivered = RPC_TOKEN !== '';
if (process.stdin !== null && process.stdin.readable) {
    const stdinLines = createInterface({ input: process.stdin, terminal: false });
    stdinLines.on('line', (line) => {
        if (RPC_TOKEN === '') {
            RPC_TOKEN = line.trim();
            stdinLines.close();
        }
    });
    stdinLines.on('close', () => {
        if (RPC_TOKEN === '' && !stdinDelivered) {
            process.stderr.write('[dsh-browser host] warning: no token received on stdin or env\n');
        }
    });
}
/** CDP protocol version attached to every view's debugger. */
const CDP_VERSION = '1.3';
/** Download cap: the body is shipped base64 as one JSON line; bound the memory. */
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;
/** Toolbar height in CSS px: nav row + tab strip. Page views sit below it. */
const TOOLBAR_HEIGHT = 64;
/** Fallback group for views whose groupView never arrived (defensive only). */
const SHARED_WINDOW_ID = 'shared';
/** Windows by group key (session id). */
const windows = new Map();
/**
 * Window assignments received via groupView BEFORE the view's createView:
 * the parent sends groupView right after createView (both deferred until the
 * child is ready), so either order may arrive first.
 */
const assignments = new Map();
/** The RPC socket to the parent; set when the connection is established. */
let rpcSocket;
// ---------------------------------------------------------------------------
// Toolbar: a small HTML strip (address bar, back/forward/reload, tab strip)
// rendered in its own WebContentsView on top of every window. It talks to
// this main process over IPC; user actions go to the PARENT (which owns the
// session/tab model) as fire-and-forget `userAction` messages.
// ---------------------------------------------------------------------------
const TOOLBAR_PRELOAD = `const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('bridge', {
  post: (action, payload) => ipcRenderer.send('toolbar-action', action, payload),
  onTabs: cb => ipcRenderer.on('tabs', (_e, payload) => cb(payload)),
  onError: cb => ipcRenderer.on('user-action-error', (_e, text) => cb(text)),
})
`;
const TOOLBAR_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; font-family: system-ui, "Segoe UI", sans-serif; font-size: 12px; }
body { display: flex; flex-direction: column; background: #2b2d31; color: #e8e8e8; }
.nav { display: flex; align-items: center; gap: 4px; padding: 4px 6px; height: 32px; }
button.tool { background: transparent; border: none; color: inherit; width: 28px; height: 24px; border-radius: 4px; cursor: pointer; font-size: 13px; line-height: 1; flex: 0 0 auto; }
button.tool:hover { background: rgba(255,255,255,.12); }
#addr { flex: 1; min-width: 0; height: 24px; border: 1px solid rgba(255,255,255,.18); border-radius: 12px; background: rgba(255,255,255,.08); color: inherit; padding: 0 12px; font-size: 12px; outline: none; }
#addr:focus { border-color: #4a90d9; background: rgba(255,255,255,.14); }
#newtab { font-size: 15px; }
.strip { display: flex; align-items: stretch; gap: 2px; padding: 0 6px 4px; height: 30px; overflow-x: auto; }
.strip::-webkit-scrollbar { height: 4px; }
.tab { display: flex; align-items: center; gap: 6px; max-width: 180px; min-width: 90px; height: 24px; padding: 0 4px 0 10px; border-radius: 6px; background: rgba(255,255,255,.06); cursor: pointer; white-space: nowrap; flex: 0 0 auto; }
.tab:hover { background: rgba(255,255,255,.12); }
.tab.active { background: #3d4148; }
.tab .tt { overflow: hidden; text-overflow: ellipsis; flex: 1; }
.tab .x { width: 15px; height: 15px; border-radius: 3px; text-align: center; line-height: 15px; font-size: 10px; flex: 0 0 auto; }
.tab .x:hover { background: rgba(255,255,255,.25); }
#err { height: 0; overflow: hidden; font-size: 11px; color: #ff9090; padding: 0 8px; transition: height .15s; }
#err.show { height: 17px; }
</style>
</head>
<body>
  <div class="nav">
    <button class="tool" id="back" title="Back">&#9664;</button>
    <button class="tool" id="fwd" title="Forward">&#9654;</button>
    <button class="tool" id="reload" title="Reload">&#10227;</button>
    <input id="addr" placeholder="Search or enter address" spellcheck="false">
    <button class="tool" id="newtab" title="New tab">&#43;</button>
  </div>
  <div class="strip" id="strip"></div>
  <div id="err"></div>
<script>
const bridge = window.bridge
const addr = document.getElementById('addr')
const strip = document.getElementById('strip')
const errBox = document.getElementById('err')
let showErrT = 0
function showErr(text) {
  errBox.textContent = String(text)
  errBox.classList.add('show')
  clearTimeout(showErrT)
  showErrT = setTimeout(() => errBox.classList.remove('show'), 5000)
}
function post(action, payload) { bridge.post(action, payload || {}) }
document.getElementById('back').onclick = () => post('back')
document.getElementById('fwd').onclick = () => post('forward')
document.getElementById('reload').onclick = () => post('reload')
document.getElementById('newtab').onclick = () => {
  const v = addr.value.trim()
  post('new-tab', v !== '' ? { url: v } : {})
  addr.value = ''
}
addr.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const v = addr.value.trim()
    if (v !== '') { post('navigate', { url: v }); addr.blur() }
  }
})
bridge.onTabs(payload => {
  const tabs = (payload && payload.tabs) || []
  strip.textContent = ''
  for (const t of tabs) {
    const el = document.createElement('div')
    el.className = 'tab' + (t.active ? ' active' : '')
    const tt = document.createElement('span')
    tt.className = 'tt'
    tt.textContent = (t.title && t.title !== '') ? t.title : ((t.url && t.url !== '' && t.url !== 'about:blank') ? t.url : 'New tab')
    tt.title = t.url || ''
    el.appendChild(tt)
    const x = document.createElement('span')
    x.className = 'x'
    x.textContent = '\\u2715'
    x.onclick = e => { e.stopPropagation(); post('close', { viewId: t.viewId }) }
    el.appendChild(x)
    el.onclick = () => post('activate', { viewId: t.viewId })
    strip.appendChild(el)
  }
  const act = tabs.find(t => t.active)
  if (act && document.activeElement !== addr) addr.value = act.url || ''
})
bridge.onError(text => showErr(text))
</script>
</body>
</html>
`;
/** Temp dir for the toolbar files; written once per process. */
const TOOLBAR_DIR = join(tmpdir(), `dsh-browser-toolbar-${process.pid}`);
let toolbarFilesReady = false;
/** Write the toolbar's html + preload to disk once. */
function ensureToolbarFiles() {
    if (toolbarFilesReady)
        return;
    toolbarFilesReady = true;
    mkdirSync(TOOLBAR_DIR, { recursive: true });
    writeFileSync(join(TOOLBAR_DIR, 'preload.js'), TOOLBAR_PRELOAD);
    writeFileSync(join(TOOLBAR_DIR, 'toolbar.html'), TOOLBAR_HTML);
}
/** Reply to the parent over the RPC socket. */
function reply(id, payload) {
    if (rpcSocket === undefined) {
        process.stderr.write(`[dsh-browser host] reply without socket (id=${id})\n`);
        return;
    }
    rpcSocket.write(JSON.stringify({ id, ...payload }) + '\n');
}
/** Send a fire-and-forget user action to the parent (no reply expected). */
function sendUserAction(action) {
    if (rpcSocket === undefined)
        return;
    try {
        rpcSocket.write(JSON.stringify({ id: 0, op: 'userAction', action }) + '\n');
    }
    catch { /* socket closed */ }
}
/** Turn a typed-in address into a URL (add https:// when no scheme is given). */
function normalizeUrl(raw) {
    const trimmed = raw.trim();
    if (trimmed === '')
        return '';
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed))
        return trimmed;
    return 'https://' + trimmed;
}
/** Route one toolbar interaction to the parent (which owns the session model). */
function handleToolbarAction(win, action, payload) {
    const windowId = win.windowId;
    switch (action) {
        case 'navigate': {
            const url = normalizeUrl(String(payload.url ?? ''));
            if (url === '')
                return;
            sendUserAction({ type: 'navigate', windowId, url });
            return;
        }
        case 'new-tab': {
            const raw = String(payload.url ?? '').trim();
            const url = raw !== '' ? normalizeUrl(raw) : undefined;
            sendUserAction({ type: 'newTab', windowId, ...url !== undefined ? { url } : {} });
            return;
        }
        case 'activate':
            sendUserAction({ type: 'activateTab', windowId, viewId: String(payload.viewId ?? '') });
            return;
        case 'close':
            sendUserAction({ type: 'closeTab', windowId, viewId: String(payload.viewId ?? '') });
            return;
        case 'back':
            sendUserAction({ type: 'back', windowId });
            return;
        case 'forward':
            sendUserAction({ type: 'forward', windowId });
            return;
        case 'reload':
            sendUserAction({ type: 'reload', windowId });
            return;
        default:
            process.stderr.write(`[dsh-browser host] unknown toolbar action: ${action}\n`);
    }
}
/** Find the window holding a view, if any. */
function windowOfView(viewId) {
    for (const win of windows.values()) {
        if (win.views.has(viewId))
            return win;
    }
    return undefined;
}
/** Get (or lazily create) the window for a group key. */
function windowFor(windowId) {
    const key = windowId === undefined || windowId === '' ? SHARED_WINDOW_ID : windowId;
    const existing = windows.get(key);
    if (existing !== undefined)
        return existing;
    const w = new BrowserWindow({ width: 1400, height: 900, show: true, title: 'dsh-browser' });
    w.on('closed', () => { windows.delete(key); });
    const win = { windowId: key, window: w, toolbarView: undefined, views: new Map(), visibleViewId: undefined, closeTimer: undefined };
    // Keep every view (and the toolbar) filling the window as the human
    // resizes it; otherwise pages stay at their original size and break.
    w.on('resize', () => layoutWindow(win));
    windows.set(key, win);
    win.toolbarView = createToolbar(win);
    layoutWindow(win);
    return win;
}
/** Position the toolbar and every page view within a window. */
function layoutWindow(win) {
    try {
        const size = win.window.getContentSize() ?? [0, 0];
        const width = size[0] ?? 0;
        const height = size[1] ?? 0;
        try {
            win.toolbarView?.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
        }
        catch { /* destroyed */ }
        for (const v of win.views.values()) {
            try {
                v.webContentsView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
            }
            catch { /* destroyed */ }
        }
    }
    catch { /* window gone */ }
}
/** Create the toolbar view for a window (best-effort; never fatal). */
function createToolbar(win) {
    try {
        ensureToolbarFiles();
        const view = new WebContentsView({
            webPreferences: {
                preload: join(TOOLBAR_DIR, 'preload.js'),
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
            },
        });
        void view.webContents.loadFile(join(TOOLBAR_DIR, 'toolbar.html')).catch(() => { });
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        view.webContents.on('ipc-message', (_event, channel, ...args) => {
            if (channel !== 'toolbar-action')
                return;
            // Diagnostics only; the parent never parses stderr.
            process.stderr.write(`[dsh-browser host] toolbar action: ${String(args[0] ?? '')}\n`);
            handleToolbarAction(win, String(args[0] ?? ''), (args[1] ?? {}));
        });
        // Once the toolbar page is up, push the current tab strip so it is not
        // empty until the first navigation event.
        view.webContents.on('dom-ready', () => syncToolbar(win));
        win.window.contentView.addChildView(view);
        return view;
    }
    catch (error) {
        process.stderr.write(`[dsh-browser host] toolbar creation failed: ${String(error)}\n`);
        return undefined;
    }
}
/** Push the window's tab strip state to its toolbar. */
function syncToolbar(win) {
    if (win.toolbarView === undefined)
        return;
    const tabs = [];
    for (const [viewId, v] of win.views) {
        let title = '';
        let url = '';
        try {
            title = v.webContentsView.webContents.getTitle();
            url = v.webContentsView.webContents.getURL();
        }
        catch { /* destroyed */ }
        tabs.push({ viewId, title, url, active: viewId === win.visibleViewId });
    }
    try {
        win.toolbarView.webContents.send('tabs', { tabs });
    }
    catch { /* toolbar not loaded yet */ }
}
/** Set a window's title: dsh-browser [label] — page title — url. */
function updateWindowTitle(win, viewId, label) {
    try {
        let title = 'dsh-browser';
        if (label !== undefined && label !== '')
            title += ` [${label.slice(0, 48)}]`;
        const entry = viewId !== undefined ? win.views.get(viewId) : undefined;
        if (entry !== undefined) {
            const pageTitle = entry.webContentsView.webContents.getTitle();
            const url = entry.webContentsView.webContents.getURL();
            if (pageTitle !== '')
                title += ` — ${pageTitle}`;
            if (url !== '' && url !== 'about:blank')
                title += ` — ${url}`;
        }
        win.window.setTitle(title);
    }
    catch { /* destroyed */ }
}
/** Make one view the visible (topmost) one within its window. */
function showViewInWindow(win, viewId, label) {
    const entry = win.views.get(viewId);
    if (entry === undefined)
        return;
    if (win.visibleViewId !== viewId) {
        // Hide every other view in THIS window, then show and RAISE the target
        // (topmost child wins). When the target is already visible, skip the
        // remove/re-add dance — doing it on every operation flickered.
        for (const v of win.views.values()) {
            if (v === entry)
                continue;
            try {
                v.webContentsView.setVisible(false);
            }
            catch { /* destroyed */ }
        }
        entry.webContentsView.setVisible(true);
        try {
            win.window.contentView.removeChildView(entry.webContentsView);
            win.window.contentView.addChildView(entry.webContentsView);
        }
        catch { /* window closing */ }
        win.visibleViewId = viewId;
        syncToolbar(win);
    }
    // Always refresh the title: it reflects the CURRENT page of the visible
    // view, which changes as the agent navigates.
    updateWindowTitle(win, viewId, label);
    // Raise this session's window so the human sees the page being worked on
    // (moveTop raises without stealing keyboard focus).
    try {
        if (!win.window.isVisible())
            win.window.show();
        win.window.moveTop();
    }
    catch { /* closing */ }
}
/** Close a session window once its last view is gone (deferred, flicker-free). */
function scheduleWindowClose(win) {
    if (win.windowId === SHARED_WINDOW_ID)
        return; // shared fallback persists
    if (win.closeTimer !== undefined)
        clearTimeout(win.closeTimer);
    win.closeTimer = setTimeout(() => {
        win.closeTimer = undefined;
        if (win.views.size > 0)
            return; // a new tab arrived; keep the window
        try {
            win.toolbarView?.webContents.close();
        }
        catch { /* already gone */ }
        try {
            win.window.close();
        }
        catch { /* already gone */ }
    }, 250);
}
/** Handle one command. */
async function handle(op, msg) {
    try {
        switch (op) {
            case 'ping':
                reply(msg.id, { ok: true });
                return;
            case 'groupView': {
                const viewId = msg.viewId;
                const windowId = msg.windowId;
                if (viewId === undefined || typeof windowId !== 'string')
                    throw new Error('groupView missing viewId/windowId');
                // May arrive before or after createView; createView consumes it.
                assignments.set(viewId, { windowId, ...typeof msg.label === 'string' ? { label: msg.label } : {} });
                reply(msg.id, { ok: true });
                return;
            }
            case 'createView': {
                const viewId = msg.viewId;
                if (viewId === undefined)
                    throw new Error('createView missing viewId');
                const assignment = assignments.get(viewId);
                const win = windowFor(assignment?.windowId);
                const view = new WebContentsView();
                // Route popups (window.open / target=_blank) back into THIS view
                // instead of letting Electron open untracked native windows that would
                // diverge from the session/tab model.
                view.webContents.setWindowOpenHandler(({ url }) => {
                    // HTTP(S) popups (target=_blank, ads): redirect into this view
                    // instead of opening an untracked native window.
                    if (/^https?:/i.test(url)) {
                        void view.webContents.loadURL(url).catch(() => { });
                        return { action: 'deny' };
                    }
                    // Non-HTTP popups (OAuth redirects, mailto:, custom schemes):
                    // allow the native window so OAuth flows and deep links work.
                    return { action: 'allow' };
                });
                // Attach the debugger BEFORE the view can be seen: an attach failure
                // then leaves nothing in the window (no visible ghost view).
                view.webContents.debugger.attach(CDP_VERSION);
                // New views start hidden: only the shown one may be visible.
                view.setVisible(false);
                win.window.contentView.addChildView(view);
                win.views.set(viewId, { webContentsView: view });
                // Keep the window title and the toolbar tab strip live as the page
                // changes (navigations, title updates).
                view.webContents.on('page-title-updated', () => { updateWindowTitle(win, viewId, undefined); syncToolbar(win); });
                view.webContents.on('did-navigate', () => { updateWindowTitle(win, viewId, undefined); syncToolbar(win); });
                view.webContents.on('did-navigate-in-page', () => syncToolbar(win));
                const first = win.views.size === 1;
                if (first) {
                    view.setVisible(true);
                    win.visibleViewId = viewId;
                }
                layoutWindow(win);
                if (first)
                    updateWindowTitle(win, viewId, undefined);
                syncToolbar(win);
                reply(msg.id, { ok: true });
                return;
            }
            case 'destroyView': {
                const viewId = msg.viewId;
                if (viewId === undefined)
                    throw new Error('destroyView missing viewId');
                const win = windowOfView(viewId);
                if (win !== undefined) {
                    const entry = win.views.get(viewId);
                    win.views.delete(viewId);
                    if (win.visibleViewId === viewId)
                        win.visibleViewId = undefined;
                    try {
                        entry?.webContentsView.webContents.debugger.detach();
                    }
                    catch { /* already detached */ }
                    try {
                        entry?.webContentsView.webContents.close();
                    }
                    catch { /* destroyed */ }
                    try {
                        if (entry !== undefined)
                            win.window.contentView.removeChildView(entry.webContentsView);
                    }
                    catch { /* destroyed */ }
                    // The visible tab was destroyed: show the next one in this window.
                    if (win.visibleViewId === undefined && win.views.size > 0) {
                        const next = win.views.keys().next().value;
                        if (next !== undefined)
                            showViewInWindow(win, next);
                    }
                    else if (win.visibleViewId === undefined) {
                        // No views left — reset the window title so it doesn't
                        // retain the old page's title.
                        updateWindowTitle(win, undefined, undefined);
                    }
                    syncToolbar(win);
                    // Close the window with its last view — deferred because the
                    // provider re-creates a blank tab right after closing the last one.
                    scheduleWindowClose(win);
                }
                assignments.delete(viewId);
                reply(msg.id, { ok: true });
                return;
            }
            case 'showView': {
                const viewId = msg.viewId;
                if (viewId === undefined)
                    throw new Error('showView missing viewId');
                const win = windowOfView(viewId);
                if (win !== undefined)
                    showViewInWindow(win, viewId, typeof msg.label === 'string' ? msg.label : undefined);
                reply(msg.id, { ok: true });
                return;
            }
            case 'userActionError': {
                const windowId = msg.windowId;
                const message = msg.message;
                if (typeof windowId !== 'string' || typeof message !== 'string')
                    throw new Error('userActionError missing windowId/message');
                const win = windows.get(windowId);
                if (win !== undefined) {
                    try {
                        win.toolbarView?.webContents.send('user-action-error', message);
                    }
                    catch { /* toolbar not loaded */ }
                }
                reply(msg.id, { ok: true });
                return;
            }
            case 'command': {
                const viewId = msg.viewId;
                if (viewId === undefined)
                    throw new Error('command missing viewId');
                const win = windowOfView(viewId);
                const entry = win?.views.get(viewId);
                if (win === undefined || entry === undefined)
                    throw new Error(`command: unknown view ${viewId}`);
                const method = msg.method;
                if (typeof method !== 'string')
                    throw new Error('command missing method');
                const result = await entry.webContentsView.webContents.debugger.sendCommand(method, msg.params ?? {});
                reply(msg.id, { ok: true, result });
                return;
            }
            case 'capture': {
                const viewId = msg.viewId;
                if (viewId === undefined)
                    throw new Error('capture missing viewId');
                const win = windowOfView(viewId);
                const entry = win?.views.get(viewId);
                if (win === undefined || entry === undefined)
                    throw new Error(`capture: unknown view ${viewId}`);
                // Two complementary paths, because each has a failure mode:
                //  - capturePage: fast and reliable with several WebContentsViews in
                //    the window, but needs a live display surface (fails when the
                //    window is minimized/occluded/unpainted).
                //  - CDP Page.captureScreenshot: works without a display surface, but
                //    can hang when another hidden WebContentsView exists in the window.
                // Try capturePage first (show/focus/restore + one retry), then CDP.
                // PNG/JPEG + downscale are applied on the NativeImage here, so the
                // body never needs a second round-trip.
                const wantFormat = msg.format === 'jpeg' ? 'jpeg' : 'png';
                const wantQuality = typeof msg.quality === 'number' ? msg.quality : 80;
                const maxW = typeof msg.maxWidth === 'number' ? msg.maxWidth : 0;
                const maxH = typeof msg.maxHeight === 'number' ? msg.maxHeight : 0;
                let mime = 'image/png';
                try {
                    if (!win.window.isVisible())
                        win.window.show();
                }
                catch { /* closing */ }
                try {
                    win.window.restore();
                }
                catch { /* not minimized */ }
                win.window.focus();
                let base64 = '';
                try {
                    let image;
                    try {
                        image = await entry.webContentsView.webContents.capturePage();
                    }
                    catch (error) {
                        process.stderr.write(`[dsh-browser host] capturePage failed: ${String(error)}\n`);
                        await new Promise(resolve => setTimeout(resolve, 400));
                        image = await entry.webContentsView.webContents.capturePage();
                    }
                    // Downscale to fit the requested box, preserving aspect ratio.
                    const size = image.getSize();
                    let w = size.width ?? 0;
                    let h = size.height ?? 0;
                    if (maxW > 0 && w > maxW) {
                        h = Math.round(h * maxW / w);
                        w = maxW;
                    }
                    if (maxH > 0 && h > maxH) {
                        w = Math.round(w * maxH / h);
                        h = maxH;
                    }
                    if (w > 0 && h > 0 && (w !== size.width || h !== size.height))
                        image = image.resize({ width: w, height: h });
                    const buf = wantFormat === 'jpeg' ? image.toJPEG(wantQuality) : image.toPNG();
                    if (wantFormat === 'jpeg')
                        mime = 'image/jpeg';
                    if (buf.length > 0)
                        base64 = buf.toString('base64');
                }
                catch (error) {
                    process.stderr.write(`[dsh-browser host] capturePage retry failed: ${String(error)}\n`);
                    base64 = '';
                }
                if (base64 === '') {
                    // CDP fallback. Page.captureScreenshot can hang when OTHER views
                    // (especially hidden attach-first ones) are in the window, so
                    // temporarily detach the siblings AND the toolbar, capture in
                    // single-view state, then restore them (target stays on top).
                    const siblings = [...win.views.values()].filter(v => v !== entry);
                    const toolbar = win.toolbarView;
                    for (const v of siblings) {
                        try {
                            win.window.contentView.removeChildView(v.webContentsView);
                        }
                        catch { /* already gone */ }
                    }
                    if (toolbar !== undefined) {
                        try {
                            win.window.contentView.removeChildView(toolbar);
                        }
                        catch { /* already gone */ }
                    }
                    try {
                        const shot = await entry.webContentsView.webContents.debugger.sendCommand('Page.captureScreenshot', {});
                        const data = shot.data;
                        if (typeof data === 'string' && data.length > 0)
                            base64 = data;
                    }
                    finally {
                        if (toolbar !== undefined) {
                            try {
                                win.window.contentView.addChildView(toolbar);
                            }
                            catch { /* destroyed */ }
                        }
                        for (const v of siblings) {
                            try {
                                win.window.contentView.addChildView(v.webContentsView);
                            }
                            catch { /* destroyed */ }
                        }
                        try {
                            win.window.contentView.removeChildView(entry.webContentsView);
                            win.window.contentView.addChildView(entry.webContentsView);
                        }
                        catch { /* closing */ }
                    }
                }
                if (base64 === '') {
                    throw new Error('capture produced no image (view not painted)');
                }
                reply(msg.id, { ok: true, result: { base64, mime } });
                return;
            }
            case 'download': {
                const viewId = msg.viewId;
                const url = msg.url;
                const savePath = msg.savePath;
                if (viewId === undefined || typeof url !== 'string' || typeof savePath !== 'string') {
                    throw new Error('download missing viewId/url/savePath');
                }
                const win = windowOfView(viewId);
                const entry = win?.views.get(viewId);
                if (win === undefined || entry === undefined)
                    throw new Error(`download: unknown view ${viewId}`);
                // Fetch the URL inside the page context (keeps cookies/login), read
                // the body as base64, and write the file HERE — the body never
                // crosses the RPC line protocol, so large downloads cannot balloon
                // the parent's memory or hit the single-line cap. This also avoids
                // Electron's download pipeline entirely (CDP debugger attach can
                // interfere with will-download).
                const result = await entry.webContentsView.webContents.debugger.sendCommand('Runtime.evaluate', {
                    // Stream the body through a reader so the size cap is enforced as
                    // bytes arrive — never buffer an unbounded download into memory
                    // before checking the limit (a huge URL would otherwise OOM the
                    // renderer). The declared Content-Length short-circuits large files
                    // before any body is read.
                    expression: `(async () => {
            const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' })
            if (!r.ok) throw new Error('HTTP ' + r.status)
            const declared = Number(r.headers.get('content-length') || 0)
            if (declared > ${String(MAX_DOWNLOAD_BYTES)}) throw new Error('download too large (limit ' + ${String(MAX_DOWNLOAD_BYTES)} + ' bytes, declared ' + declared + ')')
            if (!r.body || typeof r.body.getReader !== 'function') {
              const b = await r.arrayBuffer()
              const bytes = new Uint8Array(b)
              if (bytes.length > ${String(MAX_DOWNLOAD_BYTES)}) throw new Error('download too large (limit ' + ${String(MAX_DOWNLOAD_BYTES)} + ' bytes, got ' + bytes.length + ')')
              let bin = ''
              for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
              return btoa(bin)
            }
            const reader = r.body.getReader()
            const chunks = []
            let total = 0
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              total += value.length
              if (total > ${String(MAX_DOWNLOAD_BYTES)}) {
                await reader.cancel()
                throw new Error('download too large (limit ' + ${String(MAX_DOWNLOAD_BYTES)} + ' bytes, got ' + total + ')')
              }
              chunks.push(value)
            }
            const bytes = new Uint8Array(total)
            let off = 0
            for (const c of chunks) { bytes.set(c, off); off += c.length }
            let bin = ''
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
            return btoa(bin)
          })()`,
                    awaitPromise: true,
                    returnByValue: true,
                });
                const value = result.result?.value;
                if (typeof value !== 'string') {
                    const detail = result.exceptionDetails;
                    throw new Error(`download failed: ${detail?.exception?.description ?? 'no data'}`);
                }
                // Temp file + rename keeps the write atomic-ish: a crash mid-write
                // leaves only a `.part` file, never a half-written final file.
                const tmpPath = savePath + '.part';
                mkdirSync(dirname(savePath), { recursive: true });
                writeFileSync(tmpPath, Buffer.from(value, 'base64'));
                try {
                    renameSync(tmpPath, savePath);
                }
                catch (error) {
                    // A failed rename must not leave a stray .part behind.
                    try {
                        unlinkSync(tmpPath);
                    }
                    catch { /* already gone */ }
                    throw error;
                }
                reply(msg.id, { ok: true, result: { path: savePath } });
                return;
            }
            case 'flushAuth': {
                const viewId = msg.viewId;
                if (viewId === undefined)
                    throw new Error('flushAuth missing viewId');
                const win = windowOfView(viewId);
                const entry = win?.views.get(viewId);
                if (win === undefined || entry === undefined)
                    throw new Error(`flushAuth: unknown view ${viewId}`);
                // Export the session's cookies so login state can be saved/restored
                // across browser hosts (or shared with another machine).
                const cookies = await entry.webContentsView.webContents.session.cookies.get({});
                const exported = cookies.map(c => {
                    // Electron types the cookie domain as optional; a missing domain
                    // cannot be exported meaningfully, so default to '' (matches the
                    // shim's string typing and keeps the export shape stable).
                    const domain = c.domain ?? '';
                    const host = domain.startsWith('.') ? domain.slice(1) : domain;
                    // IPv6 literal domains need brackets in a URL (e.g. http://[::1]/).
                    const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
                    return {
                        url: `http${c.secure ? 's' : ''}://${hostPart}${c.path}`,
                        name: c.name,
                        value: c.value,
                        domain,
                        path: c.path,
                        secure: c.secure,
                        httpOnly: c.httpOnly,
                        expirationDate: c.expirationDate,
                    };
                });
                reply(msg.id, { ok: true, result: { cookies: exported } });
                return;
            }
            case 'restoreAuth': {
                const viewId = msg.viewId;
                const cookies = msg.cookies;
                if (viewId === undefined)
                    throw new Error('restoreAuth missing viewId');
                const win = windowOfView(viewId);
                const entry = win?.views.get(viewId);
                if (win === undefined || entry === undefined)
                    throw new Error(`restoreAuth: unknown view ${viewId}`);
                if (!Array.isArray(cookies))
                    throw new Error('restoreAuth missing cookies array');
                let restored = 0;
                for (const c of cookies) {
                    if (typeof c.url !== 'string' || typeof c.name !== 'string' || typeof c.value !== 'string')
                        continue;
                    await entry.webContentsView.webContents.session.cookies.set({
                        url: c.url,
                        name: c.name,
                        value: c.value,
                        ...typeof c.domain === 'string' ? { domain: c.domain } : {},
                        ...typeof c.path === 'string' ? { path: c.path } : {},
                        ...typeof c.secure === 'boolean' ? { secure: c.secure } : {},
                        ...typeof c.httpOnly === 'boolean' ? { httpOnly: c.httpOnly } : {},
                        ...typeof c.expirationDate === 'number' ? { expirationDate: c.expirationDate } : {},
                    });
                    restored++;
                }
                reply(msg.id, { ok: true, result: { restored } });
                return;
            }
            default:
                throw new Error(`unknown op ${op}`);
        }
    }
    catch (error) {
        reply(msg.id, { ok: false, err: String(error) });
    }
}
/**
 * Electron entry: connect back to the parent's RPC server (port from
 * `--rpc-port`) and serve line-delimited JSON-RPC. `ELECTRON_RUN_AS_NODE` is
 * cleared by the parent so `require('electron')` works; this file is loaded as
 * the app entry so `app` is available immediately.
 */
void app.whenReady().then(() => {
    const portArg = process.argv.indexOf('--rpc-port');
    const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : NaN;
    if (!Number.isFinite(port)) {
        process.stderr.write('[dsh-browser host] missing --rpc-port\n');
        app.exit(1);
        return;
    }
    const socket = createConnection({ host: '127.0.0.1', port });
    rpcSocket = socket;
    socket.setEncoding('utf8');
    // Prove we know the parent's spawn token before anything else; the parent
    // refuses a connection whose first line is not this hello. The token is
    // written to stdin at spawn (moments after process start, long before
    // Electron's whenReady resolves), but guard the ordering anyway: sending an
    // empty hello would read as a spoofed connection and tear the session down.
    const writeHello = () => {
        socket.write(JSON.stringify({ id: 0, op: 'hello', token: RPC_TOKEN }) + '\n');
    };
    if (RPC_TOKEN !== '') {
        writeHello();
    }
    else {
        // No token yet (env absent and stdin still pending): wait for stdin's
        // first line with a bounded fallback, then send whatever we have — an
        // empty hello is refused by the parent, which then fails cleanly.
        const fallback = setTimeout(() => writeHello(), 2_000);
        if (process.stdin !== null && process.stdin.readable) {
            const stdinLines = createInterface({ input: process.stdin, terminal: false });
            stdinLines.once('line', () => { clearTimeout(fallback); writeHello(); });
            stdinLines.once('close', () => { clearTimeout(fallback); writeHello(); });
        }
    }
    const rl = createInterface({ input: socket });
    rl.on('line', line => {
        const text = line.trim();
        if (text === '')
            return;
        let msg;
        try {
            msg = JSON.parse(text);
        }
        catch {
            return; // non-protocol noise
        }
        if (typeof msg.id !== 'number' || typeof msg.op !== 'string')
            return;
        void handle(msg.op, msg).catch(() => { });
    });
    socket.on('error', error => {
        process.stderr.write(`[dsh-browser host] socket error: ${String(error)}\n`);
    });
    // The parent owns our lifetime: when it closes the socket (dispose) or dies
    // without cleanup, exit so no zombie Electron window is left behind.
    socket.on('close', () => {
        process.stderr.write('[dsh-browser host] parent connection closed, exiting\n');
        app.exit(0);
    });
    // Keep the process alive until the parent closes the socket or kills us.
});
// Diagnostics go to stderr, which the parent never parses as protocol.
process.on('uncaughtException', error => {
    process.stderr.write(`[dsh-browser host] uncaught: ${String(error)}\n`);
});
