# DSH host APIs

The bridge settings installer applies the runtime specification in `rc3.json` to **DSH 0.2.2-rc.3**. It installs sidebar rendering holds and Desktop main extensions, not replacements for arbitrary DSH bundles. Desktop updates may require reinstalling from plugin settings.

`sources/rc3/` and `sources/main/` contain the two upstream source commits as `git format-patch` files for source builds. The runtime spec was derived from the unpatched/patched rc.3 builds; its anchors include unchanged context, `before` is the unique input anchor, and `after` is its replacement. Tests compare the complete output artifacts byte for byte. The fixtures are repository tests only and are not published.

## Standalone CLI (including Web)

Run the dependency-free applier using a package's real directory, not the profile directory:

```sh
node /path/to/dsh-builtin-browser/dsh-host-patch/apply.mjs dry-run /path/to/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right
node /path/to/dsh-builtin-browser/dsh-host-patch/apply.mjs apply /path/to/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right
node /path/to/dsh-builtin-browser/dsh-host-patch/apply.mjs status /path/to/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right
node /path/to/dsh-builtin-browser/dsh-host-patch/apply.mjs restore /path/to/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right
```

For a Web/npm install, resolve that package from the Web profile's `node_modules`. There is no Web file-maintenance settings action: use the CLI and restart the Web server/reload its client. Multiple package directories can be supplied for a transactional Desktop + sidebar apply. The Desktop settings installer locates its own bundled sidebar under `resources/app/dsh/node_modules`.

## Safety and fallback

- Every package manifest must name a supported package and the exact supported DSH version. Main additionally requires the pristine SHA-256. Sidebar anchors do **not** require a build hash: `{{sidebar}}` is resolved from the single `.<prefix>_session{display:contents}` rule. Other CSS modules are untouched. Missing or ambiguous anchors/prefixes are refused.
- Status is `absent` (validated and ready), `applied` (already present), `unsupported version`, or `anchors mismatch`, with a reason on refusal. `dry-run`/`status` write nothing. Applying an already applied patch is a no-op.
- All targets are validated before writes. Files and backups are staged beside the target; backups are created exclusively once as `<file>.before-dsh-host-patch`, and targets are replaced by rename, never edited through pnpm hardlinks. Commit errors roll back earlier targets and newly created backups. An OS failure that also prevents rollback is explicitly reported rather than claimed successful.
- Restore checks the patched bytes against their backup plus this specification; unrelated edits are refused. Backups are preserved for subsequent installs. Do not copy an old backup over a new Desktop release.
- The compiled background-rendering attribute and Desktop extension module region are the detectable applied markers, so output remains identical to the source-built patched artifacts.
- On a patched Desktop the bridge loads from the profile plugin's `dsh.desktop.main` entry. The installer removes its exact legacy snippet as part of the same patch transaction. Unsupported/mismatched hosts keep the existing injection path; bridge installation is independent of the optional host-patch status. Uninstall restores both host files before restoring the legacy bridge/archive.
- Browser operations feature-detect `sidebarRight.holdRendering`, hold a non-selected conversation for the request, and release on success/error or plugin disposal. The background DOM marker is required before accepting a hidden panel. Older hosts retain selection and `panel-not-displayed` behavior.

The applier's JS API exports `hostPatchStatus`, `applyHostPatch`, and `restoreHostPatch`; each accepts one package directory or an array. It has no npm dependencies. The installer supplies raw Electron `original-fs` and an exact legacy-snippet normalizer for migration.
