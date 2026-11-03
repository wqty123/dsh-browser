<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-browser?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/npm/v/dsh-builtin-browser?style=flat&amp;label=npm&amp;color=CB3837" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/Platform-Windows-4493F8?style=flat-square" alt="Platform: Windows (verified)">
</p>

<p align="center"><sub><a href="README.md">中文</a> · English</sub></p>

<h3 align="center">A <b>shared real browser</b> plugin for DeepSeek Harness</h3>

<h4 align="center">The agent drives a real, visible browser you can take over at any moment — <b>one page</b>, not a casting of it.</h4>

## What it is

- **A real browser, not a remote view.** On the desktop it drives the official sidebar panel; when that is unavailable it uses the plugin's own window; you can also point it at your installed **Chrome / Edge**.
- **Same page for both sides.** What the agent sees and acts on is what is on your screen, so you can take over mid-task.
- **Works once installed.** **35 tools** under `dsh_browser_*`: open, read, click, fill, screenshot, download, credentials. No extra wiring.
- **Isolated per task.** Each task gets its own tabs and history.

## Install

The two surfaces are separate installs: **updating one does not update the other**.

Updating an installed plugin takes two steps (since DSH 0.2.1-alpha.2 a second `add` reports `already-installed`):

```sh
dsh plugin --profile <profile> remove dsh-builtin-browser
dsh plugin --profile <profile> add dsh-builtin-browser@0.5.2
```

### Desktop

```sh
dsh plugin --profile desktop add dsh-builtin-browser
```

Driving the **official sidebar** panel additionally needs a bridge inside the desktop app's own install directory (optional; without it the plugin opens its own window):

```sh
node desktop-bridge/install.mjs "<DSH Desktop install dir>" --restart
# or double-click desktop-bridge/install-and-start.cmd
```

Do not install while the desktop app is running: the archive is in use and `rename` fails with `EBUSY`. A desktop upgrade invalidates the bridge (`bridge-status` reports `stale`); re-running the same command repairs it.

### Web (`dsh web`)

```sh
dsh plugin --profile web add dsh-builtin-browser
```

The web surface has no sidebar and no bridge: the plugin hosts its own window (titled `dsh-browser`) with an address bar, back/forward/reload and a tab strip — usable as an ordinary browser.

> The Electron binary is normally prepared by the install script. A host using `strict-dep-builds` needs the build script approved first; otherwise run `npx --no dsh-browser-install-electron` inside the profile directory. See the [user guide](docs/user-guide.md).

### Then

```
Open https://example.com and summarise the main content.
```

## Carriers: chosen automatically, or pinned

| Carrier | When |
| --- | --- |
| Desktop sidebar | The shell exposes a drivable `<webview>` and the bridge is installed (preferred) |
| Self-hosted window | Sidebar unavailable, no bridge, or always on the web surface |
| Installed Chrome / Edge | Pinned in settings |

Two sidebar cases used to require a human first — the column not being open, and the conversation not being the displayed one. Since 0.5.2 the plugin handles both: it opens the column when it was never opened, and asks the shell to display a conversation requested from the background. Trade-offs are in [limitations](docs/limitations.md).

## Tools (`dsh_browser_*`, 35)

| Group | Tools |
| --- | --- |
| Open and navigate | `open` `back` `forward` `refresh` `list_tabs` `switch_tab` `close_tab` |
| Read the page | `snapshot` `a11y` `content` `scrape` `screenshot` `challenge` |
| Interact | `click` `click_sequence` `type` `key` `scroll` `execute` |
| Forms | `fill` `set_value` `clear` `check` `select` `get_value` |
| Session | `session` `reset` `reset_session` `restrict` `auth` |
| Record | `history` `visited` `replay` |
| Other | `wait` `download` |

Parameters, outputs and examples: [tool reference](docs/tool-reference.md).

`click_sequence` (new in 0.5.2) sends a run of coordinate clicks in one call, for canvas pages — those ignore script-dispatched `MouseEvent`s and only accept real input.

## Remote viewing (off by default)

When DSH runs on a machine you are not sitting at, the browser is on that machine's screen. With `remoteView.enabled` turned on, the panel offers a **read-only** view: 2 fps, JPEG quality 70, scaled into 1280×720, one frame per request (slow links degrade instead of queueing), never written to disk, never entering the chat or model context. It does not forward clicks, keys or wheel events.

While it is off there is **no floating entry and no diagnostic request**; once it is on, the entry appears on the **next page load** (the client reads the switch once at startup rather than polling).

Three same-origin endpoints: `GET /dsh-builtin-browser/browser-view/sessions`, `GET …/browser-view/frame?session=…`, `GET /dsh-builtin-browser/bridge-status`.

The frames can contain CAPTCHAs, account details or logged-in content — confirm it is the page you mean to watch.

## Documentation

| To learn | Read |
| --- | --- |
| Install, configure, use, troubleshoot | [User guide](docs/user-guide.md) |
| Parameters and outputs of all 35 tools | [Tool reference](docs/tool-reference.md) |
| Why a shared real browser | [Why this exists](docs/why-browser.md) |
| The seam / provider / tool layers | [Architecture](docs/architecture.md) |
| What it cannot do, and why | [Limitations](docs/limitations.md) |
| Build, test, re-verify host compatibility | [Development](docs/development.md) |

## Changelog

Full detail, round by round, with the reasoning and evidence behind each fix: [CHANGELOG.md](CHANGELOG.md).

| Version | Date | Theme |
| --- | --- | --- |
| **0.5.3** | 2026-11-03 | **Installation no longer needs the network**: the `postinstall` is gone and the Electron runtime is prepared the first time it is actually needed, never failing an install (fixes the market install failures in #41/#42); the installer proves the app's identity before touching anything and validates before deleting (#40); the live-view entry mounts on demand, with its labels translated and a theme token that exists |
| **0.5.2** | 2026-11-01 | A sidebar page no longer waits for a human: the column is opened when it was never opened, and the shell is asked to display a conversation requested from the background, with a bounded retry. Adds `click_sequence`. Recognises the pre-#37 bridge refusal that carries no code |
| **0.5.1** | 2026-10-31 | Adopt the page the browser already shows: `switch_tab` and `open` land on it; canvas detection no longer requires an empty element list; a blank page is judged by its own URL |
| Earlier | — | See [CHANGELOG.md](CHANGELOG.md) (`0.5.0` was tagged but never published to npm) |

**Tool namespace:** since 0.4.8 every tool lives under `dsh_browser_*` (before that it was the bare `browser_*`, which collided with another plugin — one duplicate name unregistered the later plugin's entire toolset). `could not register dsh_browser_xxx` in the log means another plugin holds that one name; each tool registers independently, so the collision costs only that tool. Custom prompts that still say `browser_*` need `dsh_browser_*`.

## Credits

Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the seam, the tool runtime and the plugin system are that project's. Plugin foundations by [Cordis](https://github.com/cordiverse/cordis). And thanks to the reporters who arrived with reproductions and local patches: these fixes did not have to be guesses.

## Author

Questions, or ideas for other plugins: WeChat **`hui13866591135`** (say what it is about when adding).

## License

[MIT](LICENSE). A community plugin for DeepSeek Harness; not an official DeepSeek product.
