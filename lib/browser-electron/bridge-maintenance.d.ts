import type { BridgeAction } from './bridge-install.js';
export interface BridgeMaintenanceOptions {
    /** Parent of a new, unique maintenance directory; defaults to the user's DSH home. */
    readonly directory?: string;
    /** Explicit Node executable; a verified Desktop executable may be used in Electron Node mode. */
    readonly nodePath?: string;
}
export interface PreparedBridgeMaintenance {
    readonly ok: true;
    readonly prepared: true;
    readonly action: BridgeAction;
    readonly path: string;
    /** Literal-path invocation for the user's PowerShell terminal. */
    readonly command: string;
    readonly commandShell: 'powershell';
    readonly directory: string;
    readonly runnerPath: string;
    readonly planPath: string;
}
/**
 * Prepare an offline Windows launcher. The target may still be running during preparation.
 * User execution remains subject to the installer's closed-Desktop and ancestry guards.
 */
export declare function prepareBridgeMaintenance(action: BridgeAction, installRoot: string, options?: BridgeMaintenanceOptions): Promise<PreparedBridgeMaintenance>;
