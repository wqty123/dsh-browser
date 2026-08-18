<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-browser?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/npm/v/dsh-builtin-browser?style=flat&amp;label=npm&amp;color=CB3837" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/Platform-Windows-4493F8?style=flat-square" alt="Platform: Windows (verified)">
</p>

<p align="center"><a href="README.md">中文</a> · English</p>

<h3 align="center">A <b>shared real browser</b> plugin for the DeepSeek Harness ecosystem (install-and-use, human and agent on the same page)</h3>

<h4 align="center">The agent drives a real, visible browser the human can watch and take over at any time — both operate the <b>same page</b>.</h4>

## Documentation

| Goal | Entry |
| --- | --- |
| Why a shared real browser, and how it differs from headless approaches | [Why a shared real browser](docs/why-browser.md) |
| Installation, configuration, day-to-day use | [User guide](docs/user-guide.md) |
| All 20 tools: parameters, output, examples | [Tool reference](docs/tool-reference.md) |
| How the seam / provider / tools layers and self-hosting work | [Architecture](docs/architecture.md) |
| Documentation index and README split | [Docs index](docs/README.md) |

## What is this

`dsh-builtin-browser` adds browser capability to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **A real view, not a relay**: the browser is a native `WebContentsView`; the human sees every step the agent takes and can grab control at any time;
- **Install-and-use**: with a desktop shell the shell's embedded view is used; on plain `dsh web` the plugin **self-hosts** — it spawns its own Electron window with zero extra configuration;
- **One plugin, one toolset**: after install the agent automatically gets 20 `browser_*` tools (open, inspect, interact, fill forms, screenshot, download, auth management…).

In one sentence: **installing the plugin gives you a real browser that is shared with the user and drivable by the agent.**

## Quick start

```sh
# Option 1: install from npm (published)
dsh plugin --profile web add dsh-builtin-browser

# Option 2: install from a checkout (one plugin, one repository)
dsh plugin --profile web add <path-to-this-repo>
```

After install the agent can use the browser tools, e.g.:

| What you want | Tool | Notes |
| --- | --- | --- |
| Open a page | `browser_open` | Opens a URL and returns a numbered snapshot |
| Understand a page | `browser_snapshot` | Numbered inventory of inputs/buttons/links to target |
| Operate a page | `browser_execute` | Runs JS in the page (native setters, framework-friendly) |
| Fill a form | `browser_fill` | Fills many fields in one call, optional submit |
| See the page | `browser_screenshot` | PNG capture, optionally saved for a vision model |

See the full list in [Tool reference](#tool-reference).

## Main features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Shared real browser</h3>
      <p>A native view, not a headless screenshot. Human and agent operate the same page: the user sees every step and can take over; the agent drives the very window in front of the user.</p>
    </td>
    <td width="50%" valign="top">
      <h3>DOM-level driving, framework-friendly</h3>
      <p><code>browser_snapshot</code> returns numbered interactive elements; <code>browser_execute</code> runs JS in the page (native setters + input/change events for controlled inputs), so React/Vue pages work reliably.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Multi-tab sessions</h3>
      <p>Open URLs in parallel tabs; list/switch/close/reset tabs while each session keeps its own state.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Multi-format content</h3>
      <p>Fetch pages as html / markdown / txt / json, scoped by CSS selector, capped by character limit and timeout.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Per-task session isolation</h3>
      <p>Each DSH task (session) gets its own browser session (own tabs and history); concurrent tasks never fight over the page or pollute each other. Calls within one task reuse the same session.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Login persistence</h3>
      <p><code>browser_auth</code> exports/restores cookies so logins survive host restarts; self-hosted cookies are also persisted to disk.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>CAPTCHA / bot-detection awareness</h3>
      <p>Detects Cloudflare, reCAPTCHA, hCaptcha, Turnstile and generic challenges (<code>browser_challenge</code>, also flagged in snapshots); instead of retrying blindly, the agent asks the human to complete it in the shared window.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Batch form filling</h3>
      <p><code>browser_fill</code> fills many fields at once — matched by selector/name/label, handling controlled inputs, selects, checkboxes and radio groups, with optional submit; one failing field never aborts the rest.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Operation history &amp; replay</h3>
      <p><code>browser_history</code> logs operations (open/execute/click/type/fill/download/auth); <code>browser_replay</code> re-runs one step by sequence number.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Authenticated downloads</h3>
      <p><code>browser_download</code> fetches a file in the page context with the session's cookies and writes it to disk — content behind login works too.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Safety restriction</h3>
      <p><code>browser_restrict</code> limits which browser actions are allowed (allow-list) to prevent stray clicks/navigation; read-only tools (snapshot/content/screenshot) are never blocked.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Screenshot, save and read</h3>
      <p><code>browser_screenshot</code> supports <code>savePath</code> to write the PNG to disk, ready for vision models (modlens etc.) to locate elements visually.</p>
    </td>
  </tr>
</table>

## Why this plugin

- **Install-and-use, zero config**: no desktop shell or extra startup step required; on plain `dsh web` it self-hosts an Electron window and the `browser_*` tools just work.
- **Human-in-the-loop, non-interfering**: the user sees and can take over every agent action; per-task isolation gives each parallel task its own tabs and history.
- **Built for the real world**: CAPTCHA detection, login persistence, batch form filling, authenticated downloads, operation replay, action restriction — real-browser automation that is actually reliable.
- **Testable, replaceable architecture**: the provider talks to Electron through the `ElectronBrowserViewHost` seam, so a future headless relay provider can serve remote deployments without touching the tool layer.

## Tool reference

| Tool | Purpose | Guard |
| --- | --- | --- |
| `browser_open` | Open a URL (optionally in a new tab); returns a page snapshot | ✅ |
| `browser_snapshot` | Numbered inventory of interactive elements (inputs/buttons/links) | – |
| `browser_execute` | Run JS in the page; args arrive as `arguments[0..n]` | ✅ |
| `browser_content` | Fetch the page as html / markdown / txt / json (selector, maxChars, timeoutMs) | – |
| `browser_click` | Click at viewport coordinates (for vision-located targets) | ✅ |
| `browser_type` | Type text into the focused element (CDP `Input.insertText`) | ✅ |
| `browser_fill` | Batch form fill (selector/name/label matching, controlled inputs, selects, checkbox/radio, optional submit) | ✅ |
| `browser_screenshot` | PNG capture, optional `fullPage` and `savePath` | – |
| `browser_list_tabs` | List the session's tabs | – |
| `browser_switch_tab` | Switch to a tab by id (also switches the visible view when self-hosted) | ✅ |
| `browser_close_tab` | Close a tab by id; closing the active tab activates the next | – |
| `browser_reset` | Close all tabs of this task, back to one blank tab | ✅ |
| `browser_session` | Show this task's browser session and tabs | – |
| `browser_reset_session` | Close and rebuild this task's browser session | ✅ |
| `browser_history` | Operation log (newest last), with per-step success/error and result summary | – |
| `browser_replay` | Replay one step by sequence number (navigate/execute/click/type) | ✅ |
| `browser_download` | Download an HTTP(S) URL with session cookies to a local file (absolute `savePath`, 256 MB cap) | ✅ |
| `browser_auth` | Export/restore cookies (login persistence, self-hosted) | ✅ |
| `browser_challenge` | Detect a human-verification challenge (CAPTCHA / Cloudflare / reCAPTCHA / hCaptcha / Turnstile) | – |
| `browser_restrict` | Restrict allowed browser actions (allow-list; empty list lifts it) | – |

> "Guard" column: ✅ actions are governed by the `browser_restrict` allow-list; read-only tools (snapshot/content/screenshot/list_tabs/session/challenge/history) are never blocked.

### Operating discipline (click/fill)

- **Prefer DOM semantics over coordinates**: submit forms with `form.requestSubmit()`; click with `element.click()`; coordinate clicks are the last resort.
- **Target the right element**: pages often have hidden duplicates (e.g. mobile buttons); filter visible elements with `browser_execute` (`getBoundingClientRect()` w/h > 0, `getComputedStyle` not `display:none`), then take coordinates.
- **Click right after taking coordinates**: do not insert other operations in between (filling/scrolling moves elements and invalidates old coordinates).
- **Verify before clicking**: use `document.elementFromPoint(x, y)` to confirm the coordinate hits the intended element (button/link), then perform the real click.
- **DPR awareness**: CDP input uses CSS pixels; on high-DPI screens calibrate with `elementFromPoint` instead of guessing coordinates.

## Configuration

The plugin mounts through `cordis.patch.yml` (three rows); per-row config:

| Row | Key | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `browser-electron` | `viewHost` | object | required | `ElectronBrowserViewHost` supplied by the host shell (typically `!!js ctx.get('electronViewHost')`) |
| `browser-electron` | `httpOnly` | boolean | `true` | Allow HTTP(S) navigation only; other protocols (e.g. `file:`/`data:`) rejected (`BROWSER_NAVIGATION_BLOCKED`) |
| `browser-electron` | `snapshotMaxElements` | number | `60` | Max snapshot elements before truncation |
| `browser-electron` | `contentMaxChars` | number | `100000` | Default content character cap |
| `browser-electron` | `downloadDir` | string | unset | Confine `browser_download` save paths to this directory (stops a prompt-injected agent writing arbitrary paths); when unset, absolute paths are still required |
| `tool-browser` | `timeoutMs` | number | `60000` | Cooperative tool timeout (ms) |
| `tool-browser` | `tabTools` | boolean | `true` | Register tab-management tools (`browser_list_tabs` etc.) |

## How it works

```
agent (browser_* tools)
  → ctx.browser (seam, dsh-builtin-browser/browser)
  → dsh-builtin-browser/browser-electron (provider)
  → ElectronBrowserViewHost (supplied by the host shell)
  → WebContentsView + webContents.debugger (CDP)
```

- **Seam** (`browser` row): provides the `ctx.browser` service — provider registration, session lifecycle, error codes — decoupled from any implementation.
- **Provider** (`browser-electron` row): operates views through the `ElectronBrowserViewHost` seam (create/destroy/show, `sendCommand`), implemented with real Electron objects by the shell.
- **Tools** (`tool-browser` row): the 20 model-facing `browser_*` tools, maintaining one browser session per calling task (DSH session).

**Self-hosted mode**: without a desktop shell, the plugin spawns its own Electron child process (`host-main.js`) and drives it over loopback TCP JSON-RPC (window title `dsh-browser`). The child auto-restarts after a crash; screenshots prefer Electron's native `capturePage` (CDP capture can hang with multiple views in the window); the plugin automatically picks the **newest** Electron in the environment (33.x has a compositor defect; ≥ 40 recommended).

**Electron lookup order**: ① `require('electron')` (peer dependency) → ② `ELECTRON_PATH` (explicit override) → ③ the newest among DSH install anchors and pnpm virtual stores. A clear error tells you when none is found.

## Division of labor with the desktop shell

The browser's **visible view**, the **browser column layout**, and the **column-to-view alignment** belong to the host shell (e.g. dsh's `apps/desktop`), not this plugin. This plugin consumes the shell-provided `electronViewHost` and owns the seam, provider, and tools. Without a shell the plugin **self-hosts** and everything still works.

## Requirements

- DeepSeek Harness (dsh) with the `web` profile
- **Electron runtime** (optional peer dependency): the desktop shell carries it; on plain `dsh web` the plugin locates an Electron binary automatically (see above; ≥ 40 recommended)

### Verified versions

| Component | Version |
| --- | --- |
| DeepSeek Harness (dsh) | `0.1.0-rc.5` |
| Electron | `43.4.0` (≥ 40 recommended; 33.x has a compositor defect) |
| Node.js | `22.20.0` |
| dsh-builtin-browser | `0.1.15` |
| OS | Windows 10 (10.0.26200) |

> The plugin declares `electron >= 30`; it has **only been verified on Windows** (macOS/Linux untested, not yet promised).

## Known limitations

- Screenshots are PNG-only (CDP JPEG hangs on Electron 43); JPEG awaits a non-CDP conversion path.
- Self-hosted captures prefer Electron's native `capturePage` (CDP `captureScreenshot` can hang with multiple views in the window); the target tab is raised before capturing.
- `fullPage` capture is flaky under software compositing on some hosts.
- CAPTCHA cannot be solved automatically: snapshots flag detected challenges; ask the human to complete it in the shared window instead of retrying.
- Private mode (`privateMode`) is not implemented: it needs Electron session partitioning, which is host-layer territory; this plugin does not promise it.
- `browser_download` fetches in the page context (keeps logins) and is subject to same-origin/CORS constraints; HTTP(S) targets only; `savePath` must be absolute (confined to `downloadDir` when configured); single files are capped at 256 MB (streamed with a Content-Length early reject).
- Popups (`window.open` / `target=_blank`) are re-routed into the current tab instead of opening untracked native windows, so the tab/session model stays intact.
- The `browser_auth` cookie round-trip does not preserve `hostOnly`/`sameSite` (host-only cookies come back as domain cookies); it is available on the self-hosted browser only.
- After a self-hosted child crash the browser host restarts automatically, but sessions opened before the crash are gone — call `browser_reset_session` to rebuild.
- This plugin contains no browser-column UI — that is host-shell territory; do not treat "browser column" as a plugin feature.

## Development

```sh
# Type-check + build (lib/)
pnpm run build
```

> The repo does not currently ship an automated test suite (type-check + build verifies the TypeScript side).

Code layout:

| Directory | Responsibility |
| --- | --- |
| `src/browser/` | The `ctx.browser` seam and all request/result types |
| `src/browser-electron/` | Electron CDP provider, self-hosted child (`host-main.ts`), RPC layer |
| `src/tool-browser/` | Model-facing `browser_*` tools |
| `src/types/` | Electron ambient types (shim; no hard electron type dependency) |

## Acknowledgements

Special thanks to the [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) and the DeepSeek AI team: the seam, the tool runtime, and the plugin system this plugin builds on all come from that project.

Thanks as well to [Cordis](https://github.com/cordiverse/cordis) for the plugin foundation, and to everyone in the community who discussed, tested, gave feedback, and built plugins.

## License

MIT License, see [LICENSE](LICENSE).

> This project is a community plugin for DeepSeek Harness, not an official DeepSeek product.
