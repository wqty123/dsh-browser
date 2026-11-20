# PR #64: Native Sidebar views (#30)

## Host boundary

The optional `browser.nativeViews` v1 API creates main-owned sandboxed WebContentsViews with context isolation, no Node integration, web security and `webviewTag:false`. Canonical owner/session/tab addresses identify views but do not grant access: primary-frame IPC authentication, Session admission, a matching admitted Sidebar slot and current lease are all checked. Sidebar-right owns composition geometry, clipping, visibility/background placement and lifetime. Slots revoke on root disposal; native leases revoke on renderer reload/crash, guest crash/close, Session close and explicit release. Release resolves after destruction and is idempotent.

Main extensions use scoped `browserGuests` snapshot/command/fetch/release capabilities, never WebContents ids. A command allowlist and navigation policy reject denied work before CDP dispatch. Document generations invalidate queued commands, and a bounded command/document deadline destroys an unresponsive guest. This presentation service is independent of the acquisition path so native-child adoption can reuse its composition/lifetime in #8; no child-adoption API is claimed here.

## Plugin boundary

`NativeViewPage` is selected only for detected protocol 1; it never creates a DOM webview or chooses a replacement carrier. Existing explicitly selected Web/webview carriers remain. An unsupported native Sidebar operation reports `BROWSER_NATIVE_SURFACE_UNAVAILABLE`, not an automatically launched self-hosted browser.

Readiness requires attachment and a committed generation with frame and loader ids. The acknowledgement travels through the existing protocol-5 initialization journal and is checked against the main-owned native snapshot before binding a tool handle. Rendering holds, hidden-Session background markers, cancellation, remount and disposal remain part of admission. Native tool calls go through scoped host capabilities; renderer numeric ids cannot authorize them.

The native adapter also installs the existing reference overlay through scoped evaluation and forwards captured intents to the owning Session; navigation and disposal stop its document polling lifetime.

## Runtime delivery

`0004-native-views.patch` and `0005-native-client-errors.patch` supplement each rc.3/rc.5/main source series. Revision-3 runtime specs cover Sidebar-right `lib/client.js`, Desktop `lib/main.js` and `lib/preload-app.cjs`. Sidebar-browser changes only types/Host references, not its client runtime. The source-built release outputs compare byte-for-byte with runtime-patched pristine outputs. Full output fixtures remain compressed with uncompressed length/SHA-256 checks.

Source commits: rc.3 `062adf7365` / `13705d30f0`; rc.5 `da20bebd9d` / `52511a6004`; main `aa0109aba9` / `f430580383`. Applying each new pair to its prior status-source commit reproduces the entire committed Git tree, not only selected files.

`0006-native-same-document.patch` adds main-frame fragment/History API acknowledgements while preserving the committed generation/frame/loader. Source commits: rc.3 `cbc141dd42`, rc.5 `6f3d4987f9`, main `550c755e81`. The plugin refreshes the address/history and restarts reference polling on those document notifications.

`0007-native-auth-cookies.patch` permits the existing `restoreAuth` request (`Storage.setCookies`) but dispatches `Network.setCookies` on the native guest's debugger session. Browser-context selectors and malformed envelopes are denied before dispatch; cookies cannot target another workspace partition. Empty batches remain valid. Failed native tabs also preserve their mounted presentation identity so reload or a fresh address can reacquire a lease without remounting.

Cookie-source commits: rc.3 `7fa9ced01b`, rc.5 `1b89543db9`, main `eeea47412d`. The two follow-up patches reproduce each release's complete committed tree from its preceding client-error commit.

Review follow-up verification: the native service suite passes 16 tests on each source branch; the full plugin suite passes 1,277 of 1,286 tests with 9 skipped. The real-Electron integration also verifies failed-tab reload and fresh navigation without remounting, fragment/History API address refresh with an unchanged document generation, and cookie restoration isolated from a second workspace partition. Runtime comparisons pass all six targets with Desktop main at 876,968 bytes.

Revision-1 and revision-2 upgrades validate the live prior revision against the original backup before computing any new bytes. All selected targets validate before staging. Mismatches/unrelated edits refuse the entire plan; atomic rename, rollback and exact original restore remain unchanged. Revision-2 regression tests include clean upgrade/restore and an unrelated preload edit with no writes.

## Checks

Focused DSH native service, keyboard and Sidebar composition tests and touched Desktop/Sidebar typechecks run on rc.3/rc.5/main. The client purity gate tests the structured error import. Plugin tests include native readiness, missing/empty/error/late-acquire paths, remount cleanup, scoped transport and actual bridge TCP admission with matching/mismatched generation, foreign listing, rendering holds and extension stop cleanup. The full plugin suite retains legacy migration, maintenance, protocol-5 and explicit-carrier regressions.

```sh
pnpm exec tsc -b apps/desktop/tsconfig.host.json packages/client/ui-sidebar-right packages/client/ui-sidebar-browser/tsconfig.host.json
pnpm exec vitest run apps/desktop/tests/native-views.spec.ts apps/desktop/tests/keyboard.spec.ts packages/client/ui-sidebar-right/tests/native-slots.client.spec.ts
node tools/check-host-patch-source.mjs /home/ubuntu/research/artifacts
node node_modules/typescript/bin/tsc -p tsconfig.build.json
TSX_TSCONFIG_PATH=/home/ubuntu/repos/deepseek-harness/tsconfig.base.json node tests/run.mjs
```

Real Electron 44.7.0 qualification under xvfb runs the production native service and security policy. A second harness connects the production preload, SidebarNativeComposition and plugin NativeViewPage with `webviewTag:false`. OS mouse/keyboard input searches a local page; scoped CDP reads the same page and captures it. Both harnesses cover background/minimized generation changes, release and one-BrowserWindow lifetime. The integrated harness also disables requestAnimationFrame and remounts the plugin presentation.

A failure-mode run forcefully crashes a real guest, closes another and reloads the owner renderer. It observes plugin failure, destruction, stale-command refusal and fresh admission/leases after owner reload, with one BrowserWindow throughout. Source/runtime comparison and the full plugin suite remain passing after merging base `292e189` without conflicts: 1,283 tests, 1,274 passed, 9 skipped; plugin Host and native-presentation client typechecks exit zero.

Persistent VM evidence:

- `/home/ubuntu/research/native30-host/{main.cjs,results.json,run.log}`
- `/home/ubuntu/research/native30-integration/{main.cjs,renderer.ts,preload.ts,results.json,run.log,failure-results.json,failure-run.log,screen.png,guest.png}`
- `/home/ubuntu/research/native30-runtime-comparator.log`

### Limits

- These are real Electron component integrations, not a complete packaged DSH profile/UI boot. Deadline and foreign/stale admission have focused service tests; not every branch is repeated through the real plugin UI.
- No real Windows installation/restart, full Desktop quit/relaunch, active-task shutdown or laptop access was performed. Restart persistence is not established by the component harness.
- The published rc.5 Desktop pristine artifact remains unavailable; source-build hashes are used and mismatches refuse patching.
- No full production Sidebar layout/visual acceptance is claimed. The integrated native surface screenshot is a qualification layout rather than the shipped DSH shell.
