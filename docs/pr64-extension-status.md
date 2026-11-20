# PR #64: Desktop extension status and profile repair (#36)

## Maintenance boundary

Host bootstrap remains an explicit compatibility action. It may change Desktop/sidebar bundles, migrate recognized legacy injection and retain compatibility fallback when host patching is refused. Ordinary profile install/repair/removal never calls the host applier or legacy installer. Existing legacy deployments continue operating; absent extension status is reported as `DESKTOP_MAIN_EXTENSION_UNSUPPORTED` rather than inferred from an environment marker.

Supported repair reuses Desktop's bundled CLI and reserved-profile permission: `dsh plugin --profile desktop add <the existing dependency spec>`. Relative `file:`/`link:` specs are resolved against that profile. Removal uses `remove dsh-builtin-browser`. A missing profile/spec or package-manager failure is surfaced, not replaced by an app-file installer. Settings passes a feature-detected status from the authenticated Desktop preload even if the bridge itself failed to start.

This is the cold CLI, after confirmed Desktop shutdown, not the live HMR plugin manager. On both rc.3 and rc.5, `apps/cli/src/bin.ts` dispatches to `runPlugin`; `apps/cli/src/plugin.ts` takes the Desktop writer lock and calls `runProfilePnpm` directly. It never boots HMR or calls `PluginManager.installBundle`, whose `already-installed` guard applies to live HMR installation. No remove/add gap is needed for this CLI path. A nonzero package command remains a failed maintenance result even when Desktop is reopened for recovery.

The existing Windows maintenance coordinator still opens the official application menu and requests normal Exit. It waits for confirmed shutdown and refuses writes while a Desktop process remains; it does not force termination. The restarted process receives the job's captured `DSH_HOME`. Successful install requires a live endpoint owned by the new PID plus matching home identifier, package version, bridge code digest and host `loaded` status. Profile removal also removes the plugin's settings/tools after restart; restoring host files is a separate action.

## Host and runtime patch

- `0003-main-extension-status.patch` in each of `dsh-host-patch/sources/{rc3,rc5,main}` extends the loader and authenticated main/preload IPC. It adds no browser guest or debugger API.
- Status is resolved from direct profile dependencies and package contents, compared with the actual running entry. Same-version file replacement becomes `pending-restart`; startup failures are isolated and sanitized.
- Runtime revision 2 patches sidebar `lib/client.js` and Desktop `lib/main.js` plus `lib/preload-app.cjs`. The applier validates the complete selected plan before staging, commits by rename, rolls back failures and preserves original backups across revision-1 upgrades. Restore reproduces original bytes, including an original legacy-injected entry. Unrelated edits refuse writes.

## Checks and acceptance scope

Commands run on the VM include focused Desktop loader/preload/startup tests for rc.3, rc.5 and main, touched Desktop typechecking, the release source-build artifact comparator, a fresh plugin client bundle and:

```sh
TSX_TSCONFIG_PATH=/home/ubuntu/repos/deepseek-harness/tsconfig.base.json node tests/run.mjs
node tools/check-host-patch-source.mjs /home/ubuntu/research/artifacts
```

Coverage includes loader single start and failure isolation, changed/same-version package status, traversal/escaping symlinks, missing profiles, independent homes and cleanup. Plugin tests cover profile CLI selection and failures, unchanged app/archive/launcher bytes, host status with a missing bridge endpoint, explicit unsupported/bootstrap controls, endpoint version/build/home/PID verification, stale crash-endpoint replacement, live socket/listener cleanup, multi-file mismatch/rollback, revision upgrades, legacy-original restore and unrelated-edit refusal. Existing maintenance, quit-confirmation and protocol-5 regressions remain in the full suite.

The source-build comparator checks actual rc.3 and rc.5 before/after bundles, not only the checked-in fixtures, for all three runtime targets. The published rc.5 Desktop artifact is still unavailable for pristine-hash verification; mismatches are refused.

### Not established by VM unit tests

- No laptop access, real Windows reinstall/restart or visual settings verification was performed.
- Read-only package-manager failure and normal profile package operations are tested through the runner seam; this does not establish a real packaged Desktop/pnpm install on a read-only Windows profile.
- Pending-task cancellation uses the existing normal-quit coordinator regression tests; no real active-task Desktop shutdown was exercised for this change.
- Before merging the refreshed base, plugin host emit retained 27 existing Electron typing diagnostics (zero additions). The base's SDK declaration isolation and Electron shim updates remove those diagnostics: the merged `tsc -p tsconfig.build.json` exits zero. The client was built with the repository's current client-bundle preset because this older plugin's checked-in tsdown config imports a removed `@local/tsdown-plugin-cordis` package.
- #8 native child adoption and #30 native views are outside this change.

## Base refresh

Merged `devin/1763597000-sidebar-browser-both-ends` at `e22c245acf99f7b2d042646dc2fade32ea9ea7c3`. Conflicts were limited to `desktop-bridge/main.mjs` (both branches introduced the same extension entry) and `desktop-bridge/plugin-browser-bridge.js` (`start(api)` initialization). Kept the shared API-aware entry plus #36 version/build metadata and idempotent startup/explicit reload. Preserved the base's remaining sidebar-only exports, pairing admission, profile leases, handle and SDK/typecheck changes. No host-authority or carrier-policy decision was needed.

The first merged-suite run found the new SDK-isolation fixture resolving the workspace's real `vendor/cordis/lib/types` path instead of an isolated published SDK. Installed the base's documented `.dsh-sdk-types` dependencies before rechecking; no test or compiler configuration was changed.
