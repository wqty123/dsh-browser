/**
 * The page-side probe: one script that makes a page observable without touching the host.
 *
 * WHY THIS EXISTS
 * Three capabilities the model needs are not tools here yet: what the console said, which network
 * responses arrived, and what happened to a JavaScript dialog. All three live *inside* the page, and
 * a dialog blocks the page until someone answers it — which is why a `confirm()` used to hang a whole
 * tool call with no explanation.
 *
 * The obvious implementation is CDP event capture (`Runtime.consoleAPICalled`, `Network.*`,
 * `Page.javascriptDialogOpening`) inside the host. That would mean a new capability in all three
 * carriers — the self-hosted child, the driven Chrome and the sidebar bridge — plus a protocol
 * version for the bridge. This probe instead installs itself with the `execute` path every carrier
 * already has, so it works everywhere on day one and cannot drift per carrier.
 *
 * What it costs, stated plainly:
 * - `console` and `network` see what the PAGE can see. A response that never reached `fetch`/`XHR`
 *   (a document navigation, an `<img>` failure the browser handled internally) appears only as a
 *   resource-timing entry, with no status code. CDP would know more.
 * - Dialog capture works by replacing `window.alert/confirm/prompt` BEFORE they are called. A dialog
 *   produced by the browser itself (`beforeunload`, HTTP auth, permission prompts) is not covered.
 * - It is an override, so a page that captured `window.fetch` earlier keeps its own copy. Installed
 *   at first use, which is early enough for every ordinary page and honest about the rest.
 *
 * Idempotent by version: installing twice keeps the buffers that already exist.
 * @module dsh-browser/tool-browser/page-probe
 */
import type { BrowserPageOperationRequest } from '../browser/types.js';
/** Bumped when the probe's shape changes; an older probe is replaced rather than trusted. */
export declare const PROBE_VERSION = 4;
/**
 * The installer, as one expression that returns the installed version.
 *
 * Written as a string because it runs in the page, not here. Keep it dependency-free and ES5-safe:
 * a page may be older than the harness.
 */
export declare const PROBE_INSTALL_SCRIPT: string;
/**
 * One probe call, evaluated in the page, with its result serialised as JSON.
 *
 * JSON in, JSON out, because that is the only shape every carrier's `execute` can carry reliably.
 * @param method - the probe function to call (`read`, `settle`, `find`, `overlayAt`, `clear`, …).
 * @param args - arguments, already JSON-serialisable.
 * @returns a script whose value is the JSON text of the result (or an error object).
 */
export declare function probeCallScript(method: string, args?: readonly unknown[]): string;
/**
 * Dispatch a pointer drag in the page, for elements that accept synthetic pointer events.
 *
 * Uses `PointerEvent` when the page has it and `MouseEvent` otherwise, because a canvas app that
 * listens for `mousedown` never sees a pointer event. This is a page-level gesture: a page that
 * demands trusted input (some canvas editors) ignores it, exactly like `click_sequence`'s
 * coordinate clicks are the trusted counterpart.
 * @param from - start point in viewport CSS pixels.
 * @param to - end point.
 * @param steps - intermediate moves; more steps make a slider or a canvas app follow the path.
 * @returns a script value: `{ ok: true, moved, at }` or `{ ok: false, reason }`.
 */
export declare function dragScript(from: {
    readonly x: number;
    readonly y: number;
}, to: {
    readonly x: number;
    readonly y: number;
}, steps?: number): string;
/**
 * Put a local file into an `<input type=file>`, without CDP.
 *
 * The page cannot read a disk path, so the bytes travel in as base64 and are rebuilt as a `File`
 * in page context, then attached through a `DataTransfer`. That is what a drag-and-drop handler
 * sees, so frameworks that read `input.files` or a drop event both work. The admission decision
 * (which path may be read at all) belongs to the caller; this only carries the bytes.
 * @param target - how to find the input: a CSS selector or visible text near it.
 * @param file - name, MIME type and base64 of the bytes.
 * @returns a script value: `{ ok: true, name, size }` or `{ ok: false, reason }`.
 */
export declare function uploadScript(target: {
    readonly by: 'css' | 'text' | 'xpath';
    readonly value: string;
}, file: {
    readonly name: string;
    readonly mime: string;
    readonly base64: string;
}): string;
/** Build a fixed page operation, rejecting unknown operations before any code runs. */
export declare function pageOperationScript(request: BrowserPageOperationRequest): string;
