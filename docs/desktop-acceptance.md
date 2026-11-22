# Desktop acceptance CLI

Run `node tools/accept-desktop.mjs` from the package checkout or installed package after restarting DSH Desktop. Set `DSH_ACCEPT_SESSION` and `DSH_ACCEPT_OTHER_SESSION` to **two different existing conversation IDs** (`session-…`). The script opens and closes test pages in both conversations, so use disposable conversations and do not interact with them during the run.

The endpoint is read from `DSH_BRIDGE_ENDPOINT`, or from `DSH_HOME/dsh-builtin-browser-bridge.json` (default `~/.dsh`). Protocol 3 is required: distinct logical views must have independent guests. The checker verifies loaded-build freshness, page creation, reuse, isolation, input-channel reachability, and closing one page without destroying another. It returns nonzero with `[diag]` state on failure. It does not fetch DSH routes from a guest: native guest isolation deliberately blocks those requests.

Only page IDs created during the run are eligible for cleanup; preexisting pages are protected. A failure that creates unexpected extra pages can leave them behind for inspection. No standalone window or fallback carrier is launched by this tool.

`npx --no dsh-browser-install-electron` remains an explicit repair command for the installed Electron runtime dependency. It invokes that dependency's own installer, honors `ELECTRON_SKIP_BINARY_DOWNLOAD`, and preserves download errors and exit status. There is no plugin install-time lifecycle hook and this command does not enable a standalone sidebar fallback.
