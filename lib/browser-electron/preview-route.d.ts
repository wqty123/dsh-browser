/**
 * The live-view frame endpoint (issue #34): one JPEG per request, for a remote operator watching the
 * page the agent is driving.
 *
 * Deliberately one frame per request rather than a stream. The viewer asks for the next frame after
 * it has decoded and painted the previous one, so a slow link slows the view down instead of
 * queueing images; the design chose this over MJPEG and WebSocket for the first version precisely
 * because it needs no new plumbing and degrades predictably.
 *
 * The path is fixed and the session travels as a query parameter because the host web server only
 * registers exact paths. That is also why the session id is not a `viewId`: a client may name a
 * session the plugin handed out, never a carrier handle, a port, or an arbitrary target.
 * @module dsh-browser/browser-electron/preview-route
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Where the frame endpoint lives. The viewer must use exactly this path, same origin. */
export declare const PREVIEW_ROUTE = "/dsh-builtin-browser/browser-view/frame";
/** What the route needs from the settings document. */
interface PreviewSettings {
    get(): {
        readonly remoteView: {
            readonly enabled: boolean;
        };
    };
}
/** What the route needs from the browser service. */
interface PreviewBrowser {
    exists(session: string): boolean;
    capturePassive(session: string, signal?: AbortSignal): Promise<{
        readonly dataUrl: string;
    }>;
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
export declare function handlePreviewFrame(request: IncomingMessage, response: ServerResponse, settings: PreviewSettings, browser: PreviewBrowser): Promise<void>;
export {};
