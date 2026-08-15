# dsh-builtin-browser (built-in shared real browser plugin for DeepSeek Harness)

中文 | [English](README.en.md)

A shared **real browser** capability plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): install and it just works — the agent drives a real, visible browser over CDP that the human can watch and take over at any time. Human and agent operate the **very same page**.

**Why this plugin**

- **Install-and-use.** With a desktop shell the shell's embedded view is used; on plain `dsh web` the plugin **self-hosts** — it spawns its own Electron window with zero extra configuration.
- **Real and visible, human-takeover friendly.** Not a headless screenshot or a relay: the user sees the page and can grab control directly.
- **DOM-level driving, framework-friendly.** React/Vue controlled inputs fill reliably.
- **Concurrency-safe.** Task-level browser session isolation — parallel tasks never fight over the page or pollute each other.
- **Built for the real world.** CAPTCHA detection, login persistence, batch form filling, authenticated downloads, operation replay, and action restriction — all included.

## Features

**Browser capability**

- **Real view, not a relay.** The browser is a native view (`WebContentsView`) the human can see and operate directly; the agent drives the very same page. The view is provided by the host shell; the plugin drives it.
- **DOM-referenced, not coordinate-guessing.** `browser_snapshot` returns numbered interactive elements; `browser_execute` runs JS in the page (native setters for framework inputs), so interaction works on React/Vue pages.
- **Multi-tab sessions.** Open URLs in parallel tabs, list/switch/close/reset, all keeping state.
- **Multi-format content.** Fetch pages as html / markdown / txt / json, scoped by selector, capped by length and timeout.

**Engineering capability**

- **Per-task isolation.** Each DSH task (session) gets its own browser session (own tabs and history); concurrent tasks never interfere, and calls within one task reuse the same session (`browser_session` / `browser_reset_session`).
- **Login persistence.** `browser_auth` exports/restores cookies, so logins survive host restarts.
- **CAPTCHA / bot-detection awareness.** Cloudflare, reCAPTCHA, hCaptcha, Turnstile and generic challenges are detected automatically (`browser_challenge`, and flagged in snapshots); instead of blindly retrying, the agent asks the human to complete it in the shared window.
- **Batch form filling.** `browser_fill` sets many fields in one call — matched by selector/name/label, handling controlled inputs, selects, checkboxes and radio groups, with optional submit.
- **Operation history & replay.** `browser_history` records operations; `browser_replay` re-runs one step.
- **Authenticated downloads.** `browser_download` fetches a URL with the session's cookies straight to a local file.
- **Safety restriction.** `browser_restrict` limits which browser actions are allowed, preventing stray clicks/navigation.

## Requirements

- DeepSeek Harness (dsh) with the `web` profile
- **Electron runtime** (optional peer dependency): the desktop shell carries it; on plain `dsh web` the plugin must be able to locate an Electron binary (see below)
- With a desktop shell (`ctx.electronViewHost`) the shell's embedded view is used; without one the plugin **self-hosts**: it spawns its own Electron window and the `browser_*` tools still work

**Electron lookup order**: ① `require('electron')` (peer installed) → ② DSH install anchors → ③ `node_modules/.pnpm` virtual store → ④ `ELECTRON_PATH` env var. A clear error tells you when none is found.

### Verified versions

| Component | Version |
|---|---|
| DeepSeek Harness (dsh) | `0.1.0-rc.5` |
| Electron | `43.4.0` |
| Node.js | `22.20.0` |
| dsh-builtin-browser | `0.1.7` |
| OS | Windows 10 (10.0.26200) |

> The plugin declares `electron >= 30`; other platforms (macOS/Linux) run the same protocol but were only verified on the Windows environment above.

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
- Self-hosted captures prefer Electron's native `capturePage` (CDP `captureScreenshot` can hang with multiple views in the window); the target tab is raised before capturing.
- **Electron >= 40 is recommended**: 33.x has a compositor defect that intermittently breaks capture ("display surface not available"). The plugin automatically picks the newest Electron in the environment (peer dependency > `ELECTRON_PATH` > newest among anchors/pnpm store).
- `fullPage` capture is flaky under software compositing on some hosts.
- Sessions are isolated per task (each DSH session gets its own browser session with own tabs/history; concurrent tasks never interfere; calls within one task reuse the same session). Logins (cookies) are shared and can be exported/restored with `browser_auth`.
- CAPTCHA cannot be solved automatically: snapshots flag detected challenges (`browser_challenge` checks explicitly); ask the human to complete it in the shared window instead of retrying.
- Private mode (`privateMode`) is not implemented: it needs Electron session partitioning, which is host-layer territory; this plugin does not promise it.
- `browser_download` fetches in the page context (keeps logins) and is subject to same-origin/CORS constraints; single files are capped at 256 MB.
- The `browser_auth` cookie round-trip does not preserve `hostOnly`/`sameSite` (host-only cookies come back as domain cookies); it is available on the self-hosted browser only.
- After a self-hosted child crash the browser host restarts automatically, but sessions opened before the crash are gone — call `browser_reset_session` to rebuild.
- This plugin contains no browser-column UI — that is host-shell territory; do not treat "browser column" as a plugin feature.

## License

MIT
