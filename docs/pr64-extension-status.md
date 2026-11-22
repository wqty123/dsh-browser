# PR #64: Desktop extension status and profile repair (#36)

## Maintenance boundary

Windows settings has one fixed-label **卸载并重装** control. The automatic route accepts `{ "action": "reinstall" }` and optional locale, not the former install/uninstall modes or renderer-supplied host status. Manual/Web `BridgeAction` remains `install | uninstall`; Web host-patch controls are unchanged.

Read-only preflight validates Desktop identity, authoritative archive bytes and restore baselines, and captures the dependency from `DSH_HOME/profiles/desktop/package.json`. A missing dependency returns `REINSTALL_DEPENDENCY_MISSING` before creating a lock, plan or staging directory, never selecting a replacement source. Local sources must remain readable outside the removed package. Packed preflight ignores stale `resources/app` extractions. The compiled coordinator, installer and host-patch runtime are copied outside the installed package before arming.

One locked transaction, after confirmed shutdown, removes the profile dependency using Desktop's cold CLI, runs installer `--revert`, applies the host patch, then re-adds the captured dependency. Relative `file:`/`link:` sources resolve against the original profile. Verified absence permits a no-op removal/restore; other errors stop the transaction. Repeated runs retain the exact original restore baselines. A nonzero package command remains a failed durable job even when Desktop is reopened for recovery.

The Windows coordinator retains the armed-response acknowledgement and official normal Quit flow. It waits for confirmed shutdown and refuses maintenance writes on cancellation; it never force-terminates Desktop. It restarts once with the captured `DSH_HOME`, including recovery after failure. Success requires a live endpoint owned by the new PID, matching home, extension version/build, host `loaded` status and applied host-patch status.

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

While review was running, the base advanced again to `3802d39`. The follow-up merge keeps its canonical-handle transport and adapts rendering holds/cancellation to derive the owner from the validated tab handle, while retaining extension status and cleanup. Conflicts were in `desktop-bridge/plugin-browser-bridge.js` and the ownership test's renderer stub. Rendering-hold fixtures now send canonical handles; none of their background, cancellation or disposal assertions were removed.
