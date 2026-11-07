/**
 * A cancelled/failed quit never reaches the installer. After a confirmed exit, reopen Desktop even
 * when maintenance fails, and retain that failure instead of reporting a successful installation.
 */
export async function runMaintenanceLifecycle(action, deps) {
    let closed = false;
    let restarted = false;
    let pid;
    let outcome;
    let publicationFailure;
    const publish = async (phase, extra = {}) => {
        const state = { phase, action, at: new Date().toISOString(), ...extra };
        try {
            await deps.publish(state);
        }
        catch (error) {
            // Arming must be durable before any quit is requested. Later status I/O must never
            // prevent reopening a Desktop that already exited normally.
            if (phase === 'armed')
                throw error;
            publicationFailure ??= error;
        }
        return state;
    };
    await publish('armed');
    try {
        await deps.requestQuit();
        await publish('closing');
        await deps.waitUntilClosed();
        closed = true;
    }
    catch (error) {
        return await publish('cancelled', { ok: false, restarted: false, error: String(error) });
    }
    let failure;
    try {
        await publish('installing');
        outcome = await deps.maintain();
        if (!outcome.ok)
            throw new Error(outcome.output || 'bridge maintenance failed');
    }
    catch (error) {
        failure = error;
    }
    try {
        // `closed` is set only by the successful closed-process barrier, never by a timeout.
        if (!closed)
            throw new Error('Desktop exit was not confirmed');
        await publish('restarting');
        pid = await deps.restart();
        if (!Number.isSafeInteger(pid) || pid <= 0)
            throw new Error('Desktop restart did not return a valid process');
        restarted = true;
        await publish('verifying', { pid, restarted });
        await deps.verify(pid, failure === undefined ? action : 'uninstall');
    }
    catch (error) {
        failure = failure === undefined ? error : new Error(`${String(failure)}; Desktop recovery: ${String(error)}`);
    }
    if (failure === undefined && publicationFailure !== undefined) {
        failure = new Error(`Desktop maintenance finished, but progress could not be saved: ${String(publicationFailure)}`);
    }
    const details = { restarted, ...pid === undefined ? {} : { pid }, ...outcome?.output ? { output: outcome.output } : {} };
    return failure === undefined
        ? await publish('completed', { ...details, ok: true })
        : await publish('failed', { ...details, ok: false, error: String(failure) });
}
