import { sameOrigin } from './settings-route.js';
import { findDesktopInstall, readBridgeStatus } from './bridge-status.js';
/** Where the frame endpoint lives. The viewer must use exactly this path, same origin. */
export const PREVIEW_ROUTE = '/dsh-builtin-browser/browser-view/frame';
/**
 * Where the viewer asks which sessions it may watch.
 *
 * The provider names its sessions (`browser:<uuid>`) and only it knows them; the browser page has no
 * way to guess one. Without this the viewer could not build a frame URL at all, and inventing an id
 * is exactly what the design forbids. So the list is served, and it contains nothing but ids of
 * sessions that currently have a page — no URLs, no titles, no target handles.
 */
export const PREVIEW_SESSIONS_ROUTE = '/dsh-builtin-browser/browser-view/sessions';
/**
 * Where the settings panel asks whether the desktop bridge is installed.
 *
 * Reported as issue #36: a missing bridge was only a log warning, so a user on `channel: sidebar`
 * saw "another window opened again" with nothing connecting that to "the bridge is not installed".
 * The reading is taken from the install tree on disk, so it is true even when the plugin has just
 * started and remembers nothing.
 */
export const BRIDGE_STATUS_ROUTE = '/dsh-builtin-browser/bridge-status';
/**
 * List the sessions a viewer may watch.
 *
 * Ids only. The whole point of this endpoint is to give the page something it cannot guess; adding a
 * URL or title here would leak the very content the frame endpoint is careful not to describe in its
 * refusals.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param settings - the settings document, for the share switch.
 * @param browser - the browser service.
 */
export async function handlePreviewSessions(request, response, settings, browser) {
    if (request.method !== 'GET') {
        replyJson(response, 405, { error: 'method-not-allowed' });
        return;
    }
    if (!sameOrigin(request)) {
        replyJson(response, 403, { error: 'not-same-origin' });
        return;
    }
    if (settings.get().remoteView.enabled !== true) {
        // An empty list rather than a refusal: the panel asks this before it knows whether sharing is
        // on, and "nothing to watch" is the honest answer to give a client that is not allowed to watch.
        replyJson(response, 200, { enabled: false, sessions: [] });
        return;
    }
    const sessions = browser.watchableSessions?.() ?? [];
    replyJson(response, 200, { enabled: true, sessions: [...sessions] });
}
/** Write one JSON body with no caching and no sniffing. */
function replyJson(response, status, body) {
    const text = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store, private',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
    });
    response.end(text);
}
/**
 * Serve one frame, or say precisely why not.
 *
 * Every refusal is a status the viewer can act on: 403 when watching is switched off (the host has
 * not agreed), 404 when that session has no page (nothing to watch, and nothing is opened on its
 * behalf), 503 when the page cannot produce an image right now (hidden window, capture timeout) —
 * which the viewer shows as paused rather than as an error.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param settings - the settings document, for the host's share switch.
 * @param browser - the browser service, for passive capture.
 */
export async function handlePreviewFrame(request, response, settings, browser) {
    if (request.method !== 'GET') {
        replyJson(response, 405, { error: 'method-not-allowed' });
        return;
    }
    // The host's own pages only. A live browser frame can contain a CAPTCHA or logged-in content, so
    // the endpoint is not something a cross-origin page may pull even with the switch on.
    if (!sameOrigin(request)) {
        replyJson(response, 403, { error: 'not-same-origin' });
        return;
    }
    // The host's consent, checked per request rather than cached: switching sharing off must take
    // effect on the next frame, not on the next restart.
    if (settings.get().remoteView.enabled !== true) {
        replyJson(response, 403, { error: 'remote-view-disabled' });
        return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    const session = url.searchParams.get('session') ?? '';
    if (session === '') {
        replyJson(response, 400, { error: 'session-required' });
        return;
    }
    // A session the plugin did not hand out is not a session. This is the only identifier a caller
    // may supply; no carrier handle, view id, port or CDP target is accepted anywhere.
    if (!browser.exists(session)) {
        replyJson(response, 404, { error: 'no-such-session' });
        return;
    }
    try {
        const frame = await browser.capturePassive(session);
        const comma = frame.dataUrl.indexOf(',');
        if (comma === -1) {
            replyJson(response, 503, { error: 'preview-unavailable', retryable: true });
            return;
        }
        const header = frame.dataUrl.slice(0, comma);
        const base64 = frame.dataUrl.slice(comma + 1);
        const mime = /^data:([^;]+)/.exec(header)?.[1] ?? 'image/jpeg';
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.length === 0) {
            replyJson(response, 503, { error: 'preview-unavailable', retryable: true });
            return;
        }
        response.writeHead(200, {
            'content-type': mime,
            'content-length': bytes.length,
            // A frame is a moment, never a cached answer: replaying the last one would show the viewer a
            // picture that claims to be live.
            'cache-control': 'no-store, private',
            'x-content-type-options': 'nosniff',
            'cross-origin-resource-policy': 'same-origin',
            'x-captured-at': String(Date.now()),
        });
        response.end(bytes);
    }
    catch (error) {
        // BROWSER_PREVIEW_UNAVAILABLE is the expected "cannot draw this right now" (hidden or minimized
        // window, capture timeout). Anything else is still a refusal to serve an image, and the viewer
        // treats both the same way: show paused, do not retry in a tight loop.
        const code = error?.code;
        replyJson(response, 503, {
            error: code === 'BROWSER_PREVIEW_UNAVAILABLE' ? 'preview-unavailable' : 'capture-failed',
            retryable: true,
        });
    }
}
/**
 * Report whether the desktop bridge is installed, for the settings panel.
 *
 * Read-only and same-origin like the rest: it names a directory and a state, nothing that could be
 * used to reach anything else. The command it returns is for a human to run — executing it here
 * would let a page decide to close the desktop shell.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param localAppData - the base directory to probe; injected so a test can point at a fixture.
 */
export async function handleBridgeStatus(request, response, localAppData) {
    if (request.method !== 'GET') {
        replyJson(response, 405, { error: 'method-not-allowed' });
        return;
    }
    if (!sameOrigin(request)) {
        replyJson(response, 403, { error: 'not-same-origin' });
        return;
    }
    const installRoot = findDesktopInstall(localAppData);
    const status = installRoot === undefined
        ? {
            state: 'missing',
            present: false,
            archivePresent: false,
            detail: 'no DSH Desktop install found under LOCALAPPDATA\\Programs',
        }
        : readBridgeStatus(installRoot);
    replyJson(response, 200, { ok: true, bridge: status });
}
