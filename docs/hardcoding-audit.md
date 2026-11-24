# Hardcoding audit

## Shared ownership

- `assets/browser-policy.mjs`: profile directory, loopback endpoint construction,
  URL parsing base, client/server HTTP routes, default operation and extension
  setup budgets, extension pages and platform folder openers.
- `assets/browser-products.mjs`: browser detection catalog, native-messaging
  registration product names, personal-profile roots and Windows command names.
  Detection still checks the caller's environment and PATH before catalog paths.
- `browser-extension/constants.mjs`: host naming, frame/chunk/message bounds,
  concurrency, authentication/operation budgets, legacy pairing expiry, reconnect
  policy, file names and controller limits. Both extension and native host use it.
- `assets/browser-panel-locales.mjs`, `assets/browser-messages.mjs`, and
  `browser-extension/locales.mjs`: settings, fallback, capture, guest error and
  extension-page copy. English native status and Chinese/English panel fallback
  descriptions share the same messages.
- Existing `paths.ts` remains the DSH_HOME/host-home authority. Removed the unused
  machine-specific settings-path function in `entry.ts`; live settings discovery
  already uses the settings store. Windows process inspection now uses the existing
  system-directory resolver rather than assuming `C:\Windows`.
- Search shortcuts derive their initial search-engine entries from the existing
  configurable engine catalog. Provider operation budgets have named policies.

## Intentionally retained

- CDP methods, HTTP status codes, URL schemes, native-messaging wire fields,
  cryptographic sizes and security address allowlists are protocol/security
  constants, not deployment configuration.
- Existing named domain policies (`DEFAULTS`, store bounds, rendering styles,
  algorithmic limits), editable start-page defaults, and browser catalog paths stay
  with their owner. Making all equal numeric literals share a setting would couple
  unrelated operations and change their meaning.
- The stable extension ID remains a single exported constant in
  `assets/browser-extension-identity.mjs`; the derivation regression verifies it
  against the manifest's public key. No private key is needed or shipped.
- Stderr is intentionally drained to `Stream.Null` with `CopyTo`; it is not a
  framed relay. The Windows launcher's stdin and stdout both flush every chunk.

## Remaining audit work

This pass does not claim every literal in the plugin has been eliminated. Remaining
inline policies include bridge install/restart deadlines, takeover/source polling
intervals, and guest/host UI timing and size thresholds. Some embedded toolbar and
page-script labels and technical error strings still live with their generators;
moving those safely requires preserving serialized-script scope and locale input.

### `src/tool-browser`

- Tool timeout default, wait-budget reserve/minimum, fill-field cap and the
  `dsh_browser_code` cell deadlines live in `assets/browser-policy.mjs`.
- Tool help names the DSH host as `http://127.0.0.1:<port>/`; the port is the one
  `dsh web` prints, never a fixed example.
- Carrier limits are a capability check: `CarrierCapabilities` and
  `assertCapability` in `src/browser/types.ts`, resolved per task by
  `carrierCapabilities()` in `src/tool-browser/state.ts`. A refusal is a
  `BROWSER_CARRIER_CAPABILITY_UNAVAILABLE` `BrowserError` that names the carrier to
  switch to.
- Still open: tool descriptions and result annotations are English literals, and
  settings/open-request/reference endpoint strings should import their canonical
  contract rather than duplicate paths.

### Client bundle

The root `client.js` snapshot is gone. Client tests read the built
`dist/client.cjs` through `tests/helpers/client-build.mjs`, so they exercise what
DSH loads; run `node scripts/build.mjs` first.

### Static guard

`tests/no-hardcoding-guard.test.mjs` rejects drive-letter paths, CSS Modules class
names and DSH version branches in shipped code. Its allowlist holds exact lines
only: the DSH 0.2.2-rc.3 tab-strip fallback (`LEGACY_TAB_STRIP_SELECTOR` in the
settings panel, and the same lookup in the deployed desktop bridge). Every shell
with `data-sidebar-right-session` markers takes the marker path first. Host-patch
specs match exact versions as data, which the guard does not flag.

## Windows launcher regression

`launcherSource()` generates the C# relay, and its complete source still determines
the published executable hash. A small hello can now reach the child and its status
can reach the extension without closing stdin. Tests assert the per-read
write/flush loop and both relay directions. A Windows-only test installs the real
launcher and requires a status within two seconds with stdin open; Linux skips it.
