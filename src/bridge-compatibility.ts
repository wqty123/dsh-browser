export const BRIDGE_VERSION_MESSAGE = '桥接版本过旧，请点击 卸载并重装'
export const BRIDGE_PACKAGE_MESSAGE = '浏览器桥接不可用，请点击 卸载并重装'

export class BridgeVersionError extends Error {
  readonly code = 'BROWSER_BRIDGE_VERSION_MISMATCH'
  constructor(message = BRIDGE_VERSION_MESSAGE) {
    super(message)
    this.name = 'BridgeVersionError'
  }
}

export function bridgePackageError(value: unknown): BridgeVersionError | undefined {
  const fields = typeof value === 'object' && value !== null
    ? ['code', 'name', 'message', 'error', 'reason', 'note'].map(key => (value as Record<string, unknown>)[key])
    : [value]
  return fields.some(field => typeof field === 'string' && /(?:^|[^A-Z0-9_])DSH_BRIDGE_PACKAGE_UNAVAILABLE(?:$|[^A-Z0-9_])/.test(field))
    ? new BridgeVersionError(BRIDGE_PACKAGE_MESSAGE) : undefined
}

export function isBridgeVersionMismatch(answer: Record<string, unknown>): boolean {
  return (typeof answer.protocol === 'number' && answer.protocol < 4)
    || (typeof answer.code === 'string' && /(?:protocol|version)[-_]mismatch|unsupported[-_]protocol/i.test(answer.code))
    || (typeof answer.error === 'string' && /\b(?:protocol|bridge version)\b.*\b(?:mismatch|unsupported|incompatible|too old|required)\b/i.test(answer.error))
    || (typeof answer.error === 'string' && /\b(?:unsupported|incompatible)\s+protocol\b/i.test(answer.error))
}
