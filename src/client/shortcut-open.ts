/**
 * Decide how a start-page shortcut's "Open" action should reach a Browser tab.
 *
 * `navigateTabIn` deliberately returns false (and does nothing) when the target
 * tab or the session's sidebar layout is gone. The context menu used to ignore
 * that answer, so the human saw a click with no effect and no explanation.
 * Opening a fresh tab is the honest fallback: the shortcut always goes
 * somewhere, and the existing tab is still preferred when it exists.
 *
 * Kept free of cordis / sidebar types so the branch is directly testable.
 * @module dsh-client-ui-sidebar-browser/client/shortcut-open
 */

/**
 * Aim an existing tab at a URL, then fall back to a new tab when that is not
 * possible.
 * @param navigate - re-aim the current tab; false when it no longer exists.
 * @param openNew - open the URL in a fresh Browser tab.
 * @param url - shortcut destination.
 * @returns which branch actually ran.
 */
export function openShortcutTarget(
  navigate: (url: string) => boolean,
  openNew: (url: string) => void,
  url: string,
): 'existing' | 'new-tab' {
  if (navigate(url)) return 'existing'
  openNew(url)
  return 'new-tab'
}
