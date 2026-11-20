# DSH host APIs

The explicit host-bootstrap settings action selects the runtime specification by the package's exact version: `rc3.json` for **DSH 0.2.2-rc.3**, and `rc5.json` for **DSH 0.2.2-rc.5**. It installs sidebar rendering holds and Desktop main extensions, not replacements for arbitrary DSH bundles. Ordinary extension repair is separate: it runs the installation's supported `dsh plugin --profile desktop add` command and does not run this applier or the legacy injector.

`sources/rc3/`, `sources/rc5/`, and `sources/main/` contain upstream source commits as `git format-patch` files for source builds. `0003` adds resolved/running per-package status and authenticated IPC/preload; `0004` adds native Sidebar views and composition; `0005` admits their structured errors through the release client bundle gate (main already admits them and receives its regression test); `0006` acknowledges same-document native navigation; `0007` restores cookies through the lease's target-scoped Network domain, without exposing Storage browser-context selection. Each runtime spec was derived from its own unpatched/patched release builds; its anchors include unchanged context, `before` is the unique input anchor, and `after` is its replacement. Tests compare complete output artifacts byte for byte, including `lib/preload-app.cjs`. The fixtures are repository tests only and are not published.

The rc.5 source base is release tag `dsh-v0.2.2-rc.5`, commit `9c2670d3bce5275e0d1610272958121af87787bb`, not the later master merge `2e39e704`. Its sidebar sources match the published npm package, `lib/index.js` matches byte for byte, and `lib/client.js` matches after normalizing only the three build-directory-dependent CSS-module prefixes. The rc.5 Desktop pristine hash is from a source build, not a published Desktop artifact: the GitHub release exposes source archives only. Desktop installations with a different pristine hash are refused safely and retain the legacy bridge fallback.

## Standalone CLI (including Web)

Run the dependency-free applier using a package's real directory, not the profile directory:

```sh
node /path/to/dsh-builtin-browser/dsh-host-patch/apply.mjs dry-run /path/to/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right
node /path/to/dsh-builtin-browser/dsh-host-patch/apply.mjs apply /path/to/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right
node /path/to/dsh-builtin-browser/dsh-host-patch/apply.mjs status /path/to/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right
node /path/to/dsh-builtin-browser/dsh-host-patch/apply.mjs restore /path/to/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right
```

Web settings also provide Install and Restore actions. The Host asks DSH's live `clientModules.clientPath()` registry for the sidebar bundle it actually serves; this works with both npm installs and source checkouts, without guessing an installation path. Missing registries, unsupported bundles, and read-only packages leave the controls unavailable with a reason. Maintenance requires an authenticated, same-origin request directly from localhost. A successful change refreshes the registry cache through `rebuilt()` and asks you to reload the page; older registries without cache refresh require a server restart, which settings report explicitly. Desktop still uses its separate closed-application bridge maintenance.

For standalone Web/npm CLI use, resolve that package from the Web profile's `node_modules`. Multiple package directories can be supplied for a transactional Desktop + sidebar apply. The Desktop settings installer locates its own bundled sidebar under `resources/app/dsh/node_modules`.

## Safety and fallback

- Every package manifest must name a supported package and the exact supported DSH version. Main and preload additionally require pristine SHA-256 values. Sidebar anchors do **not** require a build hash: `{{sidebar}}` is resolved from the single `.<prefix>_session{display:contents}` rule. Other CSS modules are untouched. Missing or ambiguous anchors/prefixes are refused.
- Status is `absent` (validated and ready), `applied` (already present), `unsupported version`, or `anchors mismatch`, with a reason on refusal. `dry-run`/`status` write nothing. Applying an already applied patch is a no-op.
- All targets are validated before writes. Files and backups are staged beside the target; backups are created exclusively once as `<file>.before-dsh-host-patch`, and targets are replaced by rename, never edited through pnpm hardlinks. Commit errors roll back earlier targets and newly created backups. An OS failure that also prevents rollback is explicitly reported rather than claimed successful.
- Restore checks the patched bytes against their backup plus this specification; unrelated edits are refused. Backups are preserved for subsequent installs. Do not copy an old backup over a new Desktop release.
- Revision 3 is identified by native-state IPC and native-owner composition markers. Previous revisions are validated against their original backups using the retained `*-revision1.json` / `*-revision2.json` specs before upgrading. All selected files, including both Desktop bundles, are validated before any write. Upgrade never replaces the original backups; rollback restores the pre-upgrade bytes and restore returns the exact pre-bootstrap originals. Unrelated edits are refused.
- On a patched Desktop the bridge loads from the profile plugin's `dsh.desktop.main` entry. Legacy installations migrate only when `main.js` carries the bridge marker and `main.js.before-bridge` matches the release's pristine hash. That pristine copy is the patch source; `.before-dsh-host-patch` preserves the actual legacy-injected bytes. Restore returns all host files to their pre-install bytes and retains the legacy bridge's module copies, CLI and archive layout. Reapply migrates again. Unsupported/mismatched hosts retain the compatibility injector only inside this explicit bootstrap action; supported profile repair never uses it.
- Browser operations feature-detect `sidebarRight.holdRendering`, hold a non-selected conversation for the request, and release on success/error or plugin disposal. The background DOM marker is required before accepting a hidden panel. Older hosts retain selection and `panel-not-displayed` behavior.

The applier's JS API exports `hostPatchStatus`, `applyHostPatch`, and `restoreHostPatch`; each accepts one package directory or an array. It has no npm dependencies. The installer supplies raw Electron `original-fs`. Migration, validation and restore share the same version-specific legacy-backup validation, including through the standalone applier. Removing one recognized legacy injection from the live main entry must reproduce that pristine backup byte for byte; unknown injections and unrelated edits refuse migration without writes.

## Extension status and source-build checks

`dshDesktop.mainExtensions = { revision: 2, status(name) }` reports `not-installed`, `pending-restart`, `loaded`, or `failed`, with optional `version`, `loadedAt`, and sanitized `code`. Status fingerprints the resolved installed package and compares it with the package loaded by this Desktop process, including same-version replacements. The primary `dsh-app://app` frame alone can invoke the renderer IPC. Trusted main extensions receive the same status capability in `start(api)`.

The status source commits are rc.3 `d38ed963510b8f9688374f1112075b6124cda09b`, rc.5 `8b0e829bfd22d6e131cdc66a5a0f6592c7a6f074`, and main `1a01e26b8e0c25fcdbc2e6cbcd191fcf216eef08`.

To compare actual release source builds (not only checked-in fixtures), arrange each build under `<artifacts>/{rc3,rc5}/{unpatched,patched}/`, retaining `apps/desktop/lib/{main.js,preload-app.cjs}` and `packages/client/ui-sidebar-right/lib/client.js`, then run:

```sh
node tools/check-host-patch-source.mjs <artifacts>
```

All six comparisons must be byte-for-byte equal. See [the #36 verification record](../docs/pr64-extension-status.md) for scope and limitations.

## Native Sidebar views (#30)

Revision 3 exposes optional `dshDesktop.browser.nativeViews.protocolVersion === 1`: `acquire(scope, workspace)`, `attach(lease, slot)`, `command(lease, method, params?)`, `onState(lease, listener)`, and idempotent asynchronous `release(lease)`. Sidebar-right owns Session admissions, native slot registration, clipping/resize/scroll/visibility placement and revocation. Canonical tab addresses identify the owner; only the authenticated primary renderer and admitted slot can bind a main-owned, sandboxed WebContentsView. No DOM webview, hidden BrowserWindow, iframe proxy or standalone browser is created. Native leases use the existing workspace partition/security policy.

Trusted main extensions receive scoped `browserGuests` snapshots, restricted commands, fetch and release capabilities; raw WebContents and numeric ids are not capabilities. Plugin readiness requires attachment and the current committed generation/frame/loader, carried through protocol-5 initialization. Rendering holds and the hidden-Session background marker remain required. Native sidebar operations never silently switch carriers when this API is unavailable; explicitly chosen Web/webview carriers retain their existing behavior.

The sidebar-browser package changes only type declarations and Host type references; its runtime client is unchanged and needs no runtime edit. See [the #30 verification record](../docs/pr64-native-views.md) for source commits, commands and acceptance scope. Native child adoption (#8) remains separate.
