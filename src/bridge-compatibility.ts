export const BRIDGE_VERSION_MESSAGE = '桥接版本过旧，请点击 卸载并重装'
export const BRIDGE_PACKAGE_MESSAGE = '浏览器桥接不可用，请点击 卸载并重装'
export const NATIVE_SURFACE_MESSAGE = '浏览器桥接不可用（原生侧栏未就绪），请打开 Desktop 浏览器侧栏后重试'

export class BridgeVersionError extends Error {
  readonly code = 'BROWSER_BRIDGE_VERSION_MISMATCH'
  constructor(message = BRIDGE_VERSION_MESSAGE) {
    super(message)
    this.name = 'BridgeVersionError'
  }
}

export class NativeSurfaceUnavailableError extends Error {
  readonly code = 'BROWSER_NATIVE_SURFACE_UNAVAILABLE'
  constructor() {
    super(NATIVE_SURFACE_MESSAGE)
    this.name = 'NativeSurfaceUnavailableError'
  }
}

export function bridgePackageError(value: unknown): BridgeVersionError | NativeSurfaceUnavailableError | undefined {
  const fields = typeof value === 'object' && value !== null
    ? ['code', 'name', 'message', 'error', 'reason', 'note'].map(key => (value as Record<string, unknown>)[key])
    : [value]
  const hasCode = (code: string): boolean => fields.some(field => typeof field === 'string'
    && new RegExp(`(?:^|[^A-Z0-9_])${code}(?:$|[^A-Z0-9_])`).test(field))
  if (hasCode('BROWSER_BRIDGE_OUTDATED')) return new BridgeVersionError()
  if (hasCode('DSH_BRIDGE_PACKAGE_UNAVAILABLE')) return new BridgeVersionError(BRIDGE_PACKAGE_MESSAGE)
  if (hasCode('BROWSER_NATIVE_SURFACE_UNAVAILABLE')) return new NativeSurfaceUnavailableError()
  return undefined
}

export function isBridgeVersionMismatch(answer: Record<string, unknown>): boolean {
  return (typeof answer.protocol === 'number' && answer.protocol < 4)
    || answer.code === 'BROWSER_BRIDGE_OUTDATED'
    || (typeof answer.code === 'string' && /(?:protocol|version)[-_]mismatch|unsupported[-_]protocol/i.test(answer.code))
    || (typeof answer.error === 'string' && /\b(?:protocol|bridge version)\b.*\b(?:mismatch|unsupported|incompatible|too old|required)\b/i.test(answer.error))
    || (typeof answer.error === 'string' && /\b(?:unsupported|incompatible)\s+protocol\b/i.test(answer.error))
}
