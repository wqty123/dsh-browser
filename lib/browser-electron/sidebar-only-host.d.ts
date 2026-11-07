import type { CarrierLossReason, CarrierPage } from '../browser/types.js';
import type { ElectronBrowserViewHost, ElectronViewHandle, PresentOptions } from './provider.js';
/**
 * Keep an explicit sidebar selection while its bridge starts or reconnects.
 * Discovery is deferred until a command needs the bridge; it never selects another carrier.
 */
export declare class SidebarOnlyHost implements ElectronBrowserViewHost {
    private readonly loader;
    private readonly views;
    private lease;
    private loading;
    private disposed;
    private lostListener;
    constructor(loader: () => Promise<ElectronBrowserViewHost>);
    /** Keep the explicit selection available so discovery failures reach the caller unchanged. */
    available(): boolean;
    /** Return a stable handle without opening a sidebar or discovering a bridge. */
    createView(owner?: string): ElectronViewHandle;
    destroyView(handle: ElectronViewHandle): void;
    /** Presentation must not turn the provider's initial show into a blank-page navigation. */
    showView(handle: ElectronViewHandle, label?: string, options?: PresentOptions): void;
    listPages(owner?: string): Promise<readonly CarrierPage[]>;
    closePage(id: string, owner?: string): Promise<void>;
    /** Retire only this conversation's handles before awaiting an in-flight discovery. */
    releasePage(owner?: string): Promise<void>;
    collapse(): Promise<void>;
    onLost(listener: (reason: CarrierLossReason) => void): void;
    dispose(): void;
    private assertOpen;
    private assertView;
    private assertLease;
    private load;
    private lost;
    private bind;
    private send;
}
