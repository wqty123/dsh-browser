# Native sidebar children

Desktop childTabs protocol 2 admits an opener only after its canonical tab and native slot are attached. Main issues the child handle, request and lease. `setWindowOpenHandler` returns `action: 'allow'`; its `createWindow` adopts Electron's `options.webContents` with `new WebContentsView(options)` and returns that same WebContents. There is no BrowserWindow creation or URL replay.

`registerOwner`, `onCreated`, `adopt` and `onClosed` share the owning Session lifetime. Both events carry the full child record. Adoption requires the original renderer, the parent's live admission and the child-specific slot. Same-slot retries are idempotent; another slot, renderer or ended request cannot create a guest. Unadopted children close after ten seconds. Parent disposal, owner reload, guest destruction and slot revocation revoke children. Closing a child removes its reserved tab without navigating the opener. Named-target reuse remains Chromium-owned.

The plugin feature-detects protocol 2 and the optional reserved-tab controller method against unpatched host declarations. The host event is recorded before opening the reserved tab, so the page factory sees the main-owned child before rendering its occurrence. It subscribes before adoption, reuses the supplied lease and acknowledges initialization without `Page.navigate`. Initial blank documents can become ready without converting `about:blank` to an HTTP URL. Unsupported native-opener requests report `BROWSER_NATIVE_CHILD_UNAVAILABLE`; explicit URL-only requests remain separate.

Revision 6 includes native children and opt-in persistent Sidebar storage, including session-cookie checkpoints restored before guest loading, retaining compressed revision-3/4/5 specs and revision-1/2 specs. Upgrade validates the complete previous output against original backups before writing any selected bundle. Restore retains the pre-bootstrap bytes; unrelated edits refuse upgrade. Source patches are supplied for rc.3, rc.5 and main.

## Persistent Sidebar sessions

The guest and native-view APIs advertise optional `persistentSession: true`. The plugin requests persistence only when advertised; older hosts retain their workspace-scoped memory partitions. Main derives one persistent partition from the resolved `DSH_HOME`, never from a workspace or renderer-supplied storage identity. All workspaces in that home share cookies and web storage across restarts; different homes remain isolated. Existing memory-only sessions have no durable data to migrate. No plugin storage keys, user IDs or provider hooks change.

Revision 6 retains session cookies without adding expiry dates. Main checkpoints only the Sidebar partition's session cookies at `<DSH_HOME>/dsh-builtin-browser-host/desktop-session-cookies.json` (0600, directory 0700, Windows owner ACL), after every cookie change and before completing normal quit. Serialized atomic replacement leaves the previous complete checkpoint intact on an interrupted write; it does not promise power-loss durability or recovery beyond the last completed checkpoint. Restore completes before native-view creation or webview reservation is returned, preserves host-only/domain, Secure, HttpOnly, SameSite and quoted-value scope, and never overwrites a persistent cookie with a stale session snapshot. Invalid entries are skipped individually; corrupt/unreadable input starts empty and triggers a best-effort sanitized rewrite, not a page failure. Unsupported attributes are not weakened. Host cookie mutations, script commands and scoped fetches await reconciliation; quit stops admission, drains checkpoints, flushes Chromium and disposes listeners. Persistent cookies remain Chromium-owned. The merged Web proxy has its own per-home JSON jar, now retaining session cookies too; it does not initialize or replace Desktop Chromium storage, and there is no cross-carrier cookie migration.

Run `DSH_SOURCE_ROOT=<dsh-source> PERSISTENCE_EVIDENCE=<directory> node tools/check-sidebar-persistence.mjs` for real Electron launches under xvfb. The fixture checks expiring and HttpOnly session cookies on the first request, session/Secure/host-only/domain/SameSite scope, localStorage, tab close/reopen, cross-workspace sharing, different-home isolation, stale persistent replacement, expiry/deletion, native clear-site-data, HTTP Clear-Site-Data, and SIGKILL recovery after a completed checkpoint. It uses the emitted production partition policy, `webviewTag: false` and one BrowserWindow. It does not qualify real Windows ACL execution or packaged Desktop layout.

## Reproduction

Run the ordinary Node behavior suite with `TSX_TSCONFIG_PATH=<dsh-source>/tsconfig.base.json node tests/run.mjs`. Source Vitest cases need source aliases rather than published `lib` exports because the plugin lives outside the DSH tsconfig root:

```sh
DSH_SOURCE_ROOT=<dsh-source> node <dsh-source>/node_modules/vitest/vitest.mjs run --config tools/native-child-vitest.config.mjs
DSH_SOURCE_ROOT=<dsh-source> NATIVE_CHILD_EVIDENCE=<existing-directory> xvfb-run -a <dsh-source>/apps/desktop/node_modules/electron/dist/electron --no-sandbox tools/fixtures/native-child-acceptance.cjs
node tools/check-host-patch-source.mjs <release-build-artifacts>
```

The Electron fixture imports emitted production `DesktopNativeViews` and `DesktopBrowserGuests`. It tests same-origin scripting, cross-origin messaging and isolation, immediate scripts, named targets, form POST bodies, close/closed, unregistered/foreign/replayed/expired requests, Session disposal and one BrowserWindow. It does not validate shipped-shell visual layout or packaged Windows behavior.

Full client-entry typechecking against unpatched SDK declarations has 328 baseline diagnostics and 327 after this change, with no new diagnostics after normalizing worktree paths and line numbers. The removed diagnostic is `navigateTabIn`; the remaining baseline errors are not claimed fixed. Host plugin typechecking passes separately.
