# dsh-browser

Shared real browser for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a visible browser the human watches and can take over, driven by the agent over CDP.

- **Real view, not a relay.** The browser is a native `WebContentsView` the human can see and operate directly; the agent drives the very same page.
- **DOM-referenced, not coordinate-guessing.** `browser_snapshot` returns numbered interactive elements; `browser_execute` runs JS in the page (native setters for framework inputs), so interaction works on React/Vue pages.
- **Multi-tab sessions.** Open URLs in parallel tabs, list/switch/close/reset, all keeping state.
- **Multi-format content.** Fetch pages as html / markdown / txt / json, scoped by selector, capped by length and timeout.
- **Browser column in the GUI.** When running under the desktop shell, the browser appears as a column beside the conversation (sidebar | browser | conversation | details), with the native view aligned to the column.

## Requirements

- DeepSeek Harness (dsh) with the `web` profile
- A desktop shell that provides `ctx.electronViewHost` (a host with real Electron `WebContentsView`s). Without one, the plugin mounts the seam but the provider and tools stay disabled — plain `dsh web` is unaffected.

## Install

```sh
dsh plugin --profile web add dsh-browser        # from npm once published
# or from a checkout:
dsh plugin --profile web add <path-to-this-repo>
```

This links the plugin, adds `dsh-browser` to the profile's bundle layer, and mounts:

| Row | Subpath | Role |
|---|---|---|
| `browser` | `dsh-browser/browser` | `ctx.browser` capability seam (always mounted) |
| `browser-electron` | `dsh-browser/browser-electron` | Electron CDP provider (needs `electronViewHost`) |
| `tool-browser` | `dsh-browser/tool-browser` | `browser_*` model-facing tools |

The provider and tools are gated on `ctx.get('electronViewHost')` being present, so a composition without a desktop shell simply keeps the seam and nothing else.

## Tools

| Tool | Purpose |
|---|---|
| `browser_open` | Open a URL (optionally a new tab); returns a snapshot |
| `browser_snapshot` | Numbered inventory of interactive elements (inputs/buttons/links) |
| `browser_execute` | Run JS in the page; args arrive as `arguments[0..n]` |
| `browser_content` | Fetch the page as html / markdown / txt / json (selector, maxChars, timeoutMs) |
| `browser_screenshot` | PNG capture, optional `fullPage` |
| `browser_list_tabs` / `browser_switch_tab` / `browser_close_tab` / `browser_reset` | Multi-tab session management |

## How it works

```
agent (browser_* tools)
  → ctx.browser (seam, dsh-browser/browser)
  → dsh-browser/browser-electron (provider)
  → ElectronBrowserViewHost (supplied by the desktop shell)
  → WebContentsView + webContents.debugger (CDP)
```

The provider is Electron-agnostic by construction: it operates through the `ElectronBrowserViewHost` seam (create/destroy/show views, `sendCommand`), which a real shell implements with Electron objects. The same seam lets a future relay provider (headless Chromium screenshot stream) serve remote deployments without touching the tools.

## Known limitations

- Screenshots are PNG-only (CDP JPEG hangs on Electron 43); JPEG awaits a non-CDP conversion path.
- `fullPage` capture is flaky under software compositing on some hosts.
- Session lifecycle is plugin-level (one session shared by the model), not per-agent yet.

## License

MIT
