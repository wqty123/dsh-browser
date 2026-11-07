/** Explicit bridge maintenance lifecycle, independent of the Desktop-owned HTTP request. */
import type { BridgeAction, BridgeActionResult } from './bridge-install.js';
export type MaintenancePhase = 'armed' | 'closing' | 'installing' | 'restarting' | 'verifying' | 'completed' | 'cancelled' | 'failed';
export interface MaintenanceState {
    readonly phase: MaintenancePhase;
    readonly action: BridgeAction;
    readonly at: string;
    readonly ok?: boolean;
    readonly restarted?: boolean;
    readonly pid?: number;
    readonly error?: string;
    readonly output?: string;
}
/** Effects are supplied by the independent worker; tests cannot close or start an application. */
export interface MaintenanceLifecycleDeps {
    /** Invoke the verified Desktop's own Quit menu item. Never confirm active-task dialogs. */
    readonly requestQuit: () => Promise<void>;
    /** Resolve only once every GUI/helper process belonging to this installation has exited. */
    readonly waitUntilClosed: () => Promise<void>;
    /** The existing installer retains its own identity, ancestry and running-process checks. */
    readonly maintain: () => Promise<BridgeActionResult>;
    /** Reopen exactly the verified installation after it has exited. */
    readonly restart: () => Promise<number>;
    /** Installation verifies the new authenticated bridge; uninstall verifies the process. */
    readonly verify: (pid: number, action: BridgeAction) => Promise<void>;
    readonly publish: (state: MaintenanceState) => Promise<void>;
}
/**
 * A cancelled/failed quit never reaches the installer. After a confirmed exit, reopen Desktop even
 * when maintenance fails, and retain that failure instead of reporting a successful installation.
 */
export declare function runMaintenanceLifecycle(action: BridgeAction, deps: MaintenanceLifecycleDeps): Promise<MaintenanceState>;
