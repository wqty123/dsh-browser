/** Versions reported by the running child, never inferred from an npm package or path. */
interface RuntimeVersions {
    readonly electron?: string;
    readonly chrome?: string;
    readonly node?: string;
}
/**
 * Startup diagnostics only: an explicit runtime remains the user's choice.
 * Keep this pure so availability checks never spawn Electron or download it.
 */
export declare function electronRuntimeDiagnosticLines(versions: RuntimeVersions, stamp?: string): string[];
export {};
