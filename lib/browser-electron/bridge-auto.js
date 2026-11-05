/**
 * Install the desktop bridge by itself, once, so "install the plugin" is the whole setup.
 *
 * The bridge cannot be installed while the shell runs: Electron holds `app.asar`, and the installer's
 * `--restart` closes the app, patches, and starts it again. That is fine as an explicit user action and
 * alarming as a side effect of loading a plugin — so this module is mostly about the guard rails, not
 * the install:
 *
 * - only on the desktop end (no install directory, nothing to patch);
 * - never when it is already installed;
 * - **once per desktop build**: the attempt is recorded before it starts, so a failing install cannot
 *   turn every launch into a restart loop. A desktop update changes the build, which re-arms it;
 * - silent: the readiness section already reports `stale` / `installed`, and a restart drops the panel
 *   anyway. No new UI.
 *
 * The install itself stays `runBridgeAction` — the same code the panel's button runs.
 * @module dsh-browser/browser-electron/bridge-auto
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
/** A day is short enough to feel automatic and long enough that a broken install cannot loop. */
export const AUTO_INSTALL_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
/**
 * Decide whether this load should install the bridge.
 *
 * @param input - the readings described by {@link AutoInstallInput}.
 * @returns whether to run, and why.
 */
export function autoInstallDecision(input) {
    if (input.installRoot === undefined)
        return { run: false, why: 'no DSH Desktop install on this machine' };
    if (!input.enabled)
        return { run: false, why: 'automatic bridge installation is switched off' };
    const state = input.status.state;
    if (state === 'installed')
        return { run: false, why: 'the bridge is installed' };
    if (input.status.present === false)
        return { run: false, why: 'no bridge to repair: the app is not a DSH Desktop install' };
    const marker = input.marker;
    if (marker !== undefined) {
        const attempted = Date.parse(marker.attemptedAt);
        const sameBuild = marker.build === (input.status.version ?? 'unknown');
        const fresh = Number.isFinite(attempted) && input.now - attempted < input.cooldownMs;
        // A different build means the desktop app was updated, which is exactly when the bridge needs
        // installing again — so only the same build suppresses the attempt.
        if (sameBuild && fresh) {
            return { run: false, why: `already attempted for this build at ${marker.attemptedAt} (${marker.outcome})` };
        }
    }
    return { run: true, why: `bridge is ${state}; installing it once for this build` };
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
 * @returns nothing; failures are the caller's to log, and a failed write is not worth an exception.
 */
export function writeAutoInstallMarker(path, marker) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    }
    catch {
        // Losing the record costs one extra attempt, not correctness.
    }
}
