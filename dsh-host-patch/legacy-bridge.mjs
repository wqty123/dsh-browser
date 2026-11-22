export const legacyBridgeMarker = '// dsh-builtin-browser: hand the plugin a way to drive the sidebar'
export const legacyBridgeSnippet = `
${legacyBridgeMarker} pages.
// The plugin runs inside the Node-mode host, where there is no Electron API, so the
// shell is the only process that can own a view. Exposing the existing webview
// guests (and their CDP) is what lets the agent work on the page the human is
// looking at, instead of spawning a second, parallel browser window.
// Installed by apps/desktop/bridge/install.mjs — re-run it after a desktop upgrade.
// A bridge failure is never fatal to the shell.
app.whenReady().then(async () => {
	const bridgeUrl = new URL("./plugin-browser-bridge.js", import.meta.url);
	const loadBridge = async (why) => {
		try {
			// A plain import is cached for the process lifetime, so an edited bridge
			// would need a shell restart. The stamp makes every load read the current
			// bytes; start() itself stops the previous instance, so this reloads in place.
			const bridge = await import(bridgeUrl.href + "?v=" + Date.now());
			bridge.start({ reload: why === "file changed" });
			console.log("[dsh-browser-bridge] started" + (why ? " (" + why + ")" : ""));
		} catch (error) {
			console.error("[dsh-browser-bridge] start failed:", error);
		}
	};
	await loadBridge();
	// Watch the module so an edit reloads it in place instead of forcing a shell
	// restart. Debounced; a failure here is never fatal to the shell.
	try {
		const { watch } = await import("node:fs");
		let timer = null;
		watch(bridgeUrl, { persistent: false }, () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => void loadBridge("file changed"), 300);
		});
	} catch (error) {
		console.error("[dsh-browser-bridge] watch failed:", error);
	}
});
`

export const legacyBridgeSnippets = [
  legacyBridgeSnippet,
  legacyBridgeSnippet.replace('bridge.start({ reload: why === "file changed" });', 'bridge.start();'),
]

export function stripLegacyBridge(text) {
  for (const snippet of legacyBridgeSnippets) {
    const at = text.indexOf(snippet)
    if (at !== -1 && text.indexOf(snippet, at + 1) === -1) {
      return text.slice(0, at) + text.slice(at + snippet.length)
    }
  }
  return undefined
}
