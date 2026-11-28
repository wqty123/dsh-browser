/**
 * "Has this page already mounted the settings section?" (issue #132)
 *
 * The host keeps a slot registration for the lifetime of the page, while HMR replaces this module
 * in place. A hot re-apply therefore reaches the same `settings.section` id twice, the host refuses
 * the duplicate, and because that refusal used to happen inside the panel's own registration the
 * whole client registration was lost — the browser entry and the settings page disappeared together.
 *
 * The claim is per page (a global), and it is taken only AFTER a successful mount, so a genuinely
 * failed mount still retries on the next apply.
 */

/** The page-global key holding the claim. */
export const SETTINGS_MOUNTED_KEY = '__dshBuiltinBrowserSettingsMounted'

/**
 * Decide whether this apply still needs to mount the settings section.
 * @param scope - the page global object.
 * @returns true when the section has not been mounted on this page yet.
 */
export function claimSettingsMount(scope: Record<string, unknown>): boolean {
  return scope[SETTINGS_MOUNTED_KEY] !== true
}

/**
 * Record a successful mount so a later apply on the same page is a no-op.
 * @param scope - the page global object.
 */
export function markSettingsMounted(scope: Record<string, unknown>): void {
  scope[SETTINGS_MOUNTED_KEY] = true
}
