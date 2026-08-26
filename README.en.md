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
| All 33 tools: parameters, output, examples | [Tool reference](docs/tool-reference.md) |
| How the seam / provider / tools layers and self-hosting work | [Architecture](docs/architecture.md) |
| Documentation index and README split | [Docs index](docs/README.md) |

## What is this

`dsh-builtin-browser` adds browser capability to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **A real view, not a relay**: the browser is a native `WebContentsView`; the human sees every step the agent takes and can grab control at any time;
- **Install-and-use**: with a desktop shell the shell's embedded view is used; on plain `dsh web` the plugin **self-hosts** — it spawns its own Electron window with zero extra configuration;
- **One plugin, one toolset**: after install the agent automatically gets 33 `browser_*` tools (open, a11y tree, wait, semantic/coordinate interaction, scroll, back/forward, batch and single-control form filling, keys, structured scraping, screenshot, download, auth management…).

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
| `browser_wait` | Wait for page load (optional expected URL / CSS selector), returns readiness | – |
| `browser_snapshot` | Numbered inventory of interactive elements (inputs/buttons/links; pierces same-origin iframes and Shadow DOM) | – |
| `browser_a11y` | Accessibility tree: semantic role/name/value/states + coordinates per interactive node (pierces same-origin iframes and Shadow DOM) | – |
| `browser_execute` | Run JS in the page; args arrive as `arguments[0..n]` | ✅ |
| `browser_content` | Fetch the page as html / markdown / txt / json (selector, maxChars, timeoutMs) | – |
| `browser_click` | Click a semantic target (`target`: css/text/xpath, scrolls into view and clicks center) or viewport coordinates (vision-located) | ✅ |
| `browser_type` | Type text (optionally focusing a `target` element first; CDP `Input.insertText`) | ✅ |
| `browser_key` | Press a named key (Enter/Tab/arrows/Home/End…) | ✅ |
| `browser_scroll` | Scroll the page (pixel deltas / selector / top-bottom) | ✅ |
| `browser_back` | One step back in page history (no-op at the start) | ✅ |
| `browser_forward` | One step forward in page history (no-op at the end) | ✅ |
| `browser_refresh` | Reload the current page (like a browser refresh button) | ✅ |
| `browser_fill` | Batch form fill (selector/name/label matching, controlled inputs, selects, checkbox/radio, optional submit) | ✅ |
| `browser_set_value` | Set one control's value (`target`-located; native setter + input/change, React-controlled friendly) | ✅ |
| `browser_check` | Check/uncheck a checkbox or radio (`target`-located) | ✅ |
| `browser_select` | Select an option of a `<select>` by value/text/index (`target`-located) | ✅ |
| `browser_clear` | Clear an input/textarea/contenteditable, or uncheck (`target`-located) | ✅ |
| `browser_get_value` | Read an element's current value for verification (`target`-located) | – |
| `browser_scrape` | Structured extraction: container selector + field map (`selector@attr`), static CSS only, CSP-safe | – |
| `browser_screenshot` | Capture, optional `fullPage`, `savePath`, JPEG (`format`/`quality`) and scaling (`maxWidth`/`maxHeight`) | – |
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
| `browser_restrict` | Restrict allowed browser actions (allow-list; empty list lifts it). **Soft guardrail** — the model can lift it itself; not a security boundary | – |

> "Guard" column: ✅ actions are governed by the `browser_restrict` allow-list; read-only tools (snapshot/content/screenshot/list_tabs/session/challenge/history) are never blocked.

### Waiting for the page

- **After `browser_open`, before `browser_snapshot`, call `browser_wait` on slow sites**: pass `url` (what you opened) and an optional `selector`, and wait for `ready: true` — otherwise you snapshot the old document or a white screen.
- **Content you cannot see may live in an iframe / Shadow DOM**: snapshots and the a11y tree pierce same-origin iframes and shadow roots and mark them `(iframe)`; coordinates are always top-document, so `browser_click` works directly. DOM selectors are frame-scoped — reach them via `iframe.contentDocument` in `browser_execute`.

### Semantic targets and the a11y tree

- **`browser_a11y` is the best way to understand a page**: every interactive node carries its semantic role (button/textbox/checkbox…), accessible name, current value, states (enabled/checked/expanded…) and coordinates — click/type them directly.
- **`browser_click`/`browser_type` accept a `target`**: `{by: css|text|xpath, value, index?}` — `text` matches an element's own visible text (exact first, then contains, deepest preferred); clicks scroll the element to the viewport center first; typing focuses it first.
- **Use the single-control tools for one field** (`browser_set_value`/`browser_check`/`browser_select`/`browser_clear`/`browser_get_value`), `browser_fill` for batches, and `browser_scrape` for structured list extraction.

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
| `browser-electron` | `downloadDir` | string | `~/Downloads` | Confine `browser_download` save paths to this directory (stops a prompt-injected agent writing arbitrary paths); defaults to the OS Downloads folder, override for a sandbox dir |
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
- **Tools** (`tool-browser` row): the 33 model-facing `browser_*` tools, maintaining one browser session per calling task (DSH session).

**Self-hosted mode**: without a desktop shell, the plugin spawns its own Electron child process (`host-main.js`) and drives it over loopback TCP JSON-RPC. The RPC is authenticated with a random per-spawn token delivered over **both stdin and an environment variable** — on Windows the Electron GUI process never receives piped stdin, so the env fallback keeps the handshake reliable. The child auto-restarts after a crash; screenshots prefer Electron's native `capturePage` (CDP capture can hang with multiple views in the window); the plugin automatically picks the **newest** Electron in the environment (33.x has a compositor defect; ≥ 40 recommended; 44+ downloads its binary on first use, needs network).

**The self-hosted browser IS a real browser**: every task (DSH session) gets its **own browser window** with a full toolbar — address bar, back/forward/reload buttons, and a tab strip (new/switch/close tabs). A human can use it exactly like Chrome: type a URL in the address bar (https:// is added automatically), click tabs, open new ones. Keyboard focus follows your clicks — **click the address bar to type, click the page to interact** (Windows focus routing; fixes the case where clicks did not move focus and the address bar could not receive typed URLs). Human and agent actions feed the **same session model** (same tabs, history, and navigation); the window title always shows the task label plus the page title/URL, and views follow the window size on resize. A window closes automatically with its session when the task ends.

**Electron lookup order**: ① the current process IS Electron (DSH Desktop main process) → reuse the host binary directly; ② walk the process ancestry for the host's Electron binary (covers hosts that run the plugin in a child Node process, e.g. DSH Desktop; PowerShell CIM on Windows, last resort only); ③ `require('electron')` (peer dependency); ④ `ELECTRON_PATH` (explicit override); ⑤ the newest among DSH install anchors and pnpm virtual stores. **Zero extra install on DSH Desktop**; when nothing is found a clear error tells you what to do (including the per-profile install command).

## Division of labor with the desktop shell

The browser's **visible view**, the **browser column layout**, and the **column-to-view alignment** belong to the host shell (e.g. dsh's `apps/desktop`), not this plugin. This plugin consumes the shell-provided `electronViewHost` and owns the seam, provider, and tools. Without a shell the plugin **self-hosts** and everything still works.

## Requirements

- DeepSeek Harness (dsh) with the matching profile (`web` / `desktop`, etc.)
- **Electron runtime** (optional peer dependency):
  - **DSH Desktop**: the host itself runs on Electron — the plugin reuses the host binary automatically, **zero extra install**;
  - **plain `dsh web` self-hosted**: an Electron binary is required and located automatically (see above; ≥ 40 recommended; 44+ downloads its binary on first use, needs network)

### Verified versions

| Component | Version |
| --- | --- |
| DeepSeek Harness (dsh) | `0.1.1-rc.2` (peer range `^0.1.1-rc.2`) |
| Electron | `44.0.0` (≥ 40 recommended; 33.x has a compositor defect) |
| Node.js | `22.20.0` |
| dsh-builtin-browser | `0.1.17` |
| OS | Windows 10 (10.0.26200) |

> The plugin declares `electron >= 30`; it has **only been verified on Windows** (macOS/Linux untested, not yet promised).

## Known limitations

- JPEG screenshots are available only on the self-hosted native path (`capturePage` `toJPEG`); the desktop shell's CDP fallback stays PNG (CDP JPEG hangs on Electron 43).
- Self-hosted captures prefer Electron's native `capturePage` (CDP `captureScreenshot` can hang with multiple views in the window); the target tab is raised before capturing.
- `fullPage` capture is flaky under software compositing on some hosts.
- CAPTCHA cannot be solved automatically: snapshots flag detected challenges; ask the human to complete it in the shared window instead of retrying.
- Private mode (`privateMode`) is not implemented: it needs Electron session partitioning, which is host-layer territory; this plugin does not promise it.
- `browser_download` fetches in the page context (keeps logins) and is subject to same-origin/CORS constraints; HTTP(S) targets only; `savePath` must be absolute (default confined to `~/Downloads`, override with `downloadDir`); single files are capped at 256 MB (streamed with a Content-Length early reject) and are written by the browser child itself (temp file + atomic rename).
- The self-hosted browser's cookies are stored in plaintext on disk (Electron default); deployments that need encrypted-at-rest should integrate a system keychain / DPAPI at the host layer.
- `browser_restrict` is a **soft guardrail** against accidental actions, not a security boundary: the model can lift it itself.
- Popups (`window.open` / `target=_blank`) are re-routed into the current tab instead of opening untracked native windows, so the tab/session model stays intact.
- The `browser_auth` cookie round-trip does not preserve `hostOnly`/`sameSite` (host-only cookies come back as domain cookies); it is available on the self-hosted browser only.
- After a self-hosted child crash the browser host restarts automatically, but sessions opened before the crash are gone — call `browser_reset_session` to rebuild.
- Electron 44+ downloads its binary (~100 MB) on the first window open and needs network; it is never needed again afterwards. If detection runs without network, pre-install a binary and point `ELECTRON_PATH` at it.
- This plugin contains no browser-column UI — that is host-shell territory; do not treat "browser column" as a plugin feature.

## Development

```sh
# Type-check + build (lib/)
npm run build
```

> Run tests: `npm test` (= `tsc -p tsconfig.json` + `node --test "tests/*.test.mjs"`; fake-host tests, no Electron needed).

Code layout:

| Directory | Responsibility |
| --- | --- |
| `src/browser/` | The `ctx.browser` seam and all request/result types |
| `src/browser-electron/` | Electron CDP provider, self-hosted child (`host-main.ts`), RPC layer |
| `src/tool-browser/` | Model-facing `browser_*` tools |
| `src/types/` | Electron ambient types (shim; no hard electron type dependency) |

## Update history

> Round-by-round development and fixes (full detail in [CHANGELOG.md](CHANGELOG.md)). Published as of **0.1.16** (tag `v0.1.16`).

| Round | Date | Content |
| --- | --- | --- |
| 1 | 2026-08-18 | **Security & robustness**: random-token RPC auth + single connection; download admission (HTTP(S) only, absolute path, `downloadDir`-confined) with streamed caps (Content-Length early reject, 256 MB max); CDP timeout interrupts and click/type timeout key-release recovery; per-task sessions/allow-lists with agent-lifecycle auto-close; history redaction (typed text, replay/execute args not leaked); popup re-routing into the tab |
| 2 | 2026-08 | **Feature completion + tests + CI**: window title shows the task; flicker-free showView; snapshots/a11y pierce same-origin iframes & Shadow DOM; new `browser_wait`/`scroll`/`back`/`forward`/`key` tools; real `available()` probe; child-side downloads (temp file + atomic rename); constrained Electron lookup; JPEG/scaled screenshots; snapshot perf; test suite + CI |
| 3 | 2026-08 | **browser-bridge parity + review fixes**: `browser_a11y` a11y tree; 6 form-control tools (`browser_set_value`/`check`/`select`/`clear`/`get_value`/`refresh`); semantic `target` (css/text/xpath); `browser_scrape` structured extraction; independent BrowserWindow + real toolbar (address bar, back/forward/reload, tab strip) routed back into the session model; tool count **20 → 33**; CI switched to npm (no lockfile → pnpm cache broken), README corrections |
| 4 | 2026-08 | **DSH 0.1.1-rc.2 alignment + review fixes**: peer floor `^0.1.1-rc.2`; fixed `browser_type` dropping text with a target, `browser_key` Space missing CDP `text`, keyUp failure sticking a key, `browser_wait` same-origin URL mis-match, `.part` rename residue, `snapshotMaxElements`/`contentMaxChars` config wiring, missing type exports; 3 regression tests |
| 5 | 2026-08 | **Electron 44 compatibility**: `available()` is now side-effect free (no more triggering Electron 44 lazy download); `flushAuth` cookie-domain build fix |
| 6 | 2026-08 | **Windows handshake & tab lookup**: the Electron GUI process never receives piped stdin → RPC token now flows over **stdin + env var**; `browser_switch_tab`/`browser_close_tab` locate tabs across sessions (`locateTab`), `browser_close_tab` no longer fakes success, unknown ids error with the session's actual tab list |
| 7 | 2026-08 | **Toolbar interaction (Windows focus routing)**: keyboard input only reaches the focused view and the page view grabbed it, so the address bar could not receive input → added `wireFocusRouting` (clicking a view focuses it) + window refocus restores the last-clicked view; verified with real OS input probes |
| **0.1.16** | 2026-08-26 | **Release**: all seven rounds ship as **0.1.16** (build clean, 21/21 tests pass, `v0.1.16`) |
| 8 | 2026-08-27 | **DSH Desktop host-Electron reuse**: running inside an Electron process reuses the host binary directly; when the host runs the plugin in a child Node process, walk the process ancestry to find the host's Electron (PowerShell CIM on Windows, last resort only) — **DSH Desktop works with zero install**; error now hints per active profile; electron shim completed to fix the CI typecheck; docs updated |
| **0.1.17** | 2026-08-27 | **Release**: round 8 ships as **0.1.17** (build clean, 21/21 tests pass) |

## Acknowledgements

Special thanks to the [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) and the DeepSeek AI team: the seam, the tool runtime, and the plugin system this plugin builds on all come from that project.

Thanks as well to [Cordis](https://github.com/cordiverse/cordis) for the plugin foundation, and to everyone in the community who discussed, tested, gave feedback, and built plugins.

## License

MIT License, see [LICENSE](LICENSE).

> This project is a community plugin for DeepSeek Harness, not an official DeepSeek product.
