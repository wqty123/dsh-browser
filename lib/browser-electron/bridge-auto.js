/**
 * Compatibility for historical automatic-install settings and explicit bridge-maintenance intent.
 * Runtime automatic installation is disabled. Bridge maintenance requires the user to close DSH
 * Desktop before explicitly running the installer; loading a plugin never changes the installation.
 * Historical marker readers remain available for diagnostics.
 * @module dsh-browser/browser-electron/bridge-auto
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from './settings-store.js';
/** Historical attempt-record interval, retained for compatibility with existing diagnostics. */
export const AUTO_INSTALL_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
/**
 * Report that runtime bridge installation is deferred to explicit maintenance.
 *
 * @param input - the readings described by {@link AutoInstallInput}.
 * @returns whether to run, and why.
 */
export function autoInstallDecision(_input) {
    return { run: false, why: 'runtime automatic bridge installation is disabled; close DSH Desktop and run bridge maintenance explicitly' };
}
/**
 * Read the profile identity supplied by DSH's launcher before plugins mount.
 * A Desktop installation or Electron executable can also belong to a Web/CLI invocation,
 * so neither is used to infer the current surface.
 * @param ctx - plugin context; older or custom compositions may omit the profile service.
 * @returns the current profile name, or undefined when the launcher did not provide it.
 */
export function readAutoInstallProfile(ctx) {
    try {
        const context = ctx;
        if (typeof context?.get !== 'function')
            return undefined;
        const profile = context.get('profileContext');
        return typeof profile?.name === 'string' ? profile.name : undefined;
    }
    catch {
        return undefined;
    }
}
/** A manual uninstall could not record the operator's automatic-install opt-out. */
export class BridgeAutoInstallPreferenceError extends Error {
    constructor(cause) {
        super(`could not save automatic bridge installation preference: ${String(cause)}`, { cause });
        this.name = 'BridgeAutoInstallPreferenceError';
    }
}
/**
 * Preserve an explicit uninstall as an automatic-install opt-out in historical settings.
 * The preference is written before the installer starts, so a failed write cannot launch maintenance.
 * A failed uninstall retains the opt-out; an explicit install leaves an existing opt-out unchanged.
 * @param action - the authenticated user's selected action.
 * @param update - persist the operator's bridge preference.
 * @param run - perform the installer action after its preference is durable.
 * @returns the installer's result.
 */
export async function runWithManualBridgePreference(action, update, run) {
    if (action === 'uninstall') {
        try {
            update({ bridge: { autoInstall: false } });
        }
        catch (error) {
            throw new BridgeAutoInstallPreferenceError(error);
        }
    }
    return await run();
}
/** Where the attempt record lives, beside the settings the plugin already owns. */
export function autoInstallMarkerPath(dshHome) {
    return join(dshHome, 'dsh-builtin-browser-host', 'bridge-auto-install.json');
}
/**
 * Read the last attempt.
 *
 * A record that cannot be parsed is treated as absent: the guard exists to prevent loops, and a single
 * extra attempt after a corrupt file is cheaper than refusing to ever install again.
 * @param path - marker file path.
 * @returns the marker, or undefined.
 */
export function readAutoInstallMarker(path) {
    if (!existsSync(path))
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof parsed.build !== 'string' || typeof parsed.attemptedAt !== 'string')
            return undefined;
        return {
            build: parsed.build,
            attemptedAt: parsed.attemptedAt,
            outcome: typeof parsed.outcome === 'string' ? parsed.outcome : 'unknown',
        };
    }
    catch {
        return undefined;
    }
}
/**
 * Record an attempt. Written before the installer runs: if the shell is killed mid-install, the next
 * launch must still see that an attempt happened rather than starting another restart.
 * @param path - marker file path.
 * @param marker - what to record.
 * @returns whether the record was saved; callers skip automatic restarts without a durable guard.
 */
export function writeAutoInstallMarker(path, marker) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileAtomic(path, `${JSON.stringify(marker, null, 2)}\n`);
        return true;
    }
    catch {
        return false;
    }
}
