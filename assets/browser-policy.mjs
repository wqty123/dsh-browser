export const BROWSER_PROFILE_DIR = 'dsh-builtin-browser-host'
export const LOOPBACK_IPV4 = '127.0.0.1'
export const URL_PARSE_BASE = 'http://localhost'
export const SETTINGS_ROUTE = '/dsh-builtin-browser/settings'
export const EXTENSION_INSTALL_ROUTE = '/dsh-builtin-browser/extension/install'
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
export const CDP_DEFAULT_ATTACH_PORT = 9222
export const CDP_ATTACH_PROBE_TIMEOUT_MS = 600
export const EXTENSION_READY_TIMEOUT_MS = 2500
export const EXTENSION_PROBE_TIMEOUT_MS = 1500
export const NATIVE_REGISTRATION_TIMEOUT_MS = 60_000
export const NATIVE_REGISTRATION_MAX_BUFFER = 1024 * 1024
export const extensionPageUrl = browser => `${browser}://extensions`
export const cdpVersionUrl = port => `http://${LOOPBACK_IPV4}:${port}/json/version`
export const folderOpener = platform => platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
export const REFERENCE_LIST_ROUTE = '/dsh-builtin-browser/reference/list'
export const REFERENCE_GET_ROUTE = '/dsh-builtin-browser/reference/get'
export const CLIENT_VERSION_ROUTE = '/dsh-builtin-browser/client-version'
export const REFERENCE_CAPTURE_ROUTE = '/dsh-builtin-browser/reference/capture'
export const REFERENCE_REVEAL_ROUTE = '/dsh-builtin-browser/reference/reveal'
export const REFERENCE_INSERT_ROUTE = '/dsh-builtin-browser/reference/insert'
export const REFERENCE_EXPORT_ROUTE = '/dsh-builtin-browser/reference/export'
export const REFERENCE_IMPORT_ROUTE = '/dsh-builtin-browser/reference/import'
export const REFERENCE_DELIVERIES_ROUTE = '/dsh-builtin-browser/reference/deliveries'
export const REFERENCE_DELIVERY_ACK_ROUTE = '/dsh-builtin-browser/reference/delivery/ack'
export const REFERENCE_DELIVERY_REMOVE_ROUTE = '/dsh-builtin-browser/reference/delivery/remove'
export const REFERENCE_ASSET_ROUTE = '/dsh-builtin-browser/reference/asset'
export const REFERENCE_STATUS_ROUTE = '/dsh-builtin-browser/reference/status'
export const PREVIEW_ROUTE = '/dsh-builtin-browser/browser-view/frame'
export const PREVIEW_SESSIONS_ROUTE = '/dsh-builtin-browser/browser-view/sessions'
export const BRIDGE_STATUS_ROUTE = '/dsh-builtin-browser/bridge-status'
export const GUEST_ROUTE = '/dsh-builtin-browser/browser-view/isolated-guest'
export const RUNTIME_STATUS_ROUTE = '/dsh-builtin-browser/runtime-status'
export const RUNTIME_PROVISION_ROUTE = '/dsh-builtin-browser/runtime-provision'
export const SHORTCUTS_ROUTE = '/dsh-builtin-browser/shortcuts'
export const SHORTCUT_ADD_ROUTE = '/dsh-builtin-browser/shortcuts/add'
export const SHORTCUT_REMOVE_ROUTE = '/dsh-builtin-browser/shortcuts/remove'
