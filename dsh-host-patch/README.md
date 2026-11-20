# DSH host APIs

The bridge settings installer selects the runtime specification by the package's exact version: `rc3.json` for **DSH 0.2.2-rc.3**, and `rc5.json` for **DSH 0.2.2-rc.5**. It installs sidebar rendering holds and Desktop main extensions, not replacements for arbitrary DSH bundles. Desktop updates may require reinstalling from plugin settings.

`sources/rc3/`, `sources/rc5/`, and `sources/main/` contain the two upstream source commits as `git format-patch` files for source builds. Each runtime spec was derived from its own unpatched/patched release builds; its anchors include unchanged context, `before` is the unique input anchor, and `after` is its replacement. Tests compare the complete output artifacts byte for byte. The fixtures are repository tests only and are not published.

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

- Every package manifest must name a supported package and the exact supported DSH version. Main additionally requires the pristine SHA-256. Sidebar anchors do **not** require a build hash: `{{sidebar}}` is resolved from the single `.<prefix>_session{display:contents}` rule. Other CSS modules are untouched. Missing or ambiguous anchors/prefixes are refused.
- Status is `absent` (validated and ready), `applied` (already present), `unsupported version`, or `anchors mismatch`, with a reason on refusal. `dry-run`/`status` write nothing. Applying an already applied patch is a no-op.
- All targets are validated before writes. Files and backups are staged beside the target; backups are created exclusively once as `<file>.before-dsh-host-patch`, and targets are replaced by rename, never edited through pnpm hardlinks. Commit errors roll back earlier targets and newly created backups. An OS failure that also prevents rollback is explicitly reported rather than claimed successful.
- Restore checks the patched bytes against their backup plus this specification; unrelated edits are refused. Backups are preserved for subsequent installs. Do not copy an old backup over a new Desktop release.
- The compiled background-rendering attribute and Desktop extension module region are the detectable applied markers, so output remains identical to the source-built patched artifacts.
- On a patched Desktop the bridge loads from the profile plugin's `dsh.desktop.main` entry. Legacy installations migrate only when `main.js` carries the bridge marker and `main.js.before-bridge` matches the release's pristine hash. That pristine copy is the patch source; `.before-dsh-host-patch` preserves the actual legacy-injected bytes. Restore returns both host files to their pre-install bytes and retains the legacy bridge's module copies, CLI and archive layout. Reapply migrates again. Unsupported/mismatched hosts keep the existing injection path; bridge installation is independent of the optional host-patch status.
- Browser operations feature-detect `sidebarRight.holdRendering`, hold a non-selected conversation for the request, and release on success/error or plugin disposal. The background DOM marker is required before accepting a hidden panel. Older hosts retain selection and `panel-not-displayed` behavior.

The applier's JS API exports `hostPatchStatus`, `applyHostPatch`, and `restoreHostPatch`; each accepts one package directory or an array. It has no npm dependencies. The installer supplies raw Electron `original-fs`. Migration, validation and restore share the same version-specific legacy-backup validation, including through the standalone applier. Removing one recognized legacy injection from the live main entry must reproduce that pristine backup byte for byte; unknown injections and unrelated edits refuse migration without writes.
