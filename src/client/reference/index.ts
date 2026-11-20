/**
 * Host companion for the browser-reference Client plugin.
 *
 * The feature is Client-only: the delivery queue lives on the built-in browser
 * plugin's own webServer routes and this package only consumes them from the
 * browser. The Host half therefore has nothing to mount, but it must exist so
 * `tsc -b` emits `lib/types/index.d.ts` and the bundle entry resolves.
 */

/** Mount nothing on the Host; the Client loader applies the browser half. */
export function apply(): void {}
