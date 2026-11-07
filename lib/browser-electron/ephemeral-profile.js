/**
 * The ephemeral browser profile: a throwaway directory under the DSH home, used when the
 * user has turned profile persistence off, and deleted when the browser is released.
 *
 * Deleting on release is not enough by itself. A process killed outright — a DSH restart
 * that ends in SIGKILL, "End task" in a task manager, a crashed host — never runs its
 * cleanup, so the profile it was using survives on disk: the user asked for no profile to
 * be kept and the machine keeps one anyway, holding cookies and history. Nothing can run
 * at SIGKILL time, so the cleanup has to happen on the NEXT run instead, which is what
 * this module provides.
 *
 * Ownership is a marker file inside the directory naming the process that claimed it. A
 * directory whose owner is gone AND whose whole tree has not been written to for a while is
 * abandoned. The age check is what keeps the sweep away from a profile an orphaned browser
 * (a child that outlived the parent which was killed) may still be using: a live Chromium
 * writes nested files continuously, so a tree with a recent write is not abandoned — even
 * when the root directory's own timestamp is old, because writing a file does not update it.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive } from './process.js';
/** The marker file, named once because both the claim and the sweep read it. */
const OWNER_FILE = '.dsh-ephemeral-owner';
/**
 * How long a profile is left alone regardless of ownership. An orphaned browser keeps
 * writing to its profile, so this is what distinguishes "abandoned" from "in use by a
 * process this one did not start".
 */
const ABANDONED_AFTER_MS = 60 * 60 * 1000;
/**
 * Ceiling on how much of a profile tree one sweep inspects. A tree we cannot fully inspect is
 * not proven abandoned, so it is kept; this only bounds the cost of saying so.
 */
const MAX_SWEEP_ENTRIES = 20_000;
/**
 * The directory name an ephemeral profile for `kind` gets, before it is claimed.
 *
 * The sweep matches on the same shape, so the two must agree: a name built anywhere else
 * is a directory the sweep will never find.
 * @param kind - the detected browser product (`chrome`, `edge`, ...).
 * @param id - a per-run unique suffix.
 * @returns the directory NAME, not a path.
 */
export function ephemeralProfileName(kind, id) {
    return `${kind}-profile-ephemeral-${id}`;
}
/**
 * Mark an ephemeral profile directory as this process's, so a later run can tell whether
 * the process that created it is still there.
 * @param dir - the profile directory (created if it does not exist yet).
 * @param pid - the claiming process, defaulting to this one.
 * @param now - the claim time, defaulting to the current clock.
 * @returns true when the marker was written.
 */
export function claimEphemeralProfile(dir, pid = process.pid, now = Date.now()) {
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, OWNER_FILE), JSON.stringify({ pid, at: now }));
        return true;
    }
    catch {
        // The browser creates the directory itself when this fails, and cleanup is best
        // effort throughout: a marker that could not be written must not stop the launch.
        return false;
    }
}
/**
 * The claimed owner of an ephemeral profile, when it has one.
 * @param dir - the profile directory.
 * @returns the owner pid, or undefined when there is no readable marker.
 */
function readOwner(dir) {
    try {
        const parsed = JSON.parse(readFileSync(join(dir, OWNER_FILE), 'utf8'));
        return typeof parsed.pid === 'number' ? parsed.pid : undefined;
    }
    catch {
        // No marker: a run from before this existed, or one killed before it wrote one. The
        // age check has already applied, and a directory with no claimant that old is
        // abandoned by any reading.
        return undefined;
    }
}
/**
 * The most recent write anywhere in a profile tree.
 *
 * A Chromium process writes nested files (`Default/Network/Cookies`, `Default/History`, ...).
 * Writing a file does NOT refresh the mtime of the parent directory, so a quiet ROOT timestamp
 * cannot prove the browser has exited — exactly the case where a killed DSH leaves a live child
 * behind. Inspect the tree instead of just its root.
 *
 * Anything that cannot be inspected is reported as "written now", so the caller keeps the
 * directory. When the evidence is incomplete, leaving a profile behind is the only safe outcome.
 * Symbolic links are never followed, and an entry budget bounds the work.
 * @param dir - the profile directory.
 * @param now - the clock value used as the conservative "active" answer.
 * @returns the newest mtime in the tree, or `-Infinity` when the tree holds nothing but our marker.
 */
function latestWriteMs(dir, now) {
    let latest = Number.NEGATIVE_INFINITY;
    let budget = MAX_SWEEP_ENTRIES;
    const pending = [dir];
    while (pending.length > 0) {
        const current = pending.pop();
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        }
        catch {
            return now;
        }
        for (const entry of entries) {
            if (budget-- <= 0)
                return now;
            // Our owner marker is written once at claim time; it is not browser activity.
            if (current === dir && entry.name === OWNER_FILE)
                continue;
            const path = join(current, entry.name);
            let stat;
            try {
                stat = lstatSync(path);
            }
            catch {
                return now;
            }
            if (stat.mtimeMs > latest)
                latest = stat.mtimeMs;
            if (stat.isDirectory() && !stat.isSymbolicLink())
                pending.push(path);
        }
    }
    return latest;
}
/**
 * Delete the ephemeral profiles under `root` that belong to processes which are gone.
 *
 * Called before a new one is claimed, because that is the only moment that can still act
 * on a profile whose owner was killed: nothing runs when the signal lands.
 * @param root - the plugin's profile root (`<DSH_HOME>/dsh-builtin-browser-host`).
 * @param kind - the browser product, which selects the directory-name prefix.
 * @param options - test seams for the clock and the liveness test.
 * @returns the names of the directories that were removed.
 */
export function sweepAbandonedEphemeralProfiles(root, kind, options = {}) {
    const now = options.now ?? Date.now();
    const alive = options.alive ?? pidAlive;
    const prefix = `${kind}-profile-ephemeral-`;
    const removed = [];
    let names;
    try {
        names = readdirSync(root);
    }
    catch {
        // No profile root yet: nothing has ever been written here, so nothing to sweep.
        return removed;
    }
    for (const name of names) {
        if (!name.startsWith(prefix))
            continue;
        const dir = join(root, name);
        let rootMtime;
        try {
            rootMtime = statSync(dir).mtimeMs;
        }
        catch {
            continue;
        }
        // Recent writes ANYWHERE in the tree mean a browser is still working in there. A killed DSH
        // can leave its Chromium child running, and a child writing Default/Network/Cookies does not
        // refresh the root directory's mtime. Judging the root alone deleted live profiles.
        const ageMs = now - Math.max(rootMtime, latestWriteMs(dir, now));
        if (ageMs < ABANDONED_AFTER_MS)
            continue;
        const owner = readOwner(dir);
        if (owner !== undefined && alive(owner))
            continue;
        try {
            rmSync(dir, { recursive: true, force: true });
            removed.push(name);
        }
        catch {
            // In use, or not ours to remove. Leaving it is the safe outcome and the next run
            // tries again — the alternative is deleting a profile out from under a live browser.
        }
    }
    return removed;
}
