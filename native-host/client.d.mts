export interface ExtensionConnectionStatus {
  state: 'extension-missing' | 'not-paired' | 'not-connected' | 'connected' | 'disabled'
  connected: boolean
  browser: 'edge' | 'chrome'
  profile?: string
  connectionId?: string
  epoch?: string
  detail: string
}
export class NativeBrowserClient {
  constructor(directory: string, browser: 'edge' | 'chrome')
  status(): ExtensionConnectionStatus
  connect(): Promise<void>
  request(operation: Record<string, unknown>): Promise<unknown>
  onEvent(listener: (event: { method: string; lease?: string; params?: Record<string, unknown> }) => void): () => void
  dispose(): void
}
