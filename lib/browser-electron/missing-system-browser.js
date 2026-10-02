/**
 * How each product is named in the message, and what to install.
 *
 * Only chrome and edge can appear: the constructor's type excludes `bundled` and `auto`,
 * and `BrowserChannel` has no `brave`. A brave entry here would be unreachable code.
 */
const PRODUCT = {
    chrome: {
        label: 'Google Chrome',
        install: 'install Google Chrome',
        variable: 'DSH_BROWSER_CHROME_PATH',
    },
    edge: {
        label: 'Microsoft Edge',
        install: 'install Microsoft Edge',
        variable: 'DSH_BROWSER_EDGE_PATH',
    },
};
/** How the setting is named to the user. */
const SETTING_LABEL = {
    chrome: '本机 Chrome / installed Chrome',
    edge: '本机 Edge / installed Edge',
    auto: '自动 / automatic',
    bundled: '内置 / bundled',
};
/**
 * A carrier that cannot carry anything: every command explains the real problem.
 *
 * The message is written to be acted on, not just read: it says which browser was
 * requested, where the plugin looked, and the three concrete ways to resolve it.
 */
export class MissingSystemBrowserHost {
    kind;
    searched;
    /**
     * @param kind - the browser the user asked for.
     * @param searched - the names and locations that were checked, for the report.
     */
    constructor(kind, searched) {
        this.kind = kind;
        this.searched = searched;
    }
    /** @returns always true: see the module comment — reporting false would hide this. */
    available() {
        return true;
    }
    /**
     * The message every command fails with.
     * @returns a multi-line explanation with the fixes.
     */
    explain() {
        const product = PRODUCT[this.kind] ?? { label: this.kind, install: `install ${this.kind}`, variable: 'DSH_BROWSER_<KIND>_PATH' };
        const searched = this.searched.length > 0 ? this.searched.join(', ') : 'PATH and the usual install locations';
        return [
            `dsh-builtin-browser: the browser you selected is not installed — no ${product.label} was found.`,
            ``,
            `  Setting:  browser carrier = "${SETTING_LABEL[this.kind] ?? this.kind}"`,
            `  Looked for: ${searched}`,
            ``,
            `Nothing else is wrong: the plugin falls back to its own bundled browser only when the`,
            `setting is "bundled" or "automatic". Because this one names a browser explicitly, it`,
            `reports the missing browser instead of silently using a different one.`,
            ``,
            `To fix it, any ONE of these is enough:`,
            `  1. ${product.install}, then restart DSH;`,
            `  2. point ${product.variable} at its executable;`,
            `  3. set the browser carrier back to "内置 / bundled" (or "自动 / automatic" to let it`,
            `     fall back on its own next time).`,
        ].join('\n');
    }
    /**
     * Create a handle whose every command fails with the explanation.
     * @returns a handle that never reaches a page.
     */
    createView() {
        const message = this.explain();
        return {
            id: `missing-${this.kind}`,
            sendCommand: async () => { throw new Error(message); },
        };
    }
    /**
     * Accept a handle for destruction. Nothing was created, so nothing is released.
     * @param handle - the handle returned by {@link createView}.
     */
    destroyView(handle) {
        void handle;
    }
}
