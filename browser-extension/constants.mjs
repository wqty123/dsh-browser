export const nativeHostName = browser => `com.dsh.browser.${browser}`
export const MAX_FRAME = 256 * 1024
export const MAX_MESSAGE = 8 * 1024 * 1024
export const CHUNK_BYTES = 48 * 1024
export const MAX_IN_FLIGHT = 32
export const MAX_ID_LENGTH = 128
export const MAX_CHUNKS = 256
export const MAX_PEERS = 8
export const AUTH_TIMEOUT_MS = 5000
export const HOST_OPERATION_TIMEOUT_MS = 15000
export const CLIENT_OPERATION_TIMEOUT_MS = 20000
export const LEGACY_PAIR_TTL_MS = 5 * 60 * 1000
export const RECONNECT_ALARM = 'native-reconnect'
export const RECONNECT_DELAY_MINUTES = 1
export const MAX_ERROR_LENGTH = 1024
export const NATIVE_FILES = Object.freeze({ config: 'config.json', relay: 'relay.json' })
export const EXTENSION_LIMITS = Object.freeze({ scopeLength: 4096, eventBytes: 32 * 1024, notices: 16, dialogPreview: 256, screenshotWidth: 1280, screenshotHeight: 960 })
