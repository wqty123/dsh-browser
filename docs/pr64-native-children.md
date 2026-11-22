# Native sidebar children

Desktop childTabs protocol 2 admits an opener only after its canonical tab and native slot are attached. Main issues the child handle, request and lease. `setWindowOpenHandler` returns `action: 'allow'`; its `createWindow` adopts Electron's `options.webContents` with `new WebContentsView(options)` and returns that same WebContents. There is no BrowserWindow creation or URL replay.

`registerOwner`, `onCreated`, `adopt` and `onClosed` share the owning Session lifetime. Both events carry the full child record. Adoption requires the original renderer, the parent's live admission and the child-specific slot. Same-slot retries are idempotent; another slot, renderer or ended request cannot create a guest. Unadopted children close after ten seconds. Parent disposal, owner reload, guest destruction and slot revocation revoke children. Closing a child removes its reserved tab without navigating the opener. Named-target reuse remains Chromium-owned.

The plugin feature-detects protocol 2 and the optional reserved-tab controller method against unpatched host declarations. The host event is recorded before opening the reserved tab, so the page factory sees the main-owned child before rendering its occurrence. It subscribes before adoption, reuses the supplied lease and acknowledges initialization without `Page.navigate`. Initial blank documents can become ready without converting `about:blank` to an HTTP URL. Unsupported native-opener requests report `BROWSER_NATIVE_CHILD_UNAVAILABLE`; explicit URL-only requests remain separate.

Revision 8 includes native children and opt-in persistent Sidebar storage, including session-cookie checkpoints restored before guest loading, retaining compressed revision-3/4/5/6/7 specs and revision-1/2 specs. Upgrade validates the complete previous output against original backups before writing any selected bundle. Restore retains the pre-bootstrap bytes; unrelated edits refuse upgrade. Source patches are supplied for rc.3, rc.5 and main.

Each release ships its entire 17-commit `git format-patch base..source` history, losslessly compressed. `sources/series.json` pins the base, ordered patch list, source-build commit and complete resulting Git tree; `sources/manifest.json` records uncompressed lengths and SHA-256. Decompress and apply the complete listed series from its exact base, not the superseded piecemeal patch files. Revision-8 source commits are main `ecc1469ffe9edeeb19d1a88c0909a915593adba9`, rc.3 `948d49ac3f9e48e511b71ecbef446745e59e1d05`, and rc.5 `c8f8d79aacc07d2f54dda634ff2cc041d165bcf5`. Regenerate with `DSH_SOURCE_ROOT=<git-checkout> node tools/generate-host-patch-sources.mjs`; `node tests/run.mjs tests/host-patch-source-series.test.mjs` checks every shipped patch with `git apply --cached --check` and verifies all three final source-tree hashes without an external checkout.

## Persistent Sidebar sessions

The guest and native-view APIs advertise optional `persistentSession: true`. The plugin requests persistence only when advertised; older hosts retain their workspace-scoped memory partitions. Main derives one persistent partition from the resolved `DSH_HOME`, never from a workspace or renderer-supplied storage identity. All workspaces in that home share cookies and web storage across restarts; different homes remain isolated. Existing memory-only sessions have no durable data to migrate. No plugin storage keys, user IDs or provider hooks change.

Revision 8 retains session cookies without adding expiry dates. Main checkpoints only the Sidebar partition's session cookies at `<DSH_HOME>/dsh-builtin-browser-host/desktop-session-cookies.json` (0600, directory 0700, Windows owner ACL), after every cookie change and before completing normal quit. Serialized atomic replacement leaves the previous complete checkpoint intact on an interrupted write; it does not promise power-loss durability or recovery beyond the last completed checkpoint. One shared restore promise runs exactly once per partition, before native-view creation or webview reservation; direct persistent reservations are refused until it completes. Flush never restores, so logout cannot replay saved cookies. Invalid or Chromium-rejected entries are diagnosed and dropped independently while remaining entries continue. Checkpoint reads get three attempts with 25/50 ms backoff. Exhausted reads preserve the old checkpoint as `.bak` and complete restoration with a diagnostic; checkpointing then resumes from the live jar. If backup preservation itself fails, guests still proceed but writes wait for backup preservation to recover. Corrupt input is diagnosed and sanitized. Restore preserves host-only/domain, Secure, HttpOnly, SameSite and quoted-value scope, and never overwrites a persistent cookie with a stale session snapshot. Unsupported attributes are not weakened. Checkpoint failures are diagnostic-only for guest operations; failed permission setup is retried on a later flush. Host cookie mutations, script commands and scoped fetches await reconciliation; quit stops admission, drains checkpoints, flushes Chromium and disposes listeners. Persistent cookies remain Chromium-owned. The merged Web proxy has its own per-home JSON jar, retaining session cookies too; it does not initialize or replace Desktop Chromium storage, and there is no cross-carrier cookie migration.

Run `DSH_SOURCE_ROOT=<dsh-source> PERSISTENCE_EVIDENCE=<directory> node tools/check-sidebar-persistence.mjs` for real Electron launches under xvfb. The fixture checks expiring and HttpOnly session cookies on the first request, session/Secure/host-only/domain/SameSite scope, localStorage, tab close/reopen, cross-workspace sharing, different-home isolation, stale persistent replacement, expiry/deletion, native clear-site-data, HTTP Clear-Site-Data, and SIGKILL recovery after a completed checkpoint. It uses the emitted production partition policy, `webviewTag: false` and one BrowserWindow. It does not qualify real Windows ACL execution or packaged Desktop layout.

## Reproduction

Run the ordinary Node behavior suite with `TSX_TSCONFIG_PATH=<dsh-source>/tsconfig.base.json node tests/run.mjs`. Source Vitest cases need source aliases rather than published `lib` exports because the plugin lives outside the DSH tsconfig root:

The same Vitest configuration runs `packaged-native-open.spec.ts` against the actual `dist/client.cjs` and the compressed rc.3 sidebar bundle. Build the plugin first. Set `DSH_BROWSER_TEST_ARCHIVE=<plugin.tgz>` to exercise an archive's client instead. It covers installed Browser/ReferenceDock stylesheets, native document acknowledgement, repeated opens, independent reserved views, empty identities and failed acquisition/retry without a webview. The Electron boundary is simulated; this does not replace real Desktop acceptance.

For rc.3/rc.5 archives, compile the client with `DSH_SOURCE_ROOT=<supported-release-source> node --import tsx tools/build-supported-client.mts` after the host TypeScript build. The revision-9 rc.3 source commit is `65791d4dcf`. Use that release's build preset, not main's newer deferred `meta.stylesheets` format: rc.3 installs styles at factory execution and does not consume stylesheet metadata. The build command rejects a metadata-only preset, and the actual-bundle regression checks that factory loading installs both stylesheets. Then `pnpm --ignore-scripts pack --out <new-file.tgz>` preserves those validated artifacts while applying publish manifest transformations.

Revision 9 samples native slot geometry on animation frames until revocation. A transform-only sidebar opening does not trigger ResizeObserver; revision 8 could leave an acknowledged native document attached at zero width, also blocking CDP screenshots. The frame sampler publishes only changed placement and is cancelled on release. Revisions 2–8 upgrade using their exact original backups.

Real Electron acceptance at device scale 1.25:

```sh
DSH_SOURCE_ROOT=<DSH checkout with Electron and dependencies> \
DSH_RELEASE_SOURCE=<supported rc.3 source checkout> \
NATIVE_SLOT_HOST=<patched rc.3 desktop lib directory> \
DSH_BROWSER_TEST_ARCHIVE=<plugin.tgz> \
NATIVE_SLOT_EVIDENCE=<persistent output directory> \
node tools/check-native-slot.mjs
```

This loads the archive's plugin and the revision-9 rc.3 client fixture through their factories, executes the patched main/preload native APIs in Electron, opens through `dsh_browser_open`, and captures through `dsh_browser_screenshot`. It checks native visibility, attachment, topmost ordering, nonzero bounds matching the animated DOM slot, document acknowledgement, and zero webviews. `display.png` captures the compositor and its native page pixels; `tool.png` is the browser-tool result. `window.png` captures only the shell webContents, not its native child views. The surrounding Cordis shell is a fixture, not a complete installed Desktop. For a negative control set `NATIVE_SLOT_CLIENT` to the revision-8 client; setting `NATIVE_SLOT_STATIC=1` opens without animation and distinguishes stale placement from scale/attachment faults.

```sh
DSH_SOURCE_ROOT=<dsh-source> node <dsh-source>/node_modules/vitest/vitest.mjs run --config tools/native-child-vitest.config.mjs
DSH_SOURCE_ROOT=<dsh-source> NATIVE_CHILD_EVIDENCE=<existing-directory> xvfb-run -a <dsh-source>/apps/desktop/node_modules/electron/dist/electron --no-sandbox tools/fixtures/native-child-acceptance.cjs
node tools/check-host-patch-source.mjs <release-build-artifacts>
```

The Electron fixture imports emitted production `DesktopNativeViews` and `DesktopBrowserGuests`. It tests same-origin scripting, cross-origin messaging and isolation, immediate scripts, named targets, form POST bodies, close/closed, unregistered/foreign/replayed/expired requests, Session disposal and one BrowserWindow. It does not validate shipped-shell visual layout or packaged Windows behavior.

Full client-entry typechecking against unpatched SDK declarations has 328 baseline diagnostics and 327 after this change, with no new diagnostics after normalizing worktree paths and line numbers. The removed diagnostic is `navigateTabIn`; the remaining baseline errors are not claimed fixed. Host plugin typechecking passes separately.
