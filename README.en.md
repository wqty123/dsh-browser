# dsh-builtin-browser (built-in shared real browser plugin for DeepSeek Harness)

中文 | [English](README.en.md)

A shared real browser capability plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a visible browser the human watches and can take over, driven by the agent over CDP.

This plugin provides the **host-side capability** (browser seam, Electron CDP provider, `browser_*` model tools). The browser's **native view itself** is supplied by the host (a desktop shell) through `ctx.electronViewHost`; the plugin contains no browser UI.

## Features

- **Real view, not a relay.** The browser is a native view (`WebContentsView`) the human can see and operate directly; the agent drives the very same page. The view is provided by the host shell; the plugin drives it.
- **DOM-referenced, not coordinate-guessing.** `browser_snapshot` returns numbered interactive elements; `browser_execute` runs JS in the page (native setters for framework inputs), so interaction works on React/Vue pages.
- **Multi-tab sessions.** Open URLs in parallel tabs, list/switch/close/reset, all keeping state.
- **Multi-format content.** Fetch pages as html / markdown / txt / json, scoped by selector, capped by length and timeout.

## Requirements

- DeepSeek Harness (dsh) with the `web` profile
- A host that provides `ctx.electronViewHost` (a machine holding real Electron `WebContentsView`s, e.g. dsh's desktop shell). Without one, the plugin mounts the seam but the provider and tools stay disabled — plain `dsh web` is unaffected.

## Install

```sh
dsh plugin --profile web add dsh-builtin-browser  # from npm once published
# or from a checkout (one plugin, one repository):
dsh plugin --profile web add <path-to-this-repo>
```

This links the plugin, adds `dsh-builtin-browser` to the profile's bundle layer, and mounts:

| Row | Subpath | Role |
|---|---|---|
| `browser` | `dsh-builtin-browser/browser` | `ctx.browser` capability seam (always mounted) |
| `browser-electron` | `dsh-builtin-browser/browser-electron` | Electron CDP provider (needs `electronViewHost`) |
| `tool-browser` | `dsh-builtin-browser/tool-browser` | `browser_*` model-facing tools |

The provider and tools are gated on `ctx.get('electronViewHost')` being present, so a composition without a desktop shell simply keeps the seam and nothing else.

## Configuration

The plugin mounts through `cordis.patch.yml`; per-row config:

| Row | Key | Type | Default | Description |
|---|---|---|---|---|
| `browser-electron` | `viewHost` | object | required | `ElectronBrowserViewHost` supplied by the host shell (typically `!!js ctx.get('electronViewHost')`) |
| `browser-electron` | `httpOnly` | boolean | `true` | Allow HTTP(S) navigation only; other protocols (e.g. `file:`/`data:`) are rejected (`BROWSER_NAVIGATION_BLOCKED`) |
| `browser-electron` | `snapshotMaxElements` | number | `60` | Max snapshot elements before truncation |
| `browser-electron` | `contentMaxChars` | number | `100000` | Default content character cap |
| `tool-browser` | `timeoutMs` | number | `60000` | Cooperative tool timeout (ms) |
| `tool-browser` | `tabTools` | boolean | `true` | Register tab-management tools (`browser_list_tabs` etc.) |

## Tools

| Tool | Purpose |
|---|---|
| `browser_open` | Open a URL (optionally a new tab); returns a snapshot |
| `browser_snapshot` | Numbered inventory of interactive elements (inputs/buttons/links) |
| `browser_execute` | Run JS in the page; args arrive as `arguments[0..n]` |
| `browser_content` | Fetch the page as html / markdown / txt / json (selector, maxChars, timeoutMs) |
| `browser_screenshot` | PNG capture, optional `fullPage` |
| `browser_list_tabs` / `browser_switch_tab` / `browser_close_tab` / `browser_reset` | Multi-tab session management |

### Interaction discipline (clicking / filling forms)

- **Prefer DOM semantics over coordinates**: submit forms with `form.requestSubmit()`, click with `element.click()`; coordinate clicks are the last resort.
- **Target the right element**: pages often carry hidden copies (e.g. mobile buttons). Use `browser_execute` to filter visible elements (`getBoundingClientRect()` with width/height > 0, computed style not `display:none`) before reading coordinates.
- **Click immediately after reading coordinates**: do not interleave other actions (filling, scrolling moves elements; stale coordinates fail instantly).
- **Verify the hit before clicking**: `document.elementFromPoint(x, y)` confirms the coordinate actually lands on the target button/link before issuing a real click.
- **Mind DPR**: CDP input uses CSS pixels; on high-DPI screens, calibrate with `elementFromPoint` instead of blind coordinate tries.

## How it works

```
agent (browser_* tools)
  → ctx.browser (seam, dsh-builtin-browser/browser)
  → dsh-builtin-browser/browser-electron (provider)
  → ElectronBrowserViewHost (supplied by the host shell)
  → WebContentsView + webContents.debugger (CDP)
```

The provider is Electron-agnostic by construction: it operates through the `ElectronBrowserViewHost` seam (create/destroy/show views, `sendCommand`), which a real shell implements with Electron objects. The same seam lets a future relay provider (headless Chromium screenshot stream) serve remote deployments without touching the tools.

## Division of labor with the desktop shell

The browser's **visible view**, the **browser column layout**, and the **column-to-view alignment** belong to the host shell (e.g. dsh's `apps/desktop`), not this plugin. This plugin only consumes the shell-provided `electronViewHost` and owns the seam, provider, and tools. Installing the plugin without a matching shell leaves the capability disabled.

## Known limitations

- Screenshots are PNG-only (CDP JPEG hangs on Electron 43); JPEG awaits a non-CDP conversion path.
- `fullPage` capture is flaky under software compositing on some hosts.
- Session lifecycle is plugin-level (one session shared by the model), not per-agent yet.
- Private mode (`privateMode`) is not implemented: it needs Electron session partitioning, which is host-layer territory; this plugin does not promise it.
- This plugin contains no browser-column UI — that is host-shell territory; do not treat "browser column" as a plugin feature.

## License

MIT
