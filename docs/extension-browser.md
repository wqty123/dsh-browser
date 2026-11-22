# Browser extension and automatic CDP fallback

The plugin needs no token pairing or manual native-host configuration. On startup it registers the Edge and Chrome native hosts asynchronously for the current OS user. Registration results appear in `nativeHostRegistration` in runtime status, even in sidebar/plugin modes; failures are also shown in Settings and never prevent plugin loading.

## Modes

- Defaults are unchanged. `systemProfile: plugin` uses DSH's separate, persistent managed browser profile.
- With channel `edge` or `chrome`, `systemProfile: user` means **prefer my browser if available**. The first operation of each new browser session waits at most 2.5 seconds for the extension. Otherwise it uses managed CDP with a **DSH-owned profile**, never personal-profile CDP.
- A live CDP session stays on CDP, including its additional tabs. If the extension connects later, the next new session can use it. Status reports the most recently selected carrier, controlled profile and fallback reason. The fallback is still the plugin profile even if the personal browser has different logins.
- Cleanup retains PID/creation/executable/exact-profile verification. Extension cleanup only detaches; only explicit close can close an agent-owned tab. Personal tabs/windows are never closed by cleanup.

## Optional extension

Click **一键安装扩展 / Install extension** in Settings, next to the bridge reinstall button. Web and Desktop use the same authenticated, same-origin POST route: `/dsh-builtin-browser/extension/install`.

The button registers both native hosts immediately. If already connected, it reports **已连接** without opening anything. Otherwise it opens the chosen browser's extensions page and reveals the bundled folder in Explorer/Finder (or the Linux file manager): **点「加载解压缩的扩展」并选择已打开的文件夹**. Enable Developer mode if the browser requires it. Browser policies may prohibit unpacked extensions; CDP fallback still works. Loading an extension cannot legitimately be silently bypassed by a plugin. No terminal commands, copied IDs, tokens or configuration are needed.

The fixed manifest public key gives ID **`ljobhenplklfnkbmhamljjnpgalgcjgc`** independent of folder location. Only a public key is shipped. `assets/browser-extension-identity.mjs` exports the shared ID and the currently empty `EXTENSION_STORE_URL`; setting the latter makes the button open the store instead of the extensions page/folder.

The worker connects at installation, startup and boot, with reconnect alarms. Options is status + Disconnect only. Options Disconnect pauses reconnection without closing tabs; remove and add the extension again to clear that pause. Canceling the debugging infobar invalidates the affected tab lease and reports detachment, without automatically reattaching it. A new explicit acquisition is required. Native-host `--revoke` persists a disabled flag; automatic registration never clears it.

## Debugger ownership and lifecycle

One controller serializes requests and holds at most one physical debugger attachment. Switching between tasks detaches the previous tab before attaching the requested tab; logical leases remain valid and resume on their next request. Screenshots and takeover use this same owner, not additional debugger clients. Suspended tabs do not receive debugger dialog/file-chooser interception until resumed.

After 30 seconds without a completed request, a browser alarm detaches the debugger while retaining logical leases. The named policy is `DEBUGGER_IDLE_TIMEOUT_MS` in `browser-extension/constants.mjs`. Session/task cleanup awaits scoped detach through both the direct and preferred carriers. Native/plugin transport disconnect releases every lease and detaches the physical debugger; cleanup never closes personal or agent tabs.

Leases, agent-tab ownership and the active tab are stored in `chrome.storage.session`. On worker restart, `chrome.debugger.getTargets()` reconciles surviving attachments: a still-live recorded attachment is reused, expired/unrecorded owned attachments are detached, and foreign debuggers are left alone. Ownership of an attached target is checked with a debugger command, because `getTargets().attached` alone does not identify the attaching extension. No tab is attached automatically during reconciliation.

This bounds this extension's attachments, not Edge's warning UI. Chromium groups warnings by extension ID rather than simply showing one per attached tab; Edge-specific behavior and duplicate installations require separate diagnosis. Do not treat these lifecycle guarantees as proof that the reported two-warning issue is resolved.

## Native host and security

State lives at `DSH_HOME/dsh-builtin-browser-host/extension/<browser>` (default `~/.dsh`). Windows uses HKCU; macOS/Linux use per-user NativeMessagingHosts locations. Windows hardening writes and verifies only the DACL, not owner or SACL. Registration remains fail-closed on ACL errors.

Identical launchers are not rebuilt or overwritten while running. Windows launchers are source-versioned; changed versions are compiled to a temporary file and published atomically, then the manifest is swapped. A running older executable is never unlinked or killed. Old versions may remain in the private host directory.

For the bundled ID, the browser-enforced native-host `allowed_origins` plus the exact native caller origin replace pairing. Any profile where the bundled extension is enabled may connect; it is no longer pinned to a manually paired profile. Untrusted origins and disabled configurations are rejected. The plugin-to-host channel retains mutual challenge authentication, fresh epochs, authentication/request timeouts, bounded framing/chunks and no command replay. This does not protect against malware already executing as the same OS user. Legacy explicitly configured custom IDs retain their old token flow; automatic setup always migrates to the bundled ID.

## Quiet mode and acceptance

DSH agent operations do not activate tabs/windows or move the OS mouse. Tabs are inactive; screenshots and input use `chrome.debugger` CDP. Opener-scoped popups, JS dialogs and permissions are contained where browser APIs permit. Debugging infobars, downloads and browser/site-owned UI remain exceptions. The explicit install button deliberately opens only the requested browser page and folder, outside an agent quiet-mode run.

On Windows test as a normal, non-admin user: install/start DSH with Edge open; verify both HKCU manifests use the fixed ID, then click the button and load the folder. Verify automatic connection without Options/token entry. Click again and require **已连接**, no opened page/folder. Restart while Edge's native launcher is running; require successful idempotent registration. Check extension snapshot/input/background screenshot/reference/takeover, then disconnect and start a new session: require `resolvedCarrier: cdp`, `controlledProfile: plugin`, and a fallback reason. Reconnect and start another session: require extension/user, with the older CDP session unchanged. Revoke and restart: disabled must persist. Throughout cleanup, original personal browser processes/windows/tabs must survive; measure foreground window and cursor before/after agent work (excluding the install button) and require no changes.
