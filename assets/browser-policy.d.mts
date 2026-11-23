export const BROWSER_PROFILE_DIR: string
export const LOOPBACK_IPV4: string
export const URL_PARSE_BASE: string
export const SETTINGS_ROUTE: string
export const EXTENSION_INSTALL_ROUTE: string
export const DEFAULT_OPERATION_TIMEOUT_MS: number
export const CDP_DEFAULT_ATTACH_PORT: number
export const CDP_ATTACH_PROBE_TIMEOUT_MS: number
export const EXTENSION_READY_TIMEOUT_MS: number
export const EXTENSION_PROBE_TIMEOUT_MS: number
export const NATIVE_REGISTRATION_TIMEOUT_MS: number
export const NATIVE_REGISTRATION_MAX_BUFFER: number
/** Default per-call budget of a dsh_browser_* tool. */
export const TOOL_DEFAULT_TIMEOUT_MS: number
/** Kept back from a tool budget so a wait can still return its verdict before the call aborts. */
export const TOOL_WAIT_RESERVE_MS: number
/** Shortest wait budget a tool call is given, whatever its budget. */
export const TOOL_WAIT_MIN_MS: number
/** Most fields dsh_browser_fill accepts in one batch. */
export const MAX_FILL_FIELDS: number
/** Default and largest per-cell deadline of dsh_browser_code. */
export const CODE_TOOL_DEFAULT_TIMEOUT_MS: number
export const CODE_TOOL_MAX_TIMEOUT_MS: number
export function extensionPageUrl(browser: 'edge' | 'chrome'): string
export function cdpVersionUrl(port: number): string
export function folderOpener(platform: string): string
export const REFERENCE_LIST_ROUTE: string
export const REFERENCE_GET_ROUTE: string
export const CLIENT_VERSION_ROUTE: string
export const REFERENCE_CAPTURE_ROUTE: string
export const REFERENCE_REVEAL_ROUTE: string
export const REFERENCE_INSERT_ROUTE: string
export const REFERENCE_EXPORT_ROUTE: string
export const REFERENCE_IMPORT_ROUTE: string
export const REFERENCE_DELIVERIES_ROUTE: string
export const REFERENCE_DELIVERY_ACK_ROUTE: string
export const REFERENCE_DELIVERY_REMOVE_ROUTE: string
export const REFERENCE_ASSET_ROUTE: string
export const REFERENCE_STATUS_ROUTE: string
export const PREVIEW_ROUTE: string
export const PREVIEW_SESSIONS_ROUTE: string
export const BRIDGE_STATUS_ROUTE: string
export const GUEST_ROUTE: string
export const RUNTIME_STATUS_ROUTE: string
export const RUNTIME_PROVISION_ROUTE: string
export const SHORTCUTS_ROUTE: string
export const SHORTCUT_ADD_ROUTE: string
export const SHORTCUT_REMOVE_ROUTE: string
