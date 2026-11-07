/** PowerShell's `-EncodedCommand` expects a UTF-16LE script encoded as base64. */
export declare function encodePowerShellScript(script: string): string;
export declare function windowsPowerShellPath(environment?: NodeJS.ProcessEnv, exists?: (path: string) => boolean): string;
