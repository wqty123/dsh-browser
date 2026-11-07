/**
 * Bound an await with a timeout, without dictating the caller's error wording.
 *
 * The two hosts phrase their timeout errors differently and those strings reach the panel, so
 * the shared primitive takes a factory instead of a message.
 * @module dsh-browser/browser-electron/timing
 */
export function withTimeoutShared(promise, ms, timedOut) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(timedOut()); }, ms);
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}
