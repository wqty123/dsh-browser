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
export {};
