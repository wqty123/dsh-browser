/** Authenticated explicit maintenance protocol; older hosts cannot mistake it for direct install. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeAction } from './bridge-install.js';
import type { AutomaticMaintenanceJob } from './automatic-maintenance.js';
export declare const AUTOMATIC_MAINTENANCE_ROUTE = "/dsh-builtin-browser/bridge-maintenance";
export interface AutomaticMaintenanceRouteDeps {
    readonly supported: () => boolean;
    readonly read: () => AutomaticMaintenanceJob | undefined;
    readonly start: (action: BridgeAction, options?: {
        readonly locale?: 'zh' | 'en';
    }) => Promise<AutomaticMaintenanceJob>;
    /** Commit only after the accepted response has been flushed to the client. */
    readonly commit?: (id: string) => Promise<void>;
    /** True while the legacy bridge-action route is running an installer. */
    readonly busy?: () => boolean;
}
/** Register behind the host's signed-session authentication, as with settings writes. */
export declare function createAutomaticMaintenanceHandler(deps: AutomaticMaintenanceRouteDeps): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
