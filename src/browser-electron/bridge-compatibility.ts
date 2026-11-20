export const BRIDGE_VERSION_MESSAGE = '桥接版本过旧，请点击 卸载并重装'

export class BridgeVersionError extends Error {
  readonly code = 'BROWSER_BRIDGE_VERSION_MISMATCH'
  constructor() {
    super(BRIDGE_VERSION_MESSAGE)
    this.name = 'BridgeVersionError'
  }
}

export function isBridgeVersionMismatch(answer: Record<string, unknown>): boolean {
  return (typeof answer.protocol === 'number' && answer.protocol < 4)
    || (typeof answer.code === 'string' && /(?:protocol|version)[-_]mismatch|unsupported[-_]protocol/i.test(answer.code))
    || (typeof answer.error === 'string' && /\b(?:protocol|bridge version)\b.*\b(?:mismatch|unsupported|incompatible|too old|required)\b/i.test(answer.error))
    || (typeof answer.error === 'string' && /\b(?:unsupported|incompatible)\s+protocol\b/i.test(answer.error))
}
