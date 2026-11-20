# Native sidebar children

Desktop childTabs protocol 2 admits an opener only after its canonical tab and native slot are attached. Main issues the child handle, request and lease. `setWindowOpenHandler` returns `action: 'allow'`; its `createWindow` adopts Electron's `options.webContents` with `new WebContentsView(options)` and returns that same WebContents. There is no BrowserWindow creation or URL replay.

`registerOwner`, `onCreated`, `adopt` and `onClosed` share the owning Session lifetime. Both events carry the full child record. Adoption requires the original renderer, the parent's live admission and the child-specific slot. Same-slot retries are idempotent; another slot, renderer or ended request cannot create a guest. Unadopted children close after ten seconds. Parent disposal, owner reload, guest destruction and slot revocation revoke children. Closing a child removes its reserved tab without navigating the opener. Named-target reuse remains Chromium-owned.

The plugin feature-detects protocol 2 and the optional reserved-tab controller method against unpatched host declarations. The host event is recorded before opening the reserved tab, so the page factory sees the main-owned child before rendering its occurrence. It subscribes before adoption, reuses the supplied lease and acknowledges initialization without `Page.navigate`. Initial blank documents can become ready without converting `about:blank` to an HTTP URL. Unsupported native-opener requests report `BROWSER_NATIVE_CHILD_UNAVAILABLE`; explicit URL-only requests remain separate.

Revision 4 runtime specs retain compressed revision-3 specs and revision-1/2 specs. Upgrade validates the complete previous output against original backups before writing any selected bundle. Restore retains the pre-bootstrap bytes; unrelated edits refuse upgrade. Source patches are supplied for rc.3, rc.5 and main.

## Reproduction

Run the ordinary Node behavior suite with `TSX_TSCONFIG_PATH=<dsh-source>/tsconfig.base.json node tests/run.mjs`. Source Vitest cases need source aliases rather than published `lib` exports because the plugin lives outside the DSH tsconfig root:

```sh
DSH_SOURCE_ROOT=<dsh-source> node <dsh-source>/node_modules/vitest/vitest.mjs run --config tools/native-child-vitest.config.mjs
DSH_SOURCE_ROOT=<dsh-source> NATIVE_CHILD_EVIDENCE=<existing-directory> xvfb-run -a <dsh-source>/apps/desktop/node_modules/electron/dist/electron --no-sandbox tools/fixtures/native-child-acceptance.cjs
node tools/check-host-patch-source.mjs <release-build-artifacts>
```

The Electron fixture imports emitted production `DesktopNativeViews` and `DesktopBrowserGuests`. It tests same-origin scripting, cross-origin messaging and isolation, immediate scripts, named targets, form POST bodies, close/closed, unregistered/foreign/replayed/expired requests, Session disposal and one BrowserWindow. It does not validate shipped-shell visual layout or packaged Windows behavior.

Full client-entry typechecking against unpatched SDK declarations has 328 baseline diagnostics and 327 after this change, with no new diagnostics after normalizing worktree paths and line numbers. The removed diagnostic is `navigateTabIn`; the remaining baseline errors are not claimed fixed. Host plugin typechecking passes separately.
