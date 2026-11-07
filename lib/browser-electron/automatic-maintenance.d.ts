import { type MaintenanceBrokerOptions, type MaintenanceBrokerResult } from './maintenance-broker.js';
import { type MaintenanceState } from './maintenance-lifecycle.js';
import { type BridgeAction } from './bridge-install.js';
export interface AutomaticMaintenanceJob extends MaintenanceState {
    readonly id: string;
    readonly workerPid?: number;
    readonly startedAt?: string;
}
export interface AutomaticMaintenanceOptions {
    readonly locale?: 'zh' | 'en';
}
export interface MaintenanceProgressOptions {
    readonly jobId: string;
    readonly directory: string;
    readonly locale?: 'zh' | 'en';
}
export interface MaintenanceProgressNotification {
    readonly started: boolean;
    readonly at: string;
    readonly pid?: number;
    readonly error?: string;
    readonly skipped?: boolean;
}
export interface MaintenanceProgressDeps {
    readonly launch?: (options: MaintenanceBrokerOptions) => Promise<MaintenanceBrokerResult>;
    readonly helperExists?: (path: string) => boolean;
    readonly powershellPath?: () => string;
}
/** Data-only argv for the independent, read-only progress window. This function starts nothing. */
export declare function maintenanceProgressLaunchOptions(jobId: string, directory: string, locale?: 'zh' | 'en', powershellPath?: string): MaintenanceBrokerOptions;
/**
 * Attempt the optional window once per job, after commit and before requesting normal Desktop quit.
 * A missing helper, denied broker or diagnostic write cannot change the maintenance outcome.
 */
export declare function startMaintenanceProgressNotification(options: MaintenanceProgressOptions, deps?: MaintenanceProgressDeps): Promise<MaintenanceProgressNotification>;
/** Last durable outcome survives both the settings page and the HTTP host restarting. */
export declare function readAutomaticMaintenance(home?: string): AutomaticMaintenanceJob | undefined;
/** Commit only the armed job after its accepted HTTP response has finished writing. */
export declare function commitAutomaticMaintenance(jobId: string, home?: string): Promise<void>;
/** Only the new, authenticated explicit-click endpoint calls this function. */
export declare function startAutomaticMaintenance(action: BridgeAction, root: string, options?: AutomaticMaintenanceOptions): Promise<AutomaticMaintenanceJob>;
