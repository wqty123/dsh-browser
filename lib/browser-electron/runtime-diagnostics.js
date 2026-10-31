/**
 * Startup diagnostics only: an explicit runtime remains the user's choice.
 * Keep this pure so availability checks never spawn Electron or download it.
 */
export function electronRuntimeDiagnosticLines(versions, stamp = new Date().toISOString()) {
    const electron = versions.electron?.trim() || 'unknown';
    const lines = [
        `${stamp} runtime: electron=${electron} chromium=${versions.chrome?.trim() || 'unknown'} node=${versions.node?.trim() || 'unknown'}`,
    ];
    const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(electron);
    const continuing = 'continuing with the selected runtime. Update its installation, or change/remove ELECTRON_PATH if that override selects it.';
    if (parsed === null || Number(parsed[1]) !== 44) {
        // Other maintained branches can be patched for the advisory below. An
        // untested major is a compatibility warning, not a vulnerability claim.
        lines.push(`${stamp} warning: Electron ${electron} is not verified for this plugin; expected stable Electron 44.x >=44.9.1; ${continuing}`);
        return lines;
    }
    const minor = Number(parsed[2]);
    const patch = Number(parsed[3]);
    const prerelease = parsed[4] !== undefined;
    // A prerelease of 44.9.1 sorts before the patched stable release.
    if (minor < 9 || (minor === 9 && (patch < 1 || (patch === 1 && prerelease)))) {
        lines.push(`${stamp} warning: Electron ${electron} is below the 44.x security minimum 44.9.1 (GHSA-jr5w-w6x2-84p9); ${continuing}`);
    }
    else if (prerelease) {
        lines.push(`${stamp} warning: Electron ${electron} is a prerelease and is not verified for this plugin; expected stable Electron 44.x >=44.9.1; ${continuing}`);
    }
    return lines;
}
