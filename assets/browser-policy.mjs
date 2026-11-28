export const BROWSER_PROFILE_DIR = 'dsh-builtin-browser-host'
export const LOOPBACK_IPV4 = '127.0.0.1'
export const URL_PARSE_BASE = 'http://localhost'
export const SETTINGS_ROUTE = '/dsh-builtin-browser/settings'
export const EXTENSION_INSTALL_ROUTE = '/dsh-builtin-browser/extension/install'
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
export const CDP_DEFAULT_ATTACH_PORT = 9222
export const CDP_ATTACH_PROBE_TIMEOUT_MS = 600
/** Budget for one control exchange with a carrier: a bridge call or a CDP command. */
export const CARRIER_CALL_TIMEOUT_MS = 30_000
/** A carrier call that moves a file (download) gets the longer budget. */
export const CARRIER_DOWNLOAD_TIMEOUT_MS = 60_000
/** A cheap carrier probe (listing views) does not need the full call budget. */
export const CARRIER_PROBE_TIMEOUT_MS = 5_000
/** Budget for one maintenance child process (bridge install, profile command). */
export const MAINTENANCE_PROCESS_TIMEOUT_MS = 30_000
/** How long maintenance waits for Desktop to exit. */
export const MAINTENANCE_QUIT_WAIT_MS = 60_000
/** A maintenance plan older than this is refused instead of executed. */
export const MAINTENANCE_PLAN_MAX_AGE_MS = 30_000
/** How long a finished maintenance result is reused instead of re-inspected. */
export const MAINTENANCE_RESULT_CACHE_MS = 5 * 60_000
/** Budget for one Electron profile command. */
export const PROFILE_COMMAND_TIMEOUT_MS = 60_000
export const EXTENSION_READY_TIMEOUT_MS = 2500
export const EXTENSION_PROBE_TIMEOUT_MS = 1500
export const NATIVE_REGISTRATION_TIMEOUT_MS = 60_000
export const NATIVE_REGISTRATION_MAX_BUFFER = 1024 * 1024
export const TOOL_DEFAULT_TIMEOUT_MS = 60_000
export const TOOL_WAIT_RESERVE_MS = 5_000
export const TOOL_WAIT_MIN_MS = 250
export const MAX_FILL_FIELDS = 200
export const CODE_TOOL_DEFAULT_TIMEOUT_MS = 120_000
export const CODE_TOOL_MAX_TIMEOUT_MS = 600_000
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
/** Sidebar/host handshake routes; declared here so host and client cannot drift apart. */
export const OPEN_REQUEST_ROUTE = '/dsh-builtin-browser/browser/open-request'
export const SURFACE_DECL_ROUTE = '/dsh-builtin-browser/browser/declare-surface'
export const BRIDGE_ACTION_ROUTE = '/dsh-builtin-browser/bridge-action'
export const HOST_PATCH_ROUTE = '/dsh-builtin-browser/host-patch-maintenance'
export const AUTOMATIC_MAINTENANCE_ROUTE = '/dsh-builtin-browser/bridge-maintenance'
export const TAKEOVER_ROUTE = '/dsh-builtin-browser/browser/takeover'
export const WEB_SOURCE_ROUTE = '/dsh-builtin-browser/reference/source'
// `allow-same-origin` is not a convenience here: DSH 0.2.3's Host admission rejects any request that
// carries `Origin: null`, and a sandboxed opaque-origin document sends exactly that on every
// subresource (image, stylesheet, script). Measured on 0.2.3-alpha.2: the host answers 403 to
// `GET /` with `Origin: null`, and with an opaque guest every image and stylesheet of a real page
// came back 403, so pages rendered without formatting or images. Granting the guest this origin is
// what lets those subrequests through. The consequence is that a browsed page shares this
// application's origin and must be treated as trusted; `docs/limitations.md` states it, and the
// long-term fix is a Host-side exemption for this route so the guest can stay opaque.
export const WEB_BROWSER_SANDBOX = 'allow-scripts allow-forms allow-same-origin'
export const RELAXED_BROWSER_SANDBOX = `${WEB_BROWSER_SANDBOX} allow-downloads allow-modals allow-pointer-lock allow-orientation-lock allow-presentation allow-storage-access-by-user-activation`
export const RUNTIME_STATUS_ROUTE = '/dsh-builtin-browser/runtime-status'
export const RUNTIME_PROVISION_ROUTE = '/dsh-builtin-browser/runtime-provision'
export const SHORTCUTS_ROUTE = '/dsh-builtin-browser/shortcuts'
export const SHORTCUT_ADD_ROUTE = '/dsh-builtin-browser/shortcuts/add'
export const SHORTCUT_REMOVE_ROUTE = '/dsh-builtin-browser/shortcuts/remove'
