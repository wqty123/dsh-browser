import { detectBrowser } from './system-browser.js';
/** Which carrier a channel names. */
function carrierOf(channel) {
    if (channel === 'sidebar')
        return 'sidebar';
    if (channel === 'bundled')
        return 'bundled';
    if (channel === 'auto')
        return 'auto';
    return 'system';
}
/** Whether a binary being present settles the Electron question. */
function electronReady(state) {
    return state === 'present' || state === 'ready';
}
/**
 * Assemble the report.
 *
 * The `readiness` field is per carrier on purpose: "the browser is ready" is not a property of this
 * plugin, it is a property of the carrier the user chose. A bundled carrier with a finished download
 * is ready; the sidebar carrier with no bridge is not, however healthy the bundled runtime is.
 * @param deps - the readers; every one of them is a cheap, side-effect-free read.
 * @returns the report the panel renders.
 */
export function readRuntimeStatus(deps) {
    const channel = deps.channel();
    const carrier = carrierOf(channel);
    // The binary check comes first and wins: a runtime that is on disk is ready whatever the
    // provisioning state machine last said, which is also how a runtime installed by hand (or by an
    // earlier process) is reported correctly without a restart. The DETAIL has to follow the same
    // rule, or the panel shows "present" next to "the runtime has not been asked for yet" — measured
    // on a live install, and the kind of contradiction a reader cannot resolve.
    const snapshot = deps.provision();
    const runnable = deps.hasBinary();
    const missingAfterReady = !runnable && (snapshot.state === 'present' || snapshot.state === 'ready');
    const state = runnable ? 'present' : missingAfterReady ? 'failed' : snapshot.state;
    const electron = {
        state,
        detail: runnable ? 'an Electron runtime is already available'
            : missingAfterReady ? 'the previously prepared Electron runtime is missing; prepare it again' : snapshot.detail,
        at: runnable ? new Date().toISOString() : snapshot.at,
    };
    const bridgeStatus = deps.bridge();
    const endpoint = deps.endpoint();
    const bridge = bridgeStatus === undefined
        ? {
            present: false,
            state: 'absent',
            detail: 'no DSH Desktop install was found on this machine',
            running: endpoint?.alive === true,
            runningDetail: endpoint?.detail ?? 'no desktop shell has published a bridge endpoint',
        }
        : {
            present: bridgeStatus.present,
            state: bridgeStatus.state,
            detail: bridgeStatus.detail,
            running: endpoint?.alive === true,
            runningDetail: endpoint?.detail ?? 'no desktop shell has published a bridge endpoint',
            ...bridgeStatus.command === undefined ? {} : { command: bridgeStatus.command },
        };
    // The sidebar needs BOTH halves: our patch inside the shell it will be driven through, and that
    // shell actually running. Either one alone is the false green this report exists to prevent.
    const sidebarReady = bridge.state === 'installed' && bridge.running;
    const checkSystemBrowser = carrier === 'system' || carrier === 'auto';
    const detected = checkSystemBrowser ? (deps.detectBrowser ?? detectBrowser)(channel) : undefined;
    const systemBrowser = {
        checked: checkSystemBrowser,
        present: detected !== undefined,
        ...detected === undefined ? {} : { kind: detected.kind, path: detected.path },
        detail: detected !== undefined ? `${detected.kind} is available at ${detected.path}`
            : !checkSystemBrowser ? `the ${carrier} channel uses its own carrier`
                : channel === 'auto' ? 'no Chrome, Edge or Brave installation was found'
                    : `the selected ${channel} installation was not found`,
    };
    let readiness;
    let resolvedCarrier;
    if (carrier === 'sidebar') {
        resolvedCarrier = 'sidebar';
        readiness = sidebarReady ? 'ready' : 'blocked';
    }
    else if (carrier === 'bundled') {
        resolvedCarrier = 'bundled';
        readiness = electronReady(state) ? 'ready' : 'blocked';
    }
    else if (carrier === 'auto') {
        // Discovery may adopt a live desktop bridge after initially choosing a system browser. Match
        // that priority here, then use the bundled runtime when no system browser was found.
        resolvedCarrier = deps.selectedCarrier?.() ?? (sidebarReady ? 'sidebar' : detected !== undefined ? 'system' : 'bundled');
        readiness = (resolvedCarrier === 'sidebar' ? sidebarReady : resolvedCarrier === 'system' ? detected !== undefined : electronReady(state)) ? 'ready' : 'blocked';
    }
    else {
        resolvedCarrier = 'system';
        readiness = detected !== undefined ? 'ready' : 'blocked';
    }
    return {
        channel,
        carrier,
        resolvedCarrier,
        readiness,
        systemBrowser,
        ...resolvedCarrier === 'system' && detected !== undefined ? { executable: detected.path } : {},
        electron,
        bridge,
        // Offering the button while a download runs would be a second download, which is the one thing
        // the shared attempt exists to prevent.
        canProvision: !electronReady(state) && state !== 'preparing',
    };
}
