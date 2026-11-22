/**
 * Reply-side link styling.
 *
 * The composer rail styles itself through `ReferenceDock.module.css`; the only
 * rule that has to live in the host document concerns anchors an OLDER markdown
 * bundle renders for `dsh-browser-ref:` destinations. The link bridge upgrades
 * them in place, so they only need to look like a link until it does.
 *
 * Injected once per document, under a single id, and tolerant of a non-DOM host.
 *
 * @module dsh-browser-reference/production/styles
 */

export const DOCK_STYLE_ID = 'dsh-browser-reference-styles'

/** Stylesheet text installed by {@link ensureDockStyles}. */
export const DOCK_CSS = `
/* Reply-side dsh-browser-ref: destinations rendered by an older markdown
   bundle are ordinary anchors. The link bridge intercepts them; these rules
   only make the affordance readable and never change the host's own links. */
/* The sent message shows the SAME pill the composer showed: a reference must not
   lose its shape once submitted. Values mirror ReferenceDock.module.css .chip —
   26px tall, 999px radius, the same two theme tokens — so the two surfaces read
   as one control. */
a[data-dsh-browser-ref] {
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 10px; box-sizing: border-box;
  max-width: 100%; vertical-align: middle;
  border: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
  border-radius: 999px;
  background: var(--dsw-alias-bg-multi-select, rgba(127,127,127,.14));
  color: inherit; font: inherit; text-decoration: none;
  cursor: pointer; transition: background 120ms ease, border-color 120ms ease;
}
a[data-dsh-browser-ref]:hover {
  background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.22));
  border-color: var(--dsw-alias-border-l3, rgba(127,127,127,.5));
  text-decoration: none;
}
/* Sent messages render the source through BrowserRefLink, a button carrying this class. It gets
   the SAME pill the composer chip uses (26px, 999px radius, one border + one fill token), so a
   reference does not change shape when it is submitted. */
button.dsh-browser-ref-link {
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 10px; margin: 0 2px; box-sizing: border-box;
  max-width: 100%; vertical-align: middle;
  border: .5px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
  border-radius: 999px;
  background: var(--dsw-alias-bg-multi-select, rgba(127,127,127,.14));
  color: inherit; font: inherit; text-decoration: none;
  cursor: pointer; transition: background 120ms ease, border-color 120ms ease;
}
button.dsh-browser-ref-link:hover {
  background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.22));
  border-color: var(--dsw-alias-border-l3, rgba(127,127,127,.5));
}
button.dsh-browser-ref-link:disabled { opacity: .6; cursor: not-allowed; }
button.dsh-browser-ref-link:focus-visible { outline: 2px solid color-mix(in srgb, #3b82f6 65%, transparent);
  outline-offset: 2px; }
/* The numbered badge is the half the composer chip had and the sent pill did not. Same metrics as
   ReferenceDock.module.css .badge: 18px pill, 11px semibold number, inverted label colour. */
button.dsh-browser-ref-link .dsh-browser-ref-badge {
  flex: none; display: inline-grid; place-items: center; box-sizing: border-box;
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: var(--dsw-alias-state-business-primary, #3b82f6);
  color: var(--dsw-alias-label-primary-inverted, #fff);
  font-size: 11px; font-weight: 600; line-height: 1;
}
button.dsh-browser-ref-link .dsh-browser-ref-label { min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
a[data-dsh-browser-ref="unavailable"] { cursor: not-allowed; opacity: .6; }
a[data-dsh-browser-ref]:focus-visible { outline: 2px solid color-mix(in srgb, #3b82f6 65%, transparent);
  outline-offset: 2px; }
`

/**
 * Install the stylesheet once per document.
 *
 * @param doc - the host document; omitted in a non-DOM host (tests, SSR).
 */
export function ensureDockStyles(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (doc === undefined) return
  if (doc.getElementById(DOCK_STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = DOCK_STYLE_ID
  style.textContent = DOCK_CSS
  // A host UI served under `style-src 'nonce-…'` refuses an inline style element
  // without the nonce; borrowing the document's own keeps the dock styled there.
  let nonce: string | undefined
  try {
    const reference = typeof doc.querySelector === 'function'
      ? doc.querySelector('style[nonce], script[nonce]') as (HTMLElement & { nonce?: string }) | null
      : null
    nonce = reference?.nonce ?? reference?.getAttribute('nonce') ?? undefined
  } catch {
    nonce = undefined
  }
  if (nonce !== undefined && nonce !== '') style.setAttribute('nonce', nonce)
  try {
    ;(doc.head ?? doc.documentElement).appendChild(style)
  } catch {
    // A document that refuses the node simply stays unstyled; never break the dock.
  }
}
