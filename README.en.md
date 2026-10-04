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
| All 34 tools: parameters, output, examples | [Tool reference](docs/tool-reference.md) |
| How the seam / provider / tools layers and self-hosting work | [Architecture](docs/architecture.md) |
| Documentation index and README split | [Docs index](docs/README.md) |

## What is this

`dsh-builtin-browser` adds browser capability to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):

- **A real page, not a relay**: the page is carried by a **real browser** — on the desktop it is the one in the official sidebar, on plain `dsh web` it is a window the plugin launches, and either can be switched to an **installed Chrome / Edge** in settings. The human sees exactly what the agent is doing and can take over at any time;
- **One page for both parties** (desktop): the page the agent works on is the **same** page the human sees — no longer a window you cannot see;
- **Works out of the box**: the carrier is chosen automatically (the desktop sidebar first, otherwise self-hosting), and plain `dsh web` needs no extra configuration at all;
- **One plugin, one toolset**: after install the agent automatically gets 34 `browser_*` tools (open, a11y tree, wait, semantic/coordinate interaction, scroll, back/forward, batch and single-control form filling, keys, structured scraping, screenshot, download, auth management…).

In one sentence: **installing the plugin gives you a real browser that is shared with the user and drivable by the agent.**

## Quick start

Install the plugin into the profile of **the host you want to use**. Installing it on both is fine — one codebase, one copy per profile.

**Web (plain `dsh web`)**

```sh
# install from npm
dsh plugin --profile web add dsh-builtin-browser
# or from a checkout (one plugin, one repository)
dsh plugin --profile web add <path-to-this-repo>
```

**Desktop (DSH Desktop)**

```sh
# 1. install into the desktop profile
dsh plugin --profile desktop add dsh-builtin-browser

# 2. desktop-only step: let the plugin drive the official sidebar's page
node <path-to-this-repo>/desktop-bridge/install.mjs
```

> **Step 2 is not optional, and it comes back every time**: a desktop upgrade replaces `resources/app/`, and the bridge goes with it; a plugin update needs the same re-run. With no bridge the plugin falls back to opening its own separate window — nothing breaks, you just lose "one page for both parties". The web side has **no** such step.

**Updating** (the two hosts differ — see [Updating (the two hosts differ)](#updating-the-two-hosts-differ))

| Host | Steps |
| --- | --- |
| Web | update the profile dependency → restart `dsh web` |
| Desktop | update the dependency → **re-run `node desktop-bridge/install.mjs`** → restart DSH Desktop |

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
      <p><code>browser_snapshot</code> returns numbered interactive elements; <code>browser_execute</code> runs JS in the page (native setters + input/change events for controlled inputs), so React/Vue pages work reliably. <b>Semantic targeting comes first</b> — the whole page stays operable without any image input; under the <b>non-visual</b> strategy a coordinate click that depends on a screenshot is refused, with an instruction to use a semantic target instead.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Multi-tab sessions</h3>
      <p>Open URLs in parallel tabs; list/switch/close/reset tabs while each session keeps its own state. On the desktop <b>each session gets its own tab in the sidebar</b>, so ending one session does not disturb another.</p>
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
      <p><code>browser_restrict</code> limits which browser actions are allowed (allow-list) to prevent stray clicks/navigation; read-only tools (snapshot / a11y / content / scrape / screenshot / get_value / wait / challenge / list_tabs / session / history / visited) plus the "lift the restriction / reset the session" tools are always exempt.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Screenshot, save and read</h3>
      <p><code>browser_screenshot</code> supports <code>savePath</code> to write the PNG to disk, ready for vision models (modlens etc.) to locate elements visually.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Searchable browsing history</h3>
      <p><code>browser_visited</code> reads the <b>persistent</b> record of visited pages (stored beside the browser profile, so it survives closing the browser and restarting DSH), filterable by domain and reopenable. It is a different thing from <code>browser_history</code>, which is the session's operation log.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Synthetic cursor</h3>
      <p>While the agent works, a virtual pointer and click ripple are drawn inside the page, with a <b>bubble labelling the current action</b> beside the pointer — <b>its appearance means the agent has taken over that tab</b>. DOM-level actions (set value, check, select) also show a landing point. It never moves the real system pointer, and can be switched off in settings.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>A "Browser" section in Settings</h3>
      <p><b>Which browser</b> (bundled Electron / installed Chrome / installed Edge / automatic), keep history, auto-expand the side panel, close the browser when a session ends, show the cursor, vision strategy, allow credential reads — every one of these is <b>read fresh on each use</b>, so a change takes effect immediately with no restart. <b>Two exceptions</b>: <code>browser.channel</code> (which browser) and <code>cookies.persist</code> (keep cookies) are read once when the plugin is applied, so changing either needs a <b>plugin reload</b> (restart dsh / refresh the page). The section also carries a group of <b>"What the agent may do"</b> switches — <b>run scripts in the page</b>, <b>download files to disk</b>, <b>write login state</b>. They are not the same thing as <code>browser_restrict</code>: that one is the model's own soft guardrail and the model can lift it whenever it likes, while these live in the settings document, which <b>no tool can write</b> — the model can only be refused.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Unambiguous teardown</h3>
      <p><b>Closing the page that carries it ends that session</b> (the next open is a clean one) — on the desktop that means closing the sidebar's browser tab, on the web closing the window — while browsing history and login state survive. <b>Collapsing the interface is only a collapse</b>: the browser keeps running. Whether the browser is released automatically when a session ends is a setting.</p>
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
| `browser_snapshot` | Numbered inventory of interactive elements (inputs/buttons/links), each line carrying a `{#id}` / `{[name=x]}` selector when one is derivable (pierces same-origin iframes and Shadow DOM) | – |
| `browser_a11y` | Accessibility tree: semantic role/name/value/states per interactive node, plus a `{#id}` / `{[name=x]}` selector when derivable; coordinates only on request (`coords: true`, off by default, pierces same-origin iframes and Shadow DOM) | – |
| `browser_execute` | Run JS in the page; args arrive as `arguments[0..n]`. Governed by the "Run scripts in the page" switch — off refuses it outright (`BROWSER_EXECUTE_DISABLED`) | ✅ |
| `browser_visited` | Read the persistent browsing history (visited pages, filterable by domain / capped); reopen with `browser_open` | – |
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
| `browser_get_value` | Read an element's current value for verification (`target`-located) | – exempt |
| `browser_scrape` | Structured extraction: container selector + field map (`selector@attr`), static CSS only, CSP-safe | – exempt |
| `browser_screenshot` | Capture, optional `fullPage`, `savePath`, JPEG (`format`/`quality`) and scaling (`maxWidth`/`maxHeight`); `savePath` shares the download gate (confined to `downloadDir`, never overwrites) | – |
| `browser_list_tabs` | List the session's tabs | – |
| `browser_switch_tab` | Switch to a tab by id (also switches the visible view when self-hosted) | ✅ |
| `browser_close_tab` | Close a tab by id; closing the active tab activates the next | ✅ |
| `browser_reset` | Close all tabs of this task, back to one blank tab | – exempt |
| `browser_session` | Show this task's browser session and tabs | – |
| `browser_reset_session` | Close and rebuild this task's browser session | – exempt |
| `browser_history` | Operation log (newest last), with per-step success/error and result summary | – |
| `browser_replay` | Replay one step by sequence number (navigate/click/type/scroll/key/execute) | ✅ |
| `browser_download` | Download an HTTP(S) URL with session cookies to a local file (absolute `savePath` inside `downloadDir`, never overwrites, 256 MB cap). Governed by the "Download files to disk" switch (`BROWSER_DOWNLOAD_DISABLED`) | ✅ |
| `browser_auth` | Export/restore cookies (login persistence; **works on all three carriers** — self-hosted reads its own session, the sidebar and an installed browser go through CDP). Export is governed by the Credentials switch (`BROWSER_AUTH_DISABLED`) and writing by "Write login state" (`BROWSER_AUTH_WRITE_DISABLED`); the two are independent | ✅ |
| `browser_challenge` | Detect a human-verification challenge (CAPTCHA / Cloudflare / reCAPTCHA / hCaptcha / Turnstile) | – |
| `browser_restrict` | Restrict allowed browser actions (allow-list; empty list lifts it). **Soft guardrail** — the model can lift it itself; not a security boundary | – |

> "Guard" column: ✅ actions are governed by the `browser_restrict` allow-list; **rows marked "– exempt" are never blocked, whatever the allow-list says**, and **a plain "–" means the tool only observes — it performs no action, so there is nothing to restrict**. The exempt set is `READ_ONLY_TOOLS` (`src/tool-browser/index.ts`): `snapshot` / `a11y` / `content` / `scrape` / `screenshot` / `get_value` / `wait` / `challenge` / `list_tabs` / `session` / `history` / `visited`, plus `restrict` (the restriction itself must stay liftable, or a task that restricted everything could never get out), `reset_session` and `reset`. `browser_close_tab` is **not** exempt: like `open`/`click`/`switch_tab` it can be restricted; neither is `browser_auth`, whose `restore` writes cookies to arbitrary domains — an action, not an observation.

### Waiting for the page

- **`browser_open` and navigation already wait (bounded) for the new document to parse** (`readyState` plus a document fingerprint, so a same-URL reload or an A→B→A redirect is not mistaken for the old document), but they do **not** wait for async content: on slow sites or XHR-rendered pages, call `browser_wait` before `browser_snapshot` — pass `url` (what you opened) and an optional `selector`, and wait for `ready: true` — otherwise you snapshot the old document, a white screen, or an empty element list.
- **Content you cannot see may live in an iframe / Shadow DOM**: snapshots and the a11y tree pierce same-origin iframes and shadow roots and mark them `(iframe)`; coordinates are always top-document, so `browser_click` works directly. DOM selectors are frame-scoped — reach them via `iframe.contentDocument` in `browser_execute`.

### Semantic targets and the a11y tree

- **`browser_a11y` is the best way to understand a page**: every interactive node carries its semantic role (button/textbox/checkbox…), accessible name, current value and states (checked/expanded/required…) — it explains *what this is and what it does* better than a numbered snapshot. **150 nodes by default** (`maxNodes` 10-5000; ask for more explicitly), and **coordinates are no longer included by default** (pass `coords: true` when you actually need a pixel to click). Only the literal `enabled` is omitted from `states` (`unchecked`, `collapsed` and others are still printed) — no `states=` means the node is enabled. A node's `name` is exactly what `browser_click`/`browser_type` match when you target by `text`.
- **`browser_click`/`browser_type` accept a `target`**: `{by: css|text|xpath, value, index?}` — `text` matches an element's own visible text (exact first, then contains, deepest preferred); clicks scroll the element to the viewport center first; typing focuses it first.
- **Use the single-control tools for one field** (`browser_set_value`/`browser_check`/`browser_select`/`browser_clear`/`browser_get_value`), `browser_fill` for batches, and `browser_scrape` for structured list extraction.

### Operating discipline (locating/clicking/filling)

- **Semantics first, coordinates last**: `browser_a11y` gives roles and accessible names, `browser_snapshot` gives refs and coordinates, and **both carry a selector** (see the next section) — **use it when it exists**, because scrolling and layout changes do not invalidate it.
- **`browser_click`'s `target` (css/text) IS semantic location**; use it instead of computing coordinates yourself. Scrolling into view, clicking the centre, iframe offsets and device pixel ratio are all handled for you.
- **Prefer DOM semantics over coordinates**: submit forms with `form.requestSubmit()`; click with `element.click()`; coordinate clicks are the last resort.
- **Target the right element**: pages often have hidden duplicates (e.g. mobile buttons); filter visible elements with `browser_execute` (`getBoundingClientRect()` w/h > 0, `getComputedStyle` not `display:none`), then take coordinates.
- **Click right after taking coordinates**: do not insert other operations in between (filling/scrolling moves elements and invalidates old coordinates).
- **Verify before clicking**: use `document.elementFromPoint(x, y)` to confirm the coordinate hits the intended element (button/link), then perform the real click.
- **DPR awareness**: CDP input uses CSS pixels; on high-DPI screens calibrate with `elementFromPoint` instead of guessing coordinates.
- **Two failures of the same action means change the approach**: a different selector, a semantic target, or a fresh snapshot — not the same coordinate a third time.

### Vision strategy: know which one you are in first

The **`vision.strategy`** setting decides whether coordinate clicks are usable, and **that is the only thing it affects**:

| Strategy | Coordinate clicks | Suited to |
| --- | --- | --- |
| `auto` (default) | allowed | **A model that can read images** — screenshots are a valid way to check layout |
| `nonVisual` | **refused** | **A model with no image input** |

**Under `nonVisual` a coordinate click is refused outright**, reported as `BROWSER_NON_VISUAL_COORDINATES`, and the error names the fix: pass a semantic target, e.g. `target { by: "text", value: "Sign in" }`, which locates the element from the DOM and clicks its centre. **That is a configuration, not a failure — do not retry the same coordinate.**

**DOM queries, the accessibility tree, text extraction and structured scraping are identical under both strategies** — that is, **the page can be operated completely without image input**. So the "when not to screenshot" advice below is the default for **every** model, not a concession to the ones that cannot see.

### When NOT to take a screenshot

Tool output is spent out of the caller's context, and **a screenshot is the most expensive kind**:

- **If text will do, use text.** `browser_snapshot` / `browser_a11y` / `browser_content` carry the same page as text; **a model without image input gains nothing from a screenshot** and only pays for it. Keep screenshots for what genuinely needs pixels: layout, charts, design checks.
- **A downscaled capture returns `width`/`height`** (the real pixel size). When you use `maxWidth`/`maxHeight` to control cost, read those to confirm it took effect rather than decoding the data URL yourself.

### The operator's three switches, which no tool can change

**Running page scripts**, **downloading to disk** and **writing login state** are controlled by the operator in the settings page, and **no `browser_*` tool can change them**. When one is off the error code is unambiguous — **do not retry and do not route around it**; say that the human needs to enable it:

`BROWSER_EXECUTE_DISABLED` (scripts), `BROWSER_DOWNLOAD_DISABLED` (downloads), `BROWSER_AUTH_WRITE_DISABLED` (writing login state), `BROWSER_AUTH_DISABLED` (reading cookies).

Do not confuse those with `BROWSER_DOWNLOAD_BLOCKED` / `BROWSER_SCREENSHOT_BLOCKED`, which mean **the save path was refused by the sandbox** (change the path, not a setting), or `BROWSER_DOWNLOAD_UNSUPPORTED`, which means **this carrier has no such capability**.

**`browser_restrict` is different** — it is a temporary allow-list the model sets and lifts itself, and **it is not a way around the three switches above**.

### Output size and truncation

Tool output is spent out of the caller's context, so several results have explicit bounds — and a truncation is always stated:

- **Snapshots and the a11y tree hand you a selector**: when an element has an `id` or a `name`, its line ends with `{#id}` / `{[name=x]}`, usable directly as `browser_click`/`browser_type`'s `target {by: "css", value: "#id"}` — no guessing at text from an accessible name. Elements with neither carry no selector segment: the tool does not invent one it cannot derive.
- **`browser_content` caps are per format (defaults)**: **html 50 000, json 50 000, txt 20 000, markdown 20 000 characters**; override per call with `maxChars`. When the result is truncated, the notice says what to do about it; `selector` narrows the fetch to one region first.
- **`browser_content` with `json` returns the element's markup**: `{"html": "<element outerHTML>", "tag": "<tag name>"}`, not an empty object — a DOM node has no own enumerable properties, so `JSON.stringify` on one yields `{}` for every element.
- **`browser_execute` caps its return value at 50 000 characters**, and states the cut in the result ("truncated at 50 000 of N") so a shortened value is never silently short.
- **`browser_scrape` returns compact JSON** (no indentation) with the item count in front — indentation carries nothing a model can use and measured over a tenth of the output.
- **`browser_history` shows the last 20 operations and omits each operation's parameters** (they are what you just sent), leading with the total so a tail is not mistaken for the whole; pass `verbose: true` when you actually want the parameters.
- **`browser_visited` timestamps are minute-granular**, and the session tag prints only when it changes, shortened to 8 characters — not a full session id per row.

## Configuration

The plugin mounts through `cordis.patch.yml` (**four rows**): one **inert root row** (it exists only to name the package, because the host's client-module scan reads a row's `dsh.client` only when that row resolves to an **exact package name** — a row named after a subpath is skipped entirely, and then the settings panel would never appear) plus three functional rows (`browser` / `browser-electron` / `tool-browser`). Per-row config:

| Row | Key | Type | Default | Description |
| --- | --- | --- | --- | --- |
| `browser-electron` | `viewHost` | object | optional | `ElectronBrowserViewHost` instance supplied by the host (typically `!!js ctx.get('electronViewHost')`). **When it is absent the plugin picks the carrier itself** — the desktop sidebar if that is where it runs, otherwise self-hosting; a browser chosen in settings outranks both |
| `browser-electron` | `httpOnly` | boolean | `true` | Allow HTTP(S) navigation only; other protocols (e.g. `file:`/`data:`) rejected (`BROWSER_NAVIGATION_BLOCKED`) |
| `browser-electron` | `snapshotMaxElements` | number | `60` | Max snapshot elements before truncation |
| `browser-electron` | `contentMaxChars` | number | unset (per-format defaults) | The default content character cap. **Unset**, the caps are per format (html 50 000, json 50 000, txt 20 000, markdown 20 000); **set**, it is the operator's value and overrides them. A call's own `maxChars` outranks both |
| `browser-electron` | `downloadDir` | string | system Downloads folder (`Downloads`/`下载`/`下載`, or `XDG_DOWNLOAD_DIR`, auto-detected) | Confine `browser_download` AND `browser_screenshot` save paths to this directory, never overwriting an existing file (stops a prompt-injected agent writing or replacing arbitrary paths); override for a sandbox dir |
| `tool-browser` | `timeoutMs` | number | `60000` | Cooperative tool timeout (ms) |
| `tool-browser` | `tabTools` | boolean | `true` | Register tab-management tools (`browser_list_tabs` etc.) |
| `tool-browser` | `allowedActions` | string[] | unrestricted | **Deployment-level** action allow-list, applied to every task in the deployment (a task can still narrow it further with `browser_restrict`); `READ_ONLY_TOOLS` and `browser_restrict` are never blocked, whatever the list says. `cordis.patch.yml` ships an empty `config: {}` (i.e. unrestricted); its comments show how to tighten it |

## How it works

```
agent (browser_* tools)
  → ctx.browser (seam, dsh-builtin-browser/browser)
  → dsh-builtin-browser/browser-electron (provider)
  → ElectronBrowserViewHost  ← the same seam, implemented once per carrier
      ① desktop sidebar       via bridge → shell main process → webContents.debugger (CDP)
      ② installed Chrome/Edge via WebSocket → CDP
      ③ self-hosted Electron  via loopback TCP JSON-RPC → child process → CDP
```

- **Seam** (`browser` row): provides the `ctx.browser` service — provider registration, session lifecycle, error codes — decoupled from any implementation.
- **Provider** (`browser-electron` row): knows only the one `ElectronBrowserViewHost` seam (create/destroy/show, `sendCommand`), so **switching carrier touches neither the tools, nor the history, nor the cursor, nor the teardown logic**.
- **Tools** (`tool-browser` row): the 34 model-facing `browser_*` tools, maintaining one browser session per calling task (DSH session).

**Self-hosted mode**: without a desktop shell, the plugin spawns its own Electron child process (`host-main.js`) and drives it over loopback TCP JSON-RPC. The RPC is authenticated with a random per-spawn token delivered over **both stdin and an environment variable** — on Windows the Electron GUI process never receives piped stdin, so the env fallback keeps the handshake reliable. The child auto-restarts after a crash; the plugin prefers its own bundled electron package — packaged app executables (e.g. DSH Desktop.exe) are never reused as the spawnable binary, which would launch the app itself and exit immediately; screenshots prefer Electron's native `capturePage` (CDP capture can hang with multiple views in the window); the Electron lookup order follows below (33.x has a compositor defect; ≥ 40 recommended; the electron 44+ package no longer downloads its binary at install time — if it is missing on first use, the tool errors and tells you to run `npx install-electron` first, needs network).

**The self-hosted browser IS a real browser**: every task (DSH session) gets its **own browser window** with a full toolbar — address bar, back/forward/reload buttons, and a tab strip (new/switch/close tabs). A human can use it exactly like Chrome: type a URL in the address bar (https:// is added automatically), click tabs, open new ones. Keyboard focus follows your clicks — **click the address bar to type, click the page to interact** (Windows focus routing; fixes the case where clicks did not move focus and the address bar could not receive typed URLs). Human and agent actions feed the **same session model** (same tabs, history, and navigation); the window title always shows the task label plus the page title/URL, and views follow the window size on resize. A window closes automatically with its session when the task ends.

**Electron lookup order**: ① `ELECTRON_PATH` (explicit override, wins first) → ② the electron package bundled with the plugin (filesystem-only probe, never triggers the 44+ lazy download; covers both node_modules and pnpm-store layouts) → ③ the newest among DSH install anchors and pnpm virtual stores → ④ reuse the host binary when the current process is a **bare** Electron (dev mode) → ⑤ walk the process ancestry for a **bare** Electron host (PowerShell CIM on Windows, last resort only). **Packaged apps (e.g. `DSH Desktop.exe`) are never reused** — they cannot be spawned with a script argument, and misusing them exits instantly (issue #6); when nothing is found a clear error tells you what to do (including the `npx install-electron` hint).

## Division of labor with the desktop shell

The plugin picks a carrier automatically, and the setting can override it (four in total):

**① Desktop: drive the official sidebar's page (one page for both parties)**

DSH Desktop is two layers: an Electron shell plus an `--expose-internals` **Node-mode host** (the plugin runs there, with **no Electron API**). 0.2 removed `electronViewHost`, and the host/shell event set carries nothing view-related either — so the plugin borrows a **small bridge**: a loopback + token service inside the shell's main process hands the plugin CDP access to the sidebar browser's guest, i.e. the very page you see on screen.

The result: **the page the agent works on is the page the human looks at**. The plugin no longer spawns its own Electron and no second window appears.

Install that bridge (it modifies an **installed** desktop app, so it is replayable):

```bash
node desktop-bridge/install.mjs            # idempotent; backs up main.js.before-bridge on first run
node desktop-bridge/install.mjs --revert   # roll back
```

> **Re-run `install.mjs` after every desktop upgrade** — the upgrade replaces `resources/app/` and takes the bridge with it. With no bridge the plugin falls back to self-hosting: nothing breaks, you just get a separate window again.

> **⚠️ What the sandbox boundary change means**
>
> The official sidebar browser is built on the premise that its pages are **not readable from outside** — it uses a separate partition and the shell refuses cross-site content access. Letting the agent drive that guest **deliberately breaks that premise**:
>
> - the agent can read the content of **any page you open in the sidebar** (that is precisely what "one page for both parties" means);
> - the agent can read the **cookies and login state** in that partition, and `browser_auth` can export them (controlled by a setting);
> - your actions in the sidebar and the agent's actions act on **the same page** and can affect each other (the agent will not overwrite what you are typing, but navigation changes what you both see).
>
> That is the inherent cost of one shared page. We think it is worth it — it turns "the agent is doing something in a window you cannot see" into "you can watch it work and take over" — but you are entitled to know it exists, so there are switches: with **credential access** off, `browser_auth` **refuses the export** (`BROWSER_AUTH_DISABLED`) — it governs reading only, while writing login state (restore) answers to its own switch and reports `BROWSER_AUTH_WRITE_DISABLED`; and with the **vision strategy** set to non-visual any coordinate click that depends on a screenshot is refused. If you would rather not accept the boundary change at all, removing the plugin from the desktop profile returns you to the old separate-window shape.

**② Use the browser you already have (Chrome / Edge)**

The settings panel can point the plugin at an **installed Chrome or Edge** (`browser.channel`: `bundled` / `auto` / `chrome` / `edge`). The approach is the same one Codex Browser Use takes: launch it with `--remote-debugging-port=0`, read the port it writes into `DevToolsActivePort`, and drive it entirely over CDP (through Node 22's built-in `WebSocket` — **no new dependency**).

**Your data is not touched**: the plugin launches it with a **separate profile** (`$DSH_HOME/dsh-builtin-browser-host/<chrome|edge>-profile`). Your everyday windows, bookmarks and logins are never opened, locked or modified, and closing the plugin never closes your browser.

**It comes back usable after it dies**: this carrier watches its child's exit and drops the **stale session mappings** along with the cached connection, so the restarted browser can actually be driven instead of answering every command with "Session not found". Before relaunching it kills the old process and **waits up to 3 seconds** for it to really exit (on Windows `kill` is asynchronous, and spawning immediately let the replacement hand its command line to the old instance and exit — which was then reported as "check that the path is a runnable browser"), and it **deletes the previous launch's `DevToolsActivePort` and trusts only a file written after this spawn** (otherwise it connects to whatever else holds that port — another Chromium, or a `node --inspect` — and publishes a client it does not own and can never kill). Conversely, **a slow page is not a dead browser**: a command **timeout** only marks the connection suspect, and the next call probes it once with `Browser.getVersion` before deciding to drop it; only a **closed socket** restarts the browser. One slow page therefore cannot make the plugin kill the window you are using, tabs and half-filled forms included.

**What happens to login state**:

- `cookies.persist` **on** (default) → that fixed profile is kept, so **you stay signed in across DSH restarts**, and `browser_auth` can still export/restore its cookies.
- `cookies.persist` **off** → a **throwaway profile** each time, deleted when the browser is released; no login trace is left behind. A process killed outright never reaches that release path, so the next start **sweeps** the throwaway profiles an earlier run left behind — only those whose owner is gone AND which have not been written to for an hour, so the profile an orphaned browser is still working in is left alone.
- The trade-off, stated plainly: a separate profile **does not see** the sites you are signed into in your everyday browser. Sign in once in the window the plugin opens and the session stays in its own profile.

**③ A shell that provides `electronViewHost`** (older desktop shells): that view is used directly.

**④ No shell at all (plain `dsh web`)**: self-hosted — the plugin spawns the Electron it ships.

> The visible view and column layout always belong to the host shell; the plugin owns the seam, the provider and the tools. Across all carriers the **toolset, browsing history, settings panel, synthetic cursor and teardown rules are identical** — only the carrier of the page differs.
>
> **Precedence**: an explicitly chosen installed browser > the desktop sidebar > self-hosting. A missing carrier is handled two different ways: `automatic` means "any browser will do", so it **logs a warning and keeps the bundled one**; but when you **named a browser explicitly** and it is absent, the plugin no longer settles for a log line — it adopts a carrier whose only job is to explain, so **every command reports to the caller which browser was missing, the names and locations that were searched, and three ways out**. You are not left staring at an Electron error wondering what actually went wrong.

## Requirements

- DeepSeek Harness (dsh) with the matching profile (`web` / `desktop`, etc.)
- **Electron runtime** (required dependency, installed automatically with the plugin, ≥ 40 recommended; the 44+ binary is not downloaded at install time — if missing, follow the error and run `npx install-electron` first, needs network) — **only the self-hosted carrier needs it**:
  - `ELECTRON_PATH` can point at another binary explicitly (highest priority);
  - **DSH Desktop**: the official sidebar by default, so **no Electron is needed**; the bundled electron is used only when it falls back to self-hosting. The packaged host exe (`DSH Desktop.exe`) is **never reused** — packaged apps cannot be spawned with a script argument and misuse exits instantly (issue #6); dev-mode **bare** Electron hosts are still reusable;
  - **an installed Chrome / Edge needs no Electron either**;
  - **plain `dsh web` self-hosted**: uses the bundled electron package directly

### Verified versions

| Component | Version |
| --- | --- |
| DeepSeek Harness (dsh) | `0.2.1-alpha.1` (peer range `>=0.1.1-rc.2 <0.3.0`; `0.2.0-rc.2` and `0.1.x` were verified earlier) |
| Electron | `44.0.0` (≥ 40 recommended; 33.x has a compositor defect) |
| Node.js | `22.20.0` |
| Installed Chrome / Edge (optional carriers) | `154.0.8037.58` / `154.0.4258.37` |
| dsh-builtin-browser | `0.4.3` (unreleased, on the development branch) |
| OS | Windows 10 (10.0.26200) |

> The plugin declares `electron >= 30`. The **core path is fully verified on Windows**; system-browser detection is now adapted for Linux and macOS (PATH first, then each platform's conventional install locations, all overridable with `DSH_BROWSER_CHROME_PATH` / `DSH_BROWSER_EDGE_PATH`), but the end-to-end path on those platforms has not been measured, so no promise is made yet.

> **Re-verify host compatibility at any time**: `node scripts/verify-host-compat.mjs` assembles a host out
> of the `@deepseek-ai/*` packages **actually installed** in a profile, loads this plugin's compiled
> output, registers its tools through the host's own `defineTool`, and calls two of them over a fake
> provider (`browser_session` / `browser_a11y`). It answers "did a DSH upgrade break us?" without starting
> a browser. It reads the profiles under `$DSH_HOME/profiles`; `DSH_PROFILE` / `DSH_HOME` override that.
>
> **On semver and prereleases**: the range `>=0.1.1-rc.2 <0.3.0` matches no prerelease-tagged version
> (such as `0.2.1-alpha.1`) under **default semver semantics** — that is by specification, where a
> prerelease is only admitted by a comparator carrying the same major.minor.patch tuple. DSH evaluates
> plugin compatibility with `includePrerelease: true`
> (`packages/boot/app-boot/src/plugin-compatibility.ts`), so those hosts are in range in practice; if
> some external tool reads "incompatible" under default semantics, that is its rule differing from DSH's,
> not a wrong claim here.

## Updating (the two hosts differ)

The plugin has one installation per host, and the two are updated separately — **updating one does not update the other**.

**Desktop (DSH Desktop)**
- The plugin is a dependency of the desktop profile (usually `$DSH_HOME/profiles/desktop`). Updating means moving that dependency to the new version and then **restarting DSH Desktop**, which is when the settings panel and the tools pick up the new code.
- **The desktop has one extra step, which the web does not**: the bridge that lets the plugin drive the sidebar lives in the **desktop app's own install directory** (`resources/app/`), and a plugin update does **not** carry it along. A desktop upgrade replaces that directory and takes the bridge with it, so re-run it once:
  ```bash
  node desktop-bridge/install.mjs            # idempotent; refreshes the module if already installed
  node desktop-bridge/install.mjs --revert   # roll back
  ```
  With no bridge the plugin falls back to self-hosting (one extra separate window) — nothing breaks, the tools stay available.
- The browser engine comes from the desktop app's own Electron by default, and the plugin never downloads a second copy; you can also point it at an installed Chrome / Edge in settings.
- **What happens when the browser you picked is not installed**: `bundled` uses its own Electron; `automatic` picks an installed one and **quietly falls back to bundled if there is none**; but an **explicit `chrome` / `edge` choice that is missing fails with a message saying so** — it lists the names and locations that were checked and offers three ways out (install it / point `DSH_BROWSER_CHROME_PATH` or `DSH_BROWSER_EDGE_PATH` at it / set the carrier back to `bundled` or `automatic`). You are never left guessing from an error about Electron.
- Upgrading the desktop app itself does not carry the plugin along; update it as described above.

**Web (`dsh web`)**
- The plugin is a dependency of the web profile (`$DSH_HOME/profiles/web`); **restart `dsh web`** after updating.
- There is no desktop shell, so the shared browser is self-hosted by the plugin: the first install may need an Electron binary. If the package manager's build allow-list blocked it (pnpm v10+ blocks `electron`'s postinstall), run `npx install-electron` once to fetch it.
- It can equally be pointed at an installed Chrome / Edge in settings — an option that behaves the **same on both hosts**.
- Update it the same way you installed it (npm package `dsh-builtin-browser`, the GitHub repo `wqty123/dsh-browser`, or a local directory).

**What is the same on both**
- The toolset (34 `browser_*` tools), the "Browser" section in Settings, and how browsing history and cookies persist are identical; only the carrier of the page differs (the official sidebar on the desktop, the plugin's own self-hosted window on the web, or an installed browser you picked in settings).
- Upgrading loses no data: history and settings live in `$DSH_HOME/dsh-builtin-browser-host/` (`history.jsonl`, `settings.json`), and login state sits in the same profile directory — including the `<chrome|edge>-profile` used for an installed browser.
- If history behaves unexpectedly after an upgrade, check **Settings → Browser**: history defaults to **on**, one-time auto-expand defaults to **on**, closing the browser when a session ends defaults to **off**, and the carrier defaults to **bundled**.

## Known limitations

- JPEG screenshots work on the **self-hosted** carrier and with an **installed Chrome / Edge**. The **desktop sidebar** goes through the shell's `webContents.debugger`, whose Electron CDP JPEG encoder hangs, so a JPEG request on that carrier returns PNG. Downscaling (`maxWidth`/`maxHeight`) **works on all three** — through a CDP `clip.scale`, or the native `capturePage` when self-hosted.
- Self-hosted captures prefer Electron's native `capturePage` (CDP `captureScreenshot` can hang with multiple views in the window); the target tab is raised before capturing.
- `fullPage` capture is flaky under software compositing on some hosts — with `fullPage` the native `capturePage` path is **skipped entirely** (`capturePage` cannot reach content beyond the viewport), so **all three carriers go through CDP `captureBeyondViewport`** and the flakiness is not carrier-specific: any carrier can hit it. Only viewport captures prefer the native `capturePage`.
- CAPTCHA cannot be solved automatically: snapshots flag detected challenges; ask the human to complete it in the shared window instead of retrying.
- Private mode (`privateMode`) is not implemented: it needs Electron session partitioning, which is host-layer territory; this plugin does not promise it.
- A settings document that **exists but cannot be read** (corrupt JSON, a half-written file, unreadable permissions) resolves the four **gate** switches (`credentials.allowRead` plus the three action switches) to **off**, with every other setting at its default — "the operator's intent cannot be read" is not "the operator permits everything". A file that is simply **absent** (first run) still takes the defaults. A gate field of the wrong type (`"false"` as a string, `null`, a number) reads as **off** as well, and so does a **gate-holding section** written as a non-object (`actions: false`, `null`, a stray string): such a section is read as unreadable rather than as absent, so every gate inside it is **off** instead of taking its permissive default.
- `browser_download` fetches in the page context (keeps logins) and is subject to same-origin/CORS constraints; HTTP(S) targets only; `savePath` must be absolute and inside `downloadDir` (default: the system Downloads folder, auto-detecting `Downloads`/`下载`/`下載` and `XDG_DOWNLOAD_DIR`; override with `downloadDir`) and never replaces an existing file; `browser_screenshot`'s `savePath` goes through the same gate; single files are capped at 256 MB (streamed with a Content-Length early reject) and are written by the browser child itself (temp file + atomic rename). Admission also resolves where a path really lands: a symlink inside `downloadDir` cannot carry the write out of it, and a dangling link is refused too (it reads as a name already taken, not as a free path).
- The self-hosted browser's cookies are stored in plaintext on disk (Electron default); deployments that need encrypted-at-rest should integrate a system keychain / DPAPI at the host layer.
- `browser_restrict` is a **soft guardrail** against accidental actions, not a security boundary: the model can lift it itself. For a limit the model cannot remove with a tool, use the three action switches in Settings ("What the agent may do") — they live in the settings document, which no `browser_*` tool writes — or the deployment-level `tool-browser` config `allowedActions` (see the comments in `cordis.patch.yml`). **Be precise about that boundary**: settings travel over a local HTTP endpoint whose writes require a same-origin `Origin` (so a bare HTTP client cannot write them), but a **same-origin page still can** — that is inherent to exposing an endpoint at all, and it is **not a credential system**. The panel's own text says exactly this, and it is worth reading as what it is rather than as a lock.
- Popups (`window.open` / `target=_blank`) no longer overwrite the current view: HTTP(S) popups open as a **new tab** in the same session window, recorded in the session history, keeping the original page and its opener context alive. Non-HTTP(S) popups (empty-URL popup handoffs, `mailto:`, custom schemes) are still **allowed as native windows** and handed to the system — such windows are simply not part of the session model.
- The `browser_auth` cookie round-trip does not preserve `hostOnly`/`sameSite` (host-only cookies come back as domain cookies). It **works on all three carriers**: self-hosted reads its own session, while the sidebar and an installed Chrome/Edge go through CDP's `Network.getCookies` / `Storage.setCookies`. **`flush` exports only the cookies of the site the current page is on**, not the machine-wide shared jar — the export is scoped to the URL of the page this session is sitting on, and when that URL is unknown the tool **refuses rather than widening** (the self-hosted sidebar path reports that the cookie scope is unknown; the CDP path raises `BROWSER_AUTH_SCOPE_UNKNOWN`). `browser_auth` **is subject to the `browser_restrict` allow-list** too, because `restore` is an action that writes cookies to arbitrary domains.
- After a self-hosted child crash (or a DSH restart that kills it) the browser host restarts automatically, and sessions opened before the crash **rebuild on their next use** — only page state is lost, no manual `browser_reset_session` needed (it still works for an explicit reset). A new view preloads `about:blank` (bounded 3 s) before creation so it always has a live renderer, and host-side commands are bounded at 20 s. The child's stderr plus exit code/signal go to `$DSH_HOME/logs/dsh-builtin-browser-host.log`; before appending, a file already over 2 MiB is **truncated: the old contents are discarded and replaced by a single timestamped rotation line** (`<ISO timestamp> log rotated: previous content exceeded 2097152 bytes and was discarded`). Nothing is kept from before the rotation — but that line records that it happened, so a plain `dsh web` self-hosted setup can still diagnose a crash loop itself.
- The electron package ships with the plugin, but Electron 44+ no longer downloads its binary at install time (~100 MB, needs network) — the probe is filesystem-only and never triggers its lazy download, so a missing binary surfaces as a clear error on first use telling you to run `npx install-electron` first; alternatively pre-install a binary and point `ELECTRON_PATH` at it.
- This plugin draws **no browser interface of its own** (no address bar, no tab strip, no side panel): on the desktop that interface is the **shell's own official sidebar**, and the plugin merely drives the page inside it. On the self-hosted carrier the window is drawn by the Electron child the plugin spawns — that is the carrier, not plugin UI. Do not treat "the sidebar" or "browser column" as a plugin feature.
- **The sidebar carrier does not report user-action events**: a human clicking in that page is the shell's own event, and the bridge has no operation that reports it. Features relying on that event therefore do not fire on the desktop sidebar; they do on the self-hosted carrier.
- **An installed Chrome / Edge runs with a plugin-owned profile**: it is launched with its own user-data directory (`$DSH_HOME/dsh-builtin-browser-host/<chrome|edge>-profile`), so your everyday bookmarks, extensions and logins are **not carried over**. That is deliberate — plugin activity stays out of your personal session — and whether login state survives a restart is decided by `cookies.persist`.

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
| `src/browser-electron/` | The provider and its three carriers — the desktop sidebar bridge (`desktop-bridge-host.ts`), an installed browser (`system-browser.ts`), the self-hosted child (`host-main.ts`); plus the transport (`bridge-connection.ts`) and the RPC operation vocabulary (`rpc-ops.ts`), settings, history and the synthetic cursor |
| `src/tool-browser/` | Model-facing `browser_*` tools; the element/node field set (`element-fields.ts`), where the item schema and the projection come from one declaration |
| `src/types/` | Electron ambient types (shim; no hard electron type dependency) |
| `desktop-bridge/` | The bridge installed into the desktop app, with its idempotent installer (`install.mjs`) |
| `tools/` | Operational scripts (e.g. `install-web-plugin.mjs`: pin → install → repair the profile → verify) |

## Update history

> Round-by-round development and fixes (full detail in [CHANGELOG.md](CHANGELOG.md)). Published as of **0.1.16** (tag `v0.1.16`).

| Round | Date | Content |
| --- | --- | --- |
| 1 | 2026-08-18 | **Security & robustness**: random-token RPC auth + single connection; download admission (HTTP(S) only, absolute path, `downloadDir`-confined) with streamed caps (Content-Length early reject, 256 MB max); CDP timeout interrupts and click/type timeout key-release recovery; per-task sessions/allow-lists with agent-lifecycle auto-close; history redaction (typed text, replay/execute args not leaked); popup re-routing into the tab |
| 2 | 2026-08 | **Feature completion + tests + CI**: window title shows the task; flicker-free showView; snapshots/a11y pierce same-origin iframes & Shadow DOM; new `browser_wait`/`scroll`/`back`/`forward`/`key` tools; real `available()` probe; child-side downloads (temp file + atomic rename); constrained Electron lookup; JPEG/scaled screenshots; snapshot perf; test suite + CI |
| 3 | 2026-08 | **browser-bridge parity + review fixes**: `browser_a11y` a11y tree; 6 form-control tools (`browser_set_value`/`check`/`select`/`clear`/`get_value`/`refresh`); semantic `target` (css/text/xpath); `browser_scrape` structured extraction; independent BrowserWindow + real toolbar (address bar, back/forward/reload, tab strip) routed back into the session model; tool count **20 → 33**; CI switched to npm (no lockfile → pnpm cache broken), README corrections |
| 4 | 2026-08 | **DSH 0.1.1-rc.2 alignment + review fixes**: peer floor `^0.1.1-rc.2`; fixed `browser_type` dropping text with a target, `browser_key` Space missing CDP `text`, keyUp failure sticking a key, `browser_wait` same-origin URL mis-match, `.part` rename residue, `snapshotMaxElements`/`contentMaxChars` config wiring, missing type exports; 3 regression tests |
| 5 | 2026-08 | **Electron 44 compatibility**: `available()` is now side-effect free (no more triggering Electron 44 lazy download); `flushAuth` cookie-domain build fix |
| 6 | 2026-08 | **Windows handshake & tab lookup**: the Electron GUI process never receives piped stdin → RPC token now flows over **stdin + env var**; `browser_switch_tab`/`browser_close_tab` locate tabs (`locateTab`), `browser_close_tab` no longer fakes success, unknown ids error with the session's actual tab list. That round fell back to searching **every** session; it was tightened later — lookup is now **confined to the calling session** (a stale id must not close or switch another task's tab, or the human's), keeping only the convenience of accepting a bare uuid as well as `tab:<uuid>` |
| 7 | 2026-08 | **Toolbar interaction (Windows focus routing)**: keyboard input only reaches the focused view and the page view grabbed it, so the address bar could not receive input → added `wireFocusRouting` (clicking a view focuses it) + window refocus restores the last-clicked view; verified with real OS input probes |
| **0.1.16** | 2026-08-26 | **Release**: all seven rounds ship as **0.1.16** (build clean, 21/21 tests pass, `v0.1.16`) |
| 8 | 2026-08-27 | **DSH Desktop host-Electron reuse**: running inside an Electron process reuses the host binary directly; when the host runs the plugin in a child Node process, walk the process ancestry to find the host's Electron (PowerShell CIM on Windows, last resort only) — **DSH Desktop works with zero install**; error now hints per active profile; electron shim completed to fix the CI typecheck; docs updated |
| **0.1.17** | 2026-08-27 | **Release**: round 8 ships as **0.1.17** (build clean, 21/21 tests pass) |
| 9 | 2026-08-27 | **electron becomes a required dependency**: moved from optional peer into `dependencies`, so installing the plugin brings the electron package automatically (44+ downloads its binary lazily on first use); DSH Desktop still reuses the host binary; docs and error message updated |
| **0.1.18** | 2026-08-27 | **Release**: round 9 (electron as a required dependency) ships as **0.1.18** (build clean, 21/21 tests pass) |
| 10 | 2026-08-27 | **DSH-Store compatibility declaration**: added `dsh.compatibility.dshReleases` (rc.2/rc.1=compatible, rc.8=unknown) plus profiles/dsh range, clearing the store's auto-unlisting (HOLD) |
| **0.1.19** | 2026-08-27 | **Release**: round 10 (DSH-Store compatibility declaration) ships as **0.1.19** (build clean, 21/21 tests pass) |
| 11 | 2026-08-27 | **Self-hosted session self-healing after host death** (issue #5): after the host dies (DSH restart / checkpoint restore / crash), already-open sessions rebuild the host and retry on their **next call** — no more "browser host is not running", no more half-dead state; host-gone logging + a fake-child regression test added |
| 12 | 2026-08-27 | **resolveElectronPath excludes packaged apps** (issue #6): added `isBareElectron` (a sibling `app.asar` means packaged — never reused, all platforms incl. macOS bundle layout); bundled-electron filesystem probe goes first; `ELECTRON_PATH` override wins first; missing dist errors clearly (`npx install-electron` hint) |
| Hardening | 2026-08-27 | **Three review passes hardened**: concurrent-recovery double-rebuild race (child `createView` made idempotent), macOS bundle-path detection, `dispose()` vs `start()` zombie-child race triple-guard, pendingSocket leak, fully unit-tested lookup order (24→25 tests) |
| **0.1.20** | 2026-08-28 | **Release**: rounds 11/12 + hardening ship as **0.1.20** (build clean, 25/25 tests pass) |
| 13 | 2026-08-28 | **macOS/Linux untypeable inputs fix** (issue #7): the Windows focus routing from 0.1.16 (mousedown force-focus + window-refocus restore) shipped without a platform guard and fought macOS native click-to-focus, leaving login inputs untypeable → both handlers are now gated to `win32`; non-Windows restores native behavior |
| 14 | 2026-08-28 | **window.open/target=_blank opens a new tab** (issue #8): HTTP(S) popups no longer loadURL over the current view; they are handed to the parent and open as a **new tab in the same session window** — the opener page and its context survive (portal "workspace" jumps no longer 403) and the jump lands in session history; ungrouped views keep the fallback; non-HTTP popups still go to the system |
| **0.1.21** | 2026-09-02 | **Release**: rounds 13/14 ship as **0.1.21** (build clean, 25/25 tests pass) |
| macOS binary probe | 2026-09-09 | **Electron.app layout detection** (issues #9 / #14): `electronDistExe()` only probed `dist/electron(.exe)`, so macOS's `dist/Electron.app/Contents/MacOS/Electron` was never found → darwin candidate added to the shared platform probe (bundled + profile/anchor layers both benefit); regression test added |
| 15 | 2026-09-16 | **Toolbar parse-time SyntaxError** (issue #11): the inline script's `const bridge = window.bridge` collided with the non-configurable global installed by `contextBridge.exposeInMainWorld` (`HasRestrictedGlobalProperty`) → a **parse-time** early error, so not one line ran and the address bar, the four nav buttons, the tab strip and the error bar were all dead → the whole script is wrapped in an IIFE and the handle renamed `tb`, making the class of collision structurally impossible; 3 toolbar regression tests parse the snippets out of the **published artifact** and execute them in a `vm` under contextBridge semantics |
| 16 | 2026-09-16 | **Self-hosted trio fixes** (issue #10): (1) `browser_open` waits (bounded 5 s) for the new document to settle via a `performance.timeOrigin` fingerprint + `readyState`, so it no longer returns a titled-but-empty snapshot; (2) a new waiting `presentView` barrier (materialize the view, then showView, then a ping barrier; child dispatch is strictly serial) is required before `click`/`type`/`key` dispatch `Input.*`, which now fail loudly with `BROWSER_VIEW_NOT_PRESENTED` instead of faking success; (3) `createView` preloads `about:blank` (bounded 3 s) so a fresh view always has a live renderer (the step that wedged after a host restart); (4) `did-navigate` forces re-presentation, host commands are bounded at 20 s, child stderr plus exit code/signal go to `$DSH_HOME/logs/dsh-builtin-browser-host.log` (2 MB self-truncating), and `locateTab` accepts a bare uuid as well as `tab:<uuid>` |
| 17 | 2026-09-16 | **Screenshot savePath confined + localized download dir** (issue #13): `browser_screenshot` wrote straight to `writeFileSync` — anywhere the process could reach, silently replacing existing files (bypassing the read-only sandbox's write protection) → one shared `admitSavePath` gate for downloads AND screenshots (absolute, inside `downloadDir`, never overwriting an existing file), plus parent-directory creation for screenshots; the default download directory is no longer hardcoded to `~/Downloads` but probed in order: `downloadDir` → `XDG_DOWNLOAD_DIR` → `~/Downloads` / `~/下载` / `~/下載` → fallback (a Chinese desktop needs no configuration) |
| **0.1.22** | 2026-09-16 | **Release**: the macOS binary-probe fix (issues #9 / #14) and rounds 15–17 (issue #11 toolbar SyntaxError / #10 self-hosted trio / #13 screenshot savePath + download dir) ship as **0.1.22** (build clean, **35/35 tests pass**, tag `v0.1.22`) |
| Round 18 | 2026-09-20 | **Windows on-device trio + probe self-healing + locate verdicts** (measured on a real self-hosted `dsh web` host; defects ①–④ were all the "CDP answered success, the page received nothing" kind): ① Chromium's `CalculateNativeWinOcclusion` marks the plugin window HIDDEN while another window covers it — the page stops producing frames and **every** synthesized mouse/key event is dropped by the renderer (`CanReceiveInput()` false) while CDP replies `{}` → the child appends `disable-features=CalculateNativeWinOcclusion` before `app.whenReady()` (win32 only); ② `click()` had no leading `mouseMoved`, so the first click on a fresh view was routed away and lost → now move→press→release; ③ a fresh view holds no web focus, so the FIRST `browser_key` of a session vanished → new host `focus` op (optional `focus?()` on the view handle), `key()` focuses best-effort before dispatch and waits 80ms only when focus had to move (focus lands asynchronously; a key dispatched in the same turn is still dropped); ④ `available()` cached a FAILED Electron probe for the host's lifetime while provider selection runs once per process, so an Electron that arrived after DSH started was never adopted → successes stay cached, failures re-probe after a cooldown (`DSH_BROWSER_PROBE_RETRY_MS`, default 30s), and `resolveProvider()` now distinguishes "no provider registered" from "registered but reports itself unavailable" with the matching remedy; ⑤ **a failed locate was masked by the outer timeout** — the in-page locate script polls for its whole budget and answers only afterwards, while the outer wait used the SAME budget, so `browser: click timed out after 10000ms` won the race and the in-page verdict never got out; a css/xpath **parse error** also reported as "not found yet", polling a selector that can never become valid. Now a parse error is terminal and names itself (`invalid CSS selector "…" / invalid XPath …`), the outer wait gives the in-page answer 2 s of transport grace, and a miss reports the strategy the provider assumed (`by` defaults to `"by":"css"`) plus the time spent; `scrape`'s item selector fails the same way at once. Same call: before `click timed out after 10000ms`, after `element not found: {"value":"Learn more","by":"css"} (looked for 10000ms)`. 7 new regression tests (**47/47 pass**), 17/17 end-to-end steps against the real host, plus 4/4 locate-verdict steps |
| 19 | 2026-10-01 | **DSH 0.2 compatibility**: DSH moved to the 0.2 line (`@deepseek-ai/dsh@0.2.0-rc.2`, with `dsh-llm`/`dsh-tools`/`dsh-system-prompt` following to `0.2.0-rc.2`), while our declaration `>=0.1.1-rc.1 <0.2.0` shut 0.2 out → verified the plugin's (narrow) runtime dependency surface against a **real 0.2.0-rc.2 host** (`cordis` Context/Service, `dsh-tools` defineTool, `dsh-llm` HarnessError, `schemastery`) and found no breaking change: session, navigation, snapshot and the screenshot trio (outside-path refused / legal write / overwrite refused) all pass → peer ranges for the three dsh packages widened to `>=0.1.1-rc.2 <0.3.0`, `dsh.compatibility.dsh` widened to `>=0.1.1-rc.1 <0.3.0`, and `dshReleases` gained `0.2.0-rc.1`/`0.2.0-rc.2` = compatible |
| **0.1.23** | 2026-10-01 | **Release**: round 18 (PR #15: the Windows synthesized-input trio + Electron probe self-healing + locate verdicts) and round 19 (DSH 0.2 compatibility) ship as **0.1.23** (build clean, **47/47 tests pass**, tag `v0.1.23`) |
| Round 20 | 2026-10-01 | **Browsing history / settings panel / synthetic cursor / teardown**: (1) **persistent browsing history** (`history-store`: append-only JSONL beside the browser profile; capped at 5000 entries or 90 days, whichever comes first; a damaged line loses only itself) plus the new **`browser_visited`** tool (tool count **33 → 34**), reopening via `browser_open`; (2) a "Browser" section in Settings (hand-written client bundle registered into `settings.section` with `order: 60`, below the host's own rows) served by `GET/PUT /dsh-builtin-browser/settings` (same-origin guard, 64 KiB cap) over a `settings-store` document (per-field validation, unknown keys dropped, malformed file falls back to defaults) — **switches take effect immediately** because the provider reads the document on every use; (3) an in-page **synthetic cursor** (inline styles + Web Animations, so a page's `style-src` CSP cannot drop it; `buildTargetScript` now attaches the element centre as `__point`, which gives click / type / setValue / check / select / clear **a landing point**) — **its appearance means the agent has taken over that tab**; (4) **closing a window ends its session**: on `closed` the host releases every view's `webContents` (a BrowserWindow does not destroy child views, so each window would otherwise leak a renderer) and reports `viewClosed`; the provider ends that session and the seam gains `exists()` so the tool layer re-checks a cached session — the next call gets a **clean session** while browsing history and login state survive. 21 new tests (**68/68 pass**) |
| Round 20 addendum | 2026-10-01 | **Root cause of the invisible settings panel, plus crash diagnostics**: (1) On a real host the panel did not appear — the cause is that all three `cordis.patch.yml` rows were registered under **subpath** names (`dsh-builtin-browser/browser`), while the host's client-module scan resolves a row's specifier to a **package root** (`exactPackageSpecifier` returns `undefined` as soon as it sees a `/`), leaving the package with no row to read its `dsh.client` from. Fixed by adding an inert root row under the bare package name and giving the root entry `export const name` plus an empty `apply()`. Measured: boot entries 67 → **68**, the panel appears below "规则设定", and switches persist immediately. (2) Three host-log defects fixed: ISO timestamps, both paths plus their existence recorded before spawning, and a 2 MiB rotation that leaves a dated marker instead of wiping the file (which is how weeks of history vanished); the `exit` line gained `pid=` and `entryExists=` so "present at spawn, absent at exit" names an installation replaced underneath a running host. (3) Test pollution of the real log fixed: three spawn-based tests restored `DSH_HOME` in a `finally` while `dispose()` kills children asynchronously, so their synthetic exit lines landed in the operator's real log — now isolated at module scope. **70/70 tests** |
| **0.2.0** | 2026-10-01 | **Release**: round 20 (persistent browsing history / the "Browser" settings section / synthetic cursor / teardown semantics) and its addendum ship as **0.2.0** — tool count **33 → 34** (new `browser_visited`), plus a new "Browser" section in Settings. Build clean, **70/70 tests pass**, tag `v0.2.0` |
| Round 21 | 2026-10-01 | **The desktop is now carried by the official sidebar (one page for both parties)**: DSH Desktop is two layers — an Electron shell plus a **Node-mode host** where the plugin runs (no Electron API) — and 0.2 removed `electronViewHost`, leaving no view-carrying channel between host and shell → the plugin borrows a **loopback + token bridge** (installed into the shell's main process by `install.mjs`, idempotent, revertible with `--revert`) that hands it CDP access to the sidebar browser's guest. The result: **the page the agent works on is the page the human sees**, with no self-hosted Electron spawned and no second window. Measurement corrected three things we had assumed: the sidebar guest is created **lazily** (an un-navigated sidebar has no webContents at all); the address-bar route is unreliable (React's controlled input ignores synthetic keyboard events, and focus is taken back by re-renders), so it drives the sidebar's own **"restore last page"** control to force the guest out and then navigates purely over CDP; and the endpoint file must be **rewritten periodically**, or a reader gets the address of an exited shell |
| Round 22 | 2026-10-01 | **issue #16: an error-reporting path must not be fatal**: `notifyUserActionError` took the host method out and called it **unbound**, so the host's own first statement `void this.ready()` threw a TypeError, and that throw turned into an unhandled rejection inside an async catch → **the whole DSH host exited with 1**; and even with correct binding, `ready()` **throwing synchronously** once disposed escaped every `.catch`. Fixed by calling on the owner and containing every failure along the way, and by making `ready()` return a rejected promise (marked as handled). Four regression tests, including the failing toolbar action driven by the reporter's own `this`-reading stub |
| Round 23 | 2026-10-01 | **CVE-2026-84961 (undici)**: the CVE is real, but the suggested auto-fix **does nothing in this repository** — `pnpm.overrides` was written into `package.json`, and pnpm 10 no longer reads that field (measured: it prints a warning, ignores it, and the lock still resolved 7.29.0). Pinned `undici: 7.29.1` in **`pnpm-workspace.yaml`** (the new home for it) instead, staying on the same major rather than taking a jump that buys nothing. Impact clarified: the plugin never imports undici, and the published package ships no `node_modules` |
| Round 24 | 2026-10-01 | **Every last item of the requirements doc**: (1) **the vision strategy finally does something** — under `nonVisual` a coordinate click is **refused with an actionable alternative**, and tool descriptions lead with semantic targeting (the setting was stored, and read by nobody); (2) **non-visual output improved** — snapshots indent by `depth`, coordinates are opt-in (`coords: true`), empty states dropped, and `content(txt)` uses the browser's rendered text; (3) **the sandbox-boundary change stated** (both READMEs plus the settings panel); (4) `closeWithSession` / `autoExpandOnce` **actually work** (the bridge gained `closeSidebarBrowser` and `collapseSidebar`); (5) **each session owns its own sidebar tab**, and a release closes only its own; (6) history gained **keyword and originating-session** filters; (7) the cursor gained an **action bubble**. Six measured bugs fixed along the way (letter-by-letter animated text split into a column of letters, the first call after a restart always failing, three settings that were dead, a release closing somebody else's tab, and every setting silently dropped when the settings file carried a BOM) |
| Round 25 | 2026-10-01 | **Speed and structure**: measurement put the structural overhead of each command at **49.1 ms** (a fresh TCP connection with the token exchange at 24.8 ms, plus a liveness check before every command at 24 ms) against **0.2 ms** on a reused connection → now **one long-lived connection with serialised requests**, and liveness is settled by "the command failed, so rebuild" instead of being probed up front. The transport moved into its own module, `bridge-connection.ts` (`desktop-bridge-host.ts` 426 → 306 lines). Cursor: an unchanged position is no longer repainted, easing became 190 ms, and `forgetCursor` was added (the cache has to be dropped when the document is replaced, otherwise the pointer never comes back after a navigation) |
| Round 26 | 2026-10-01 | **Optional system Chrome / Edge**: settings now offer `bundled` / `auto` / `chrome` / `edge`, taking the same approach as Codex Browser Use — launch with `--remote-debugging-port=0`, read the port the browser writes into its own `DevToolsActivePort` file, and drive everything over CDP (through Node 22's built-in `WebSocket`, **zero new dependencies**). **The user's everyday data is never touched** (a separate profile); login state is kept or discarded according to `cookies.persist`. Precedence: explicit choice > desktop sidebar > self-hosting. (At the time the chosen browser was missing, a warning was logged and the bundled one was kept — later refined: `automatic` still falls back, but an explicit choice now reports the missing browser instead of silently substituting one.) |
| **0.3.0** | 2026-10-01 | **Release**: rounds 21–26 ship together (the desktop sidebar carrier, the optional installed browser, the whole of requirements doc v2). **99/99 tests pass**, tag `v0.3.0` |
| Round 27 | 2026-10-01 | **The system browser starts only when it is needed** (reported bug) plus teardown hardening: the entry used to `await launch()` while registering, so **installing the plugin popped a browser up** and even starting DSH dragged one along → construction is now **inert and the browser launches on first need** (concurrent first calls are merged into one startup). Self-review added two more edges: a released host **refuses to start** (otherwise it spawns a process nobody owns), and a release during startup **stops the poll and refuses to publish the client** (otherwise it leaves a dangling connection). Also added `tools/install-web-plugin.mjs`, which turns "change the pin → install → **repair the profile immediately** → verify" into a single command, and the machine username was removed from the CHANGELOG |
| **0.3.1** | 2026-10-01 | **Release**: round 27 (lazy startup + refusing to start after release) ships as **0.3.1**. **100/100 tests pass**, tag `v0.3.1` |
| Round 28 | 2026-10-01 | **Two "limits" were implementation limits**: reviewing the documented limitations showed they were never about the carriers. ① `browser_auth` called a native method only the self-hosted handle implements and refused otherwise — but **cookies are part of CDP** (`Storage.getCookies` / `Storage.setCookies`) and **all three carriers speak CDP**, so export and restore now go through it when no native method exists, **working on all three** (domain+path vs URL, the leading-dot spelling and seconds vs milliseconds are handled, and cookies that cannot form a usable URL are dropped). ② JPEG was denied to every CDP path because Electron's CDP JPEG encoder hangs — true for Electron, irrelevant to an installed Chrome/Edge — so a view now advertises `supportsCdpJpeg` and only then is the format passed through; the sidebar keeps PNG. ③ The tool description promised downscaling that existed only on the native path, so the CDP path now scales through `clip.scale` (reading `Page.getLayoutMetrics` first, and capturing unscaled rather than failing when the size is unavailable). ④ Two carrier differences that were never documented are now written down: **the sidebar does not report user-action events**, and **an installed Chrome/Edge uses a plugin-owned profile**. 11 new tests over the pure parts, **124/124** |
| Round 29 | 2026-10-01 | **Independent code review**: a separate reviewer read the whole tree and reproduced the findings. ① **`spawn` had no `error` listener** — a launch failure arrives as an asynchronous event, and without a listener Node takes **the entire DSH host process down**; it now fails the command instead. ② **`dispose()` during `start()`'s 250 ms poll** left the launched browser alive with nobody to kill it; the poll now kills it before stopping. ③ Three different failures all reported "did not expose CDP within 30s", in half a second; each now says what happened. ④ **An explicit `chrome`/`edge` choice was still overridden by the desktop sidebar**, because discovery never checked the channel — which also meant the "your browser is not installed" explanation could never appear, cancelling the previous round's fix. ⑤ `CdpClient.whenReady()` awaited an unbounded promise, so a dropped connection could hang a tool call forever. ⑥ `focus()` used `kill('SIGCONT')`, a no-op on Windows, while its comment promised to raise the window. ⑦ Removed an unreachable `brave` branch. **125/125** |
| Round 30 | 2026-10-02 | **The second independent review's 4 HIGH + 2 MEDIUM**: ① **read-only tools were in fact blocked by the allow-list** — `assertAllowed` exempted only `browser_restrict` itself, so a narrow restriction also locked away `browser_history` / `browser_reset_session` / `browser_auth` with no way back → an explicit read-only set (plus the tools that lift a restriction) now exists. ② **A cancelled navigation completed as success** — `navigate()` checked the signal once at the top while `settleDocument` returned quietly on abort, so the call finished with no exception, was recorded as success, and wrote the page into the persistent browsing history. ③ **The settings switch nothing read** — `credentials.allowRead` existed only in the settings store and the panel, so turning it off still let `browser_auth` export every cookie; both auth paths are genuinely gated now. ④ **A stale tab id could close someone else's tab** — `locateTab` searched every other session when the id was not local and reported success, so isolation was broken; it is confined to the calling session now (a bare uuid and `tab:<uuid>` are still both accepted). ⑤ With an empty `target.value`, `browser_type` fell back to the focused element (possibly a password field) and `browser_click` dropped the semantic target for coordinates, both reporting success → an empty value is an error. ⑥ `scrape`'s outer budget equalled the page-side deadline, so a page-side "no elements matched" verdict could never travel back → the outer call now leaves room for the transfer. **130/130** |
| **0.4.0** | 2026-10-02 | **Release**: rounds 27–31 ship together — the theme is **separating real limits from implementation limits**: `browser_auth` works on all three carriers, an installed Chrome/Edge can encode JPEG, and downscaling works everywhere; alongside fixes for defects that crashed the host, silently did the wrong thing, or hung forever. **130/130 tests pass**, tag `v0.4.0` |
| Round 31 | 2026-10-02 | **Third review round + atomic settings writes**: ① **settings writes go through a temporary file and a same-directory rename** (the rename is the commit point, so a crash or a full disk cannot leave half a JSON document that the reader then silently replaces with defaults), and a failed write cleans up only the temporary and **no longer publishes the new value as cached**; ② fixed an `el` never rebound after a filter (a selector matching several elements wrote the value onto the first one while reporting success); ③ `handle.focus()` got a 5 s budget (the only unbounded await in the file, and it runs before typing); ④ `browser_wait`'s poll leaked an abort listener every 200 ms (~150 for a 30 s wait) and now reuses `delay()`; ⑤ with `autoExpandOnce` off, `showActive` treated "show the view" and "fold the carrier" as exclusive branches and returned after the second — on carriers with no collapse capability the view was **never shown at all**, so the agent drove a view the human could not see and every screenshot failed with "view not painted" (an error that blamed the page for a setting); ⑥ assorted `bridge-connection` / `scrape` timeout clean-up. **130/130** |
| **0.4.1** | 2026-10-02 | **Release**: issue #21 — **the system browser carrier (chrome/edge) neither reconnected nor restarted after its process died**, so every `browser_*` call hung for 30 seconds and only restarting DSH helped. Launch-time failures were handled in the previous round, but death **after a successful launch** was never observed: there was no `exit` listener, `this.client` was never cleared once assigned, and `ensureClient()` kept returning that dead connection forever. Fixed along the two failure shapes reported: process death → the child is observed throughout, its exit clears the cache and the next call relaunches; socket death with the process alive → the cached client's liveness is checked before use; process and socket both alive but the command never answered → **a failed command drops the client**. Commands sent on an already-closed socket now **fail immediately and say why**, instead of waiting out the budget and reporting a "timeout" that points nowhere near the real cause. **132/132 tests pass**, tag `v0.4.1` |
| Round 32 | 2026-10-03 | **Output-cost audit + independent verification** (shipped in **0.4.2**): ① **`browser_a11y`**: the default node count went **500 → 150**, indentation two spaces → one, `states=[…]` prints omitting the literal `enabled` (unchecked, collapsed and others are still printed) (**no `states=` means enabled**) and the trailing hint is short; ② **snapshots and the a11y tree now hand you a citable selector**: `{#id}` / `{[name=x]}` — the page-side script had always computed it and the tool layer threw it away, while the targeting tools accept only css/text/xpath, leaving the model to guess at text or fall back to a screenshot — and the field is **declared in the output schema**, without which `additionalProperties: false` rejects the whole result, which is exactly how the gap was found on the first real call; ③ **`browser_content` caps are per format** (html/json 50 000, the rest 20 000, overridable with `maxChars`), **`json` no longer returns `{}`** (a DOM node serialises to nothing) but `{"html":…,"tag":…}`, and the truncation notice says how to narrow; ④ `browser_scrape` returns compact JSON; ⑤ `browser_execute`'s return value is capped at 50 000 characters with the cut stated; ⑥ `browser_history` shows the last 20 entries without parameters and leads with the total — `verbose: true` brings the parameters (the parameter had been declared and never read); ⑦ `browser_visited` timestamps are minute-granular and the session tag prints once per change, shortened to 8 characters; ⑧ **`browser_auth`'s `flush` exports only the cookies of the site the current page is on** (it used to be the machine-wide shared jar) and **refuses rather than widening** when the scope is unknown, while `restore`'s count now reflects what was really submitted (`Storage.setCookies` returns nothing, so it was always 0 and read as failure) and **`browser_auth` left the read-only set** — its `restore` writes cookies to arbitrary domains, an action rather than an observation; ⑨ **atomic settings writes**, a settings cache that returns before reading the file, a browsing history that no longer rewrites the whole file on every navigation (648 KB per navigation once past the cap, measured at 17.5–20.6 ms), the `browser_content` page-script syntax error that broke all four formats, `browser_visited` printing blank rows, bridge replies correlated by request id, and `tools/install-web-plugin.mjs` refusing to damage a profile it cannot repair. Two unbounded host awaits (self-hosted capture/download, and cookie export/restore) got timeouts. **132 → 134** |
| Round 33 | 2026-10-03 | **The system browser carrier: actually usable after it dies** (shipped in **0.4.2**): ① **one failed command no longer tears down the connection** — a CDP protocol error means the browser answered and refused that one command, so the connection is healthy; ② **a restart now drops the stale session mappings**, not just the cached connection and child, because every command the replacement received carried a session id issued by the dead process — that is the reported "it restarts, and every call fails forever"; ③ **a slow page is not a dead browser** — deciding liveness by error text turned the 5 s/15 s outer timeouts into "the browser is dead" and killed the window you were using, tabs and half-filled forms with it; the state is now three-way — socket closed → discard, answered and refused → keep, **no answer → mark suspect** and probe once with `Browser.getVersion` on the next call; ④ **after the kill it waits up to 3 seconds for a real exit** (on Windows the kill is asynchronous, and not waiting handed the new process's command line to the old instance, whose resulting exit was misreported as "check that the path is a runnable browser"); ⑤ **only the launch's own `DevToolsActivePort` counts** (a killed browser never cleans it up, and the stale file made the host connect to another Chromium or a `node --inspect`); ⑥ **the port-discovery regression test now uses a fixture that really speaks CDP** (the old `.cmd` stub was refused by Node's spawn on Windows, and all three assertions were satisfied by that single synchronous failure — CI was green while the exit handling never ran once). **134/134** |
| Round 34 | 2026-10-03 | **Operator-level action switches (the real entry point)** (shipped in **0.4.2**): the settings panel gains "What the agent may do" — **run scripts in the page** / **download files to disk** / **write login state**. Switching one off refuses that capability outright (`BROWSER_EXECUTE_DISABLED` / `BROWSER_DOWNLOAD_DISABLED` / `BROWSER_AUTH_WRITE_DISABLED`). What separates them from `browser_restrict` is **who can change them**: that one is set by the model and can be lifted by the model, while these live in the settings document, which no tool can write. Also fixes a read/write mix-up: restoring login state (`browser_auth restore`) answered to the READ switch and reported "reading cookies is switched off", so an operator who allowed reading had no way to refuse writes — it now answers to the write switch. **148 → 157** |
| Round 35 | 2026-10-03 | **DSH 0.2.1 adaption** (shipped in **0.4.2**): the host moved to `0.2.1-alpha.1` (266 commits past rc.2), so every host-facing dependency was checked item by item — cordis `Context`/`Service` (vendor 4.0.5-alpha.1), `dsh-tools` `defineTool` and every `DefineToolOptions` field, `dsh-system-prompt` `section()`, `dsh-llm` `HarnessError`, the schemastery default export, and on the client side `slots.inject('settings.section')` with `locale.register`/`bind`. **None of the shapes changed** (the client calls match DSH's own plugin word for word). Added `scripts/verify-host-compat.mjs`: it assembles a host from the `@deepseek-ai/*` packages **actually installed** in a profile, loads this build, registers 34 tools through the host's own `defineTool`, and calls `browser_session` plus `browser_a11y` over a fake provider — **all green**. `dsh.compatibility.dshReleases` now records `0.2.1-alpha.1 = compatible`. One semantic trap recorded too: that range matches no prerelease under **default semver semantics**, while DSH evaluates with `includePrerelease: true`, so these hosts are in range in practice |
| Round 36 | 2026-10-04 | **An external audit, worked through** (shipped in **0.4.2**): eight findings with line numbers and evidence, each verified against the code and fixed in three batches — (1) **storage and settings**: a settings document that EXISTS but cannot be parsed no longer resolves to "everything on" (a torn write used to reopen every capability the operator had switched off), a gate field of the wrong type now reads as OFF, `history.jsonl` uses the settings store's atomic write for its whole-file rewrite, and `contentMaxChars` — assigned but never read since the caps became per-format — works again; (2) **lifecycle**: the browser child gets the socket close first and time to `app.quit()` its profile out, and only then is killed (the old comment claiming `app.exit(0)` "flushes the profile" was false, and on Windows `kill()` is TerminateProcess, which lands before any handler runs), and the child no longer calls `app.exit(0)` either; (3) **usability**: click/type/fill resolved targets against the top document only while the snapshot and `waitFor` walked shadow roots and iframes — **visible, waitable, unclickable** — so the resolve scripts now collect every root; on Windows the per-user `%LOCALAPPDATA%` install locations are searched, and the "exited immediately (exit code 0)" message no longer points at a broken path when it means the browser handed the request to an instance already holding its profile. Two places that silently wreck someone else's work are fixed as well: `install-web-plugin.mjs` refuses to overwrite a `link:` pin with a registry version, and a failed adopt disposes its half-built host. **Two findings I do not agree with**: a zero-hit grep for `window-all-closed`/`before-quit` says nothing about behaviour (Electron's default is already right), and a `requestSingleInstanceLock` would break normal restarts rather than fix orphans. |
| **0.4.2** | 2026-10-04 | **Release**: rounds 32-36 in one release — the theme is **making invisible errors visible**. (1) **Output cost**: what every call pays dropped to a fraction (a11y defaults to **500 → 150** nodes, indentation and `states` carry only information, `content` caps are per format, `history` shows 20 entries by default). (2) **Action switches**: three capability gates held by the **operator** that no `browser_*` tool can change (run page scripts / download to disk / write login state), kept clearly separate from `browser_restrict`, which the model sets and lifts itself. (3) **Recovery semantics completed**: a dead system-browser process now takes its sessions down with it (previously the browser could restart while the view still held the dead one's session id — "fails fast and keeps failing"), a slow page is no longer mistaken for a dead browser, and `kill` waits for the process to actually exit. (4) **An external audit, worked through**: a settings document that EXISTS but cannot be parsed is now fail-closed (a torn write used to reopen **every** capability the operator had switched off, and the next save wrote those defaults to disk), `history.jsonl` is written atomically, the client panel — read at request time — no longer fails to open because the host lacks a field, click/type/fill reach shadow-DOM and iframe elements the snapshot already shows, and Windows user-level installs (`%LOCALAPPDATA%`) are searched. **171/171 passing** (172 total, 1 skipped by platform), tag `v0.4.2` |
| Round 37 | 2026-10-04 | **Architecture refactor + an external review worked through** (no version bump; these changes ship with the next release): the theme is **one fact, no longer hand-copied in four places** — both published bugs (`browser_a11y`'s `selector`, `browser_screenshot`'s `width`/`height`) came out of the same mechanism, "the provider computed it, the schema declared it, and the tool layer's hand-written allow-list dropped it", and two full test runs stayed green because **no test ever ran a tool**. (1) **One field set, declared once**: new `src/tool-browser/element-fields.ts` (the element/node field tables, plus the item schema and the projections derived from them); `browser_snapshot`'s schema joined `browser_open`'s, which the earlier pass had done only half of; and new `tests/element-fields.test.mjs` (7 cases: schema ⟷ tables equal in both directions, the projection carries every declared field, the projection drops undeclared fields, and all 34 registered tools are walked to assert that what the schema requires the tool really produces). (2) **Page-script parsing goes from 4/16 to full coverage**: new `tests/page-scripts-parse.test.mjs` scans the source directly (the provider, `host-main`'s toolbar and download, the virtual cursor, the sidebar bridge) instead of relying on driving a behaviour to capture a script — the cursor, download and bridge scripts had never been parsed at all. (3) **Two real self-hosted bugs**: `materializeOnce`'s "reset on failure" was dead code (it stored a derived promise and compared the original, so the branch could never be taken), letting a child that is alive but not answering **poison that handle permanently** while the retry its comment promised was unreachable; and `fail()` cleared `kill()`'s 500 ms backstop — a dead socket is not a dead child — so it now clears only on an observed exit or the release path. (4) **The seam stops lying**: the handle's `download`/`flushAuth`/`restoreAuth`/`capture` and the host's `notifyUserActionError` were promoted from structural casts to interface declarations (so a new host written against the interface no longer gets a silent no-op), `capture`'s contract gained the size the `browser_screenshot` schema had always declared, and 8 empty methods that existed only to satisfy the interface plus 2 host-level `focus()` methods with no caller anywhere were deleted. (5) **Screenshot size is no longer CDP-carrier-only**: the earlier fix did only the CDP half — the native `capturePage` path never passed its size back, so `width`/`height` were **always missing on the default self-hosted carrier** — and the child now measures and reports them after any downscale, wired through `capture()`'s type, `screenshot()`'s return type and the native branch (reported when the capture was measured; `width?`/`height?` were optional all along). (6) **Settings and storage**: a **gate-holding section** that is present but not an object (`actions: false`, `null`, a string) is no longer treated as absent (which took each gate's permissive default) — every gate inside it now reads as **off**; and `history.maxEntries`/`maxAgeDays` stopped being dead knobs (parsed and persisted, but never handed to the `HistoryStore`), the reader now passing the live values to `updateLimits()`. (7) **System-browser carrier**: the `'exited'` error no longer reads every exit code as "handed the request to an instance holding the profile" — that story holds only for code 0, while a crash code sent people looking for a leftover process that was not there; the launch poll **checks `signalCode` as well** (a browser killed by a signal never sets `exitCode`, so checking only that let an instant death run out the full 30 seconds and report "did not expose CDP"); and the port probe's `fetch` gained an `AbortSignal`. (8) **RPC vocabulary**: new `src/browser-electron/rpc-ops.ts` gives the child's switch and the parent's senders one list of op names, with `tests/rpc-ops.test.mjs` reading both sources and asserting they agree (it caught two ops named from memory that the child does not handle). **183/183 passing** (**184** total, 1 skipped: creating a file symlink on Windows needs elevation) |

> The npm badge at the top is the authority on the registry's latest version (currently `0.4.2`). After a desktop upgrade, re-run `node desktop-bridge/install.mjs` once; the web side has no such step — see [Updating (the two hosts differ)](#updating-the-two-hosts-differ).

## Acknowledgements

Special thanks to the [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) and the DeepSeek AI team: the seam, the tool runtime, and the plugin system this plugin builds on all come from that project.

Thanks as well to [Cordis](https://github.com/cordiverse/cordis) for the plugin foundation, and to everyone in the community who discussed, tested, gave feedback, and built plugins.

## A Note from the Author

Have feedback about this plugin, or an idea for another plugin you'd like built? Feel free to reach out on WeChat:

**wx: `hui13866591135`** (please mention this project when sending the friend request)

## License

MIT License, see [LICENSE](LICENSE).

> This project is a community plugin for DeepSeek Harness, not an official DeepSeek product.
