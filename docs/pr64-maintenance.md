# Desktop reinstall recovery

Automatic reinstall checkpoints `package.json`, `pnpm-lock.yaml`, `node_modules/.modules.yaml`, the plugin entry, and a shallow inventory of top-level packages (including scoped package names) beside the staged worker. It does not snapshot unrelated package contents, virtual stores, executable shims or temporary package directories. Remove, revert, apply, add and package-resolution failures restore the saved manifests and plugin, run the bundled `pnpm install --offline --frozen-lockfile`, and recover missing orphan entries from `.ignored` before the recovery restart. Failed reconciliation/restoration or uncertain child-process termination suppresses restart and retains the checkpoint for recovery.

The checkpoint never creates symbolic links or hardlinks and never traverses junctions or symbolic links. Link targets and directory/file types are recorded in `metadata.json`; external linked checkouts are not copied. Only the three profile files and a real-directory plugin entry are copied. Directory links are restored as junctions, which do not require Windows Developer Mode or administrator privileges. A denied file-link restore fails explicitly and suppresses restart. A checkpoint preparation failure removes its partial checkpoint without changing the profile. After reconciliation, the saved profile files/plugin are reinstated and plugin resolution is checked in a fresh process. Arbitrary in-place modifications inside unrelated packages are outside this minimal checkpoint; missing declared dependencies rely on the offline store, and a missing orphan not recoverable from `.ignored` fails rollback rather than claiming recovery.

Preflight records undeclared nested dependencies in `automatic.json`. After Desktop exits, a bounded Electron-node child removes contaminated, profile-owned nested `node_modules` with plain filesystem semantics before pnpm removal. External linked checkouts are never cleaned. Declared dependency links alone do not count as contamination.

Package operations and rollback reconciliation set both legacy `npm_config_*` and pnpm 11 `PNPM_CONFIG_*` settings: offline, ignore scripts, no automatic peer installation, zero fetch retries and bounded fetch timeout. pnpm 11 ignores the legacy environment prefix. Each CLI call has a 60-second bound and terminates its process tree before rollback. Unrelated top-level entry removals or retargeting fail the transaction rather than silently accepting pruning.

Electron-node package-manager children inherit `ELECTRON_NO_ASAR=1`, including DSH's own plugin removal after this plugin's Cordis contribution is disposed. This does not change the running host's `process.noAsar`. A packed cold CLI must first import from `app.asar` with archive support enabled, then passes no-ASAR mode to its pnpm child. Maintenance itself discovers the packed CLI through raw archive reads.

## Sidebar tool readiness

`dsh_browser_open` requires a controllable session and a successful live snapshot. A missing bridge or manual-only iframe is refused with `BROWSER_NATIVE_SURFACE_UNAVAILABLE`; no iframe navigation is queued and no task session is recorded. A failed switch leaves an existing controllable session unchanged. Manual browsing in the Web panel remains available through the UI.

A responding legacy bridge with protocol below 4, or an absent/invalid protocol, fails discovery with `BROWSER_BRIDGE_OUTDATED`, `bridgeState: stale`, `repairAction: reinstall`, and the actual/required protocols. The error names “桥接版本过旧” and “卸载并重装”. This refusal precedes iframe fallback, so an old host copy cannot turn a tool open into manual-only navigation. The stable host loader installed by reinstall follows the profile package on subsequent updates.

## Regression commands

Compile the host first with `tsc -p tsconfig.build.json`. Then run `TSX_TSCONFIG_PATH=<DSH tsconfig.base.json> node tests/run.mjs`.

Set `DSH_RC3_SOURCE` to a dependency-prepared rc.3 checkout, `DSH_PLUGIN_ARCHIVE` to the real plugin tgz and `DSH_ELECTRON_BINARY` to an installed Electron executable to enable the actual cold-CLI integration. It checks unchanged rc.3 dispatch sources, actual module execution, offline file remove/add, file/link siblings, an orphan, and removal of a real nested `default_app.asar` under Electron-node. The package must declare no installable Electron dependency and ship no nested dependencies. pnpm may generate a nested `.bin` directory for katex executable shims; the test permits those shims but no nested package or virtual store.

The Linux Electron negative control sees ASAR as a virtual directory but can still remove it. This is not a reproduction of Windows' reported hang or proof of a particular Windows file handle. The pre-existing copied development tree reported before the r8c2 job is not part of the r8c2 archive. No Windows execution or installed-shell visual verification is implied by these VM regressions.
