/**
 * Ambient declaration for the `electron` module used by the self-hosted
 * browser host (`host-main.ts`). The electron package is an optional peer
 * dependency (present in desktop-shell environments), so it is not in
 * devDependencies; this shim keeps typechecking self-contained.
 * @module dsh-browser/types/electron-shim
 */

declare module 'electron' {
  export interface WebContentsDebugger {
    attach(version: string): void
    detach(): void
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  }
  export interface DownloadItem {
    setSavePath(path: string): void
  }
  export interface Cookie {
    domain: string
    path: string
    secure: boolean
    httpOnly: boolean
    name: string
    value: string
    expirationDate?: number
  }
  export interface CookieSetter {
    url: string
    name: string
    value: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    expirationDate?: number
  }
  export interface Session {
    once(event: 'will-download', listener: (event: Event, item: DownloadItem) => void): void
    readonly cookies: {
      get(filter: Record<string, unknown>): Promise<Cookie[]>
      set(details: CookieSetter): Promise<void>
    }
  }
  export interface NativeImage {
    toPNG(): Buffer
    toJPEG(quality: number): Buffer
    getSize(): { width: number; height: number }
    resize(options: { width?: number; height?: number }): NativeImage
  }
  export interface WebContents {
    readonly id: number
    readonly debugger: WebContentsDebugger
    readonly session: Session
    close(): void
    downloadURL(url: string): void
    capturePage(): Promise<NativeImage>
    loadURL(url: string): Promise<void>
    loadFile(path: string): Promise<void>
    send(channel: string, payload: unknown): void
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' } | { action: 'allow' }): void
    getTitle(): string
    getURL(): string
    on(event: 'ipc-message', listener: (event: unknown, channel: string, ...args: unknown[]) => void): this
    on(event: 'page-title-updated' | 'did-navigate' | 'did-navigate-in-page' | 'dom-ready', listener: (event: unknown, ...args: unknown[]) => void): this
  }
  export interface WebContentsView {
    readonly webContents: WebContents
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void
    setVisible(visible: boolean): void
    getVisible(): boolean
    getBounds(): { x: number; y: number; width: number; height: number }
  }
  export interface BrowserWindow {
    readonly contentView: {
      addChildView(view: WebContentsView): void
      removeChildView(view: WebContentsView): void
      readonly children: WebContentsView[]
    }
    getContentSize(): [number, number]
    isVisible(): boolean
    isMinimized(): boolean
    isFocused(): boolean
    show(): void
    restore(): void
    focus(): void
    moveTop(): void
    close(): void
    setTitle(title: string): void
    on(event: 'closed', listener: () => void): this
    on(event: 'resize', listener: () => void): this
    off(event: 'closed', listener: () => void): this
    off(event: 'resize', listener: () => void): this
  }
  export const app: {
    whenReady(): Promise<void>
    exit(code?: number): void
    getPath(name: string): string
    setPath(name: string, path: string): void
  }
  export interface BrowserWindowConstructor {
    new(options?: Record<string, unknown>): BrowserWindow
  }
  export interface WebContentsViewConstructor {
    new(options?: Record<string, unknown>): WebContentsView
  }
  export const BrowserWindow: BrowserWindowConstructor
  export const WebContentsView: WebContentsViewConstructor
}
