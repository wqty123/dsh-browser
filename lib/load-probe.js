/**
 * TEMPORARY diagnostic: record that a loader row's `apply` actually ran.
 *
 * The desktop profile links this package, lists it in `dsh.profile.bundles`, its bundle patch
 * is read, its five peers resolve, and `require` succeeds for every entry — yet the client
 * module scan reports 70 modules and this plugin is not among them, with no error anywhere.
 * Those facts admit three different causes that need three different fixes, and nothing
 * observable from outside distinguishes them:
 *
 *   - no line at all        → the rows never reached the loader (bundle resolution)
 *   - root only             → a subpath entry failed to load
 *   - all four              → the rows loaded and the client-module scan is what drops it
 *
 * Remove this file and its four call sites once the desktop load path is understood. It is
 * instrumentation, not behaviour, and it must never be the reason something fails to load.
 * @module dsh-builtin-browser/load-probe
 */
import { appendFileSync } from 'node:fs';
/**
 * Append one line saying which row applied.
 * @param row - the row's name, as `cordis.patch.yml` spells it.
 */
export function probeLoad(row) {
    try {
        appendFileSync('D:/dsh-home/logs/plugin-load-probe.log', `${new Date().toISOString()}  ${row}  pid=${process.pid}\n`);
    }
    catch {
        // Diagnostics must never be the reason a load fails.
    }
}
