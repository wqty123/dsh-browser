/**
 * Plugin-owned settings document — the switches the browser settings panel
 * exposes, stored next to the browsing history so both follow the same rules:
 * they survive the browser process and DSH restarts.
 *
 * Every field is optional on disk and falls back to a default, so a hand-edited
 * or older file never breaks startup; an unreadable file is treated as "all
 * defaults" rather than an error.
 * @module dsh-browser/browser-electron/settings-store
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
/** Defaults for every switch: the documented out-of-the-box behaviour. */
export const DEFAULT_SETTINGS = {
    history: { enabled: true, maxEntries: 5_000, maxAgeDays: 90 },
    cookies: { persist: true },
    ui: { autoExpandOnce: true, closeWithSession: false, virtualCursor: true },
    vision: { strategy: 'auto' },
    // Bundled by default: it needs nothing installed, and on the desktop the carrier
    // is the sidebar anyway. Choosing a system browser is an explicit opt-in because
    // it starts a real Chrome/Edge with its own profile.
    browser: { channel: 'bundled' },
    credentials: { allowRead: true },
};
/**
 * Absolute path of the settings file, beside the browser profile and the
 * browsing history.
 * @returns the settings file path.
 */
export function settingsPath() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, 'dsh-builtin-browser-host', 'settings.json');
}
/** Coerce one boolean field, keeping the default when absent or mistyped. */
function bool(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
/**
 * Coerce the browser channel, keeping the default when it is not one of the
 * known choices. A hand-edited typo must not silently select a different browser.
 * @param value - the raw value from the settings document.
 * @returns a valid channel.
 */
function resolveChannel(value) {
    return value === 'chrome' || value === 'edge' || value === 'auto' || value === 'bundled'
        ? value
        : DEFAULT_SETTINGS.browser.channel;
}
/** Coerce one positive-integer field, keeping the default when invalid. */
function count(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
/** Read one nested section of an unknown document, or an empty object. */
function section(source, key) {
    const value = source[key];
    return typeof value === 'object' && value !== null ? value : {};
}
/**
 * Resolve a raw settings document (already parsed, shape unknown) into the full
 * document, field by field. Unknown keys are dropped: the file is not a place to
 * smuggle configuration.
 * @param raw - the parsed file contents.
 * @returns the resolved settings.
 */
export function resolveSettings(raw) {
    const source = typeof raw === 'object' && raw !== null ? raw : {};
    const history = section(source, 'history');
    const cookies = section(source, 'cookies');
    const ui = section(source, 'ui');
    const vision = section(source, 'vision');
    const credentials = section(source, 'credentials');
    const browser = section(source, 'browser');
    return {
        history: {
            enabled: bool(history.enabled, DEFAULT_SETTINGS.history.enabled),
            maxEntries: count(history.maxEntries, DEFAULT_SETTINGS.history.maxEntries),
            maxAgeDays: count(history.maxAgeDays, DEFAULT_SETTINGS.history.maxAgeDays),
        },
        cookies: { persist: bool(cookies.persist, DEFAULT_SETTINGS.cookies.persist) },
        ui: {
            autoExpandOnce: bool(ui.autoExpandOnce, DEFAULT_SETTINGS.ui.autoExpandOnce),
            closeWithSession: bool(ui.closeWithSession, DEFAULT_SETTINGS.ui.closeWithSession),
            virtualCursor: bool(ui.virtualCursor, DEFAULT_SETTINGS.ui.virtualCursor),
        },
        vision: { strategy: vision.strategy === 'nonVisual' ? 'nonVisual' : DEFAULT_SETTINGS.vision.strategy },
        browser: { channel: resolveChannel(browser.channel) },
        credentials: { allowRead: bool(credentials.allowRead, DEFAULT_SETTINGS.credentials.allowRead) },
    };
}
/**
 * File-backed settings with an in-memory snapshot. Reads re-stat the file so an
 * edit from another process (or the settings panel writing through a second
 * code path) is picked up without a restart; writes are atomic enough for a
 * single-writer plugin and never throw at the caller.
 */
export class SettingsStore {
    file;
    cached;
    /** Last observed mtime, used to invalidate the cache on external edits. */
    cachedMtimeMs = -1;
    /**
     * @param file - settings file path (defaults beside the browser profile).
     */
    constructor(file = settingsPath()) {
        this.file = file;
    }
    /** Path this store reads and writes. */
    path() {
        return this.file;
    }
    /**
     * Current settings, re-read when the file changed on disk.
     * @returns the resolved settings document.
     */
    get() {
        let mtimeMs = -1;
        try {
            // stat directly: existsSync costs about thirteen times what the stat does, and the
            // stat already throws when the file is missing — which the catch below handles.
            mtimeMs = statSync(this.file).mtimeMs;
        }
        catch {
            // Unreadable file: fall through to defaults below.
            mtimeMs = -1;
        }
        // Return the cache BEFORE reading. The read used to happen first "just in case", which
        // made the cache pointless: every call paid for a synchronous read of the whole file and
        // then discarded it. This is on the path of every tool call that consults a setting, so
        // it was a stat plus a read per call where a single stat will do.
        if (this.cached !== undefined && mtimeMs === this.cachedMtimeMs)
            return this.cached;
        let text;
        if (mtimeMs !== -1) {
            try {
                text = readFileSync(this.file, 'utf8');
            }
            catch {
                text = undefined;
                mtimeMs = -1;
            }
        }
        try {
            // A leading BOM is what ordinary Windows editors (Notepad, PowerShell's
            // `Set-Content -Encoding utf8`) leave behind, and `JSON.parse` rejects it.
            // Without this strip, hand-editing the settings file silently discarded every
            // value in it: the document looked correct, and the plugin quietly ran on
            // defaults — including switches the user had just turned off.
            const body = text?.replace(/^\uFEFF/, '');
            this.cached = body === undefined ? DEFAULT_SETTINGS : resolveSettings(JSON.parse(body));
        }
        catch {
            // Malformed JSON: behave as defaults rather than fail startup.
            this.cached = DEFAULT_SETTINGS;
        }
        this.cachedMtimeMs = mtimeMs;
        return this.cached;
    }
    /**
     * Merge a partial patch into the stored document and persist it.
     * @param patch - the fields to change (unknown keys are ignored).
     * @returns the settings after the merge.
     */
    update(patch) {
        const current = this.get();
        const merged = resolveSettings(deepMerge(current, patch));
        try {
            mkdirSync(dirname(this.file), { recursive: true });
            writeFileSync(this.file, `${JSON.stringify(merged, null, 2)}\n`);
        }
        catch (error) {
            // Do NOT publish the new value as cached, and do not pretend the file changed: a
            // reader compares the file's mtime against this stamp, so stamping "now" on a failed
            // write made the next get() re-read the file and silently revert the user's change.
            // Clear the cache before failing: the value on disk is still the old one, so leaving
            // the merged document cached would hand the next reader something that does not exist —
            // and the stamp would make it look fresh until the mtime comparison rolled it back.
            this.cached = undefined;
            this.cachedMtimeMs = -1;
            throw new Error(`dsh-builtin-browser: settings could not be saved: ${error instanceof Error ? error.message : String(error)}`);
        }
        return merged;
    }
}
/** One-level-deep merge over the settings sections (patch wins). */
function deepMerge(base, patch) {
    if (typeof patch !== 'object' || patch === null)
        return base;
    const result = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        const existing = result[key];
        if (typeof value === 'object' && value !== null && typeof existing === 'object' && existing !== null) {
            result[key] = { ...existing, ...value };
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
