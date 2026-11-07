export interface MaintenanceBrokerOptions {
    readonly runtimePath: string;
    readonly args: readonly string[];
    readonly cwd: string;
    /** Overrides for the explicitly inherited environment; undefined removes a variable. */
    readonly environment?: Readonly<Record<string, string | undefined>>;
}
export interface MaintenanceBrokerExecution {
    readonly windowsHide: true;
    readonly shell: false;
    readonly encoding: 'utf8';
    readonly timeout: number;
    readonly maxBuffer: number;
    readonly env: NodeJS.ProcessEnv;
}
export type MaintenanceBrokerExecutor = (file: string, args: readonly string[], options: MaintenanceBrokerExecution) => Promise<{
    readonly stdout: string;
    readonly stderr: string;
}>;
export interface MaintenanceBrokerDeps {
    /** Tests supply a fake executor; the real broker is prohibited inside the test runner. */
    readonly execFile?: MaintenanceBrokerExecutor;
    readonly platform?: NodeJS.Platform;
}
export interface MaintenanceBrokerResult {
    readonly pid: number;
}
/** Quote one argument using the Windows C runtime's command-line decoding rules. */
export declare function quoteWin32Argument(value: string): string;
/**
 * Create a hidden, independent local process. No shell evaluates runtime paths or arguments.
 * WMI receives an explicit environment copied from this process, including any plan overrides;
 * it therefore does not accidentally inherit the provider service's unrelated environment.
 */
export declare function launchMaintenanceBroker(options: MaintenanceBrokerOptions, deps?: MaintenanceBrokerDeps): Promise<MaintenanceBrokerResult>;
