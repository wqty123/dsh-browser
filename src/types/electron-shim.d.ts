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
  export interface Session {
    once(event: 'will-download', listener: (event: Event, item: DownloadItem) => void): void
  }
  export interface WebContents {
    readonly id: number
    readonly debugger: WebContentsDebugger
    readonly session: Session
    close(): void
    downloadURL(url: string): void
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
    on(event: 'closed', listener: () => void): this
    on(event: 'resize', listener: () => void): this
    off(event: 'closed', listener: () => void): this
    off(event: 'resize', listener: () => void): this
  }
  export const app: {
    whenReady(): Promise<void>
    exit(code?: number): void
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
