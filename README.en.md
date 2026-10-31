<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-browser?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/npm/v/dsh-builtin-browser?style=flat&amp;label=npm&amp;color=CB3837" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/Platform-Windows-4493F8?style=flat-square" alt="Platform: Windows (verified)">
</p>

<p align="center"><sub><a href="README.md">中文</a> · English</sub></p>

<h3 align="center">A <b>shared real browser</b> for the DeepSeek Harness ecosystem — install and it works, human and agent on the same page</h3>

<h4 align="center">The agent drives a real, visible browser you can take over at any moment — and you are both looking at the <b>same page</b>.</h4>

## What is this

`dsh-builtin-browser` gives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) browser capability:

- **A real page, not a relay**: pages are hosted by a **real browser** — the official desktop side panel when the shell and bridge support it, otherwise a window this plugin launches. You can also select **your own installed Chrome / Edge**. The user watches what the agent is doing and can take over at any time;
- **Human and agent on the same page** (desktop): the page the agent drives is the *same* page the human sees — no more acting inside a window you cannot watch;
- **Automatic carrier selection**: the desktop side panel is preferred when available, otherwise the plugin self-hosts. When the host allows installation scripts and the download is available, the plugin prepares the Electron binary during installation;
- **One plugin, one toolset**: installing it gives the agent 34 `dsh_browser_*` tools (open, read, accessibility tree, wait, semantic/coordinate actions, scroll, history navigation, batch and single-control form filling, keys, structured extraction, screenshots, downloads, login-state management).

In one line: **install the plugin and you have a real browser shared with, and drivable by, the user's agent.**

## Quick start

**First, which side are you on** — these are two separate installs; updating one does not update the other, and they host the browser differently.

> **Updating an installed plugin takes two steps** (since DSH 0.2.1-alpha.2, installing over an installed package fails outright with `already-installed`): run `dsh plugin --profile <profile> remove dsh-builtin-browser` first, then `add` the target version. See the [user guide](docs/user-guide.md) (Chinese).

> **0.4.16 is being prepared for release**, with security, stability and desktop rc.5 sidebar fixes. Existing users should update once it is published. Updating the plugin does not update the DSH desktop shell, refresh its bridge, or change an existing `ELECTRON_PATH` override. Back up first and follow the [0.4.16 upgrade notes](docs/user-guide.md#升级到-0416) (Chinese).

### DSH Desktop

```sh
dsh plugin --profile desktop add dsh-builtin-browser
```

When the desktop shell provides a controllable `<webview>` and the bridge is installed, the plugin drives the **official side panel**: the agent operates the very page you see. Otherwise it falls back to the plugin's own Electron window.

Driving that panel also needs a bridge, installed into **the desktop app's own install directory** rather than the profile:

**Since 0.5.0 this is one step.** The script closes DSH itself — installing while it runs fails with EBUSY on the archive, and a process that waits for the exit is carried away with it:

```sh
desktop-bridge/install-and-start.cmd          # Windows, double-click or run
node desktop-bridge/install.mjs "<dir>" --restart   # any platform
```

> Run this from the updated plugin directory after closing the desktop app and backing up its `resources` directory and browser data. **The bridge is optional**: without it, the plugin uses a standalone window. **Reinstall the bridge with the new script after plugin or desktop shell upgrades**, then restart the desktop app. See [carrier limitations](docs/limitations.md) (Chinese).

### Web (`dsh web`)

```sh
dsh plugin --profile web add dsh-builtin-browser
```

There is **no side panel and no bridge** on the web side: the shared browser is **self-hosted** in a standalone window (titled `dsh-browser`) with a full toolbar (address bar, back/forward/reload, tab strip) you can use like any browser.

> 0.4.16 normally prepares the Electron binary through its installation script. DSH rc.5 uses pnpm 11.7 with `strict-dep-builds`, so first installation may require approval of this plugin's build script in the host's native plugin manager; the plugin does not change `allowBuilds`. After `--ignore-scripts` or an explicit download skip, run `npx --no dsh-browser-install-electron` from the correct profile directory to prepare it manually (network required). The command also respects `ELECTRON_SKIP_BINARY_DOWNLOAD`. See the [setup guide](docs/user-guide.md#准备-electron-二进制) (Chinese).

### Both sides

Once installation and any required build script approval are complete, ask the agent:

```
Open https://example.com and summarise the main content for me.
```

The browser window appears with the first call, and you can operate in it yourself at any point. **Either side can be pointed at your own installed Chrome / Edge** in settings — that option behaves identically on both.

## Documentation

| Goal | Entry point |
| --- | --- |
| Why this plugin exists, and how it differs from headless | [Why a shared real browser](docs/why-browser.md) |
| Install, configure, daily use, troubleshooting | [User guide](docs/user-guide.md) |
| Every one of the 34 tools: parameters, output, examples | [Tool reference](docs/tool-reference.md) |
| The seam / provider / tool layers and the self-hosted host | [Architecture](docs/architecture.md) |
| What it deliberately **cannot** do, and why | [Known limitations](docs/limitations.md) |
| Build, test, re-verify host compatibility | [Development](docs/development.md) |
| All documents and how they divide the work | [Documentation index](docs/README.md) |

> Requirements, the four carriers and their tradeoffs, configuration, operating discipline, troubleshooting and updating all live in those documents — **this README is an entry point and does not repeat them.**

## Tool namespace

This plugin claims the global **`dsh_browser_*`** namespace (34 tools).

**Before 0.4.8 it was `browser_*`.** That is an unprefixed, generic word, and it collided directly with Tencent BrowserSkill's DSH plugin (`browser_session` in `@wxg-prc-cpg/browser-skill-dsh-plugin` @0.3.2) — and **DSH's tool registry is global and refuses duplicates**, so whichever registers second throws. All six of that plugin's tools failed to register, which reads as "installed but does nothing".

**Why we changed rather than waiting:** a bare name like `browser_*` belongs to nobody, and the cost of one collision is **not "each plugin keeps one" — it is that the second one loses its entire toolset.** Giving up the generic name is a better answer than asking every user to patch their own `node_modules`. Tencent's upstream has renamed its six tools to `bsk_*` as well.

**If your log shows `could not register dsh_browser_xxx`**: another plugin holds that name. From 0.4.8 every tool registers **independently**, so a collision costs that one name and nothing else — the check exists so the next collision is visible at a glance rather than starting from "the plugin is broken".

When upgrading from 0.4.7 or earlier, also replace `browser_*` with `dsh_browser_*` in custom prompts. Follow the current [0.4.16 upgrade notes](docs/user-guide.md#升级到-0416) (Chinese).

## Release history

The full record — per round, with the cause and the evidence for each fix — is in [CHANGELOG.md](CHANGELOG.md) (Chinese). Published with a tag since **0.1.16**.

| Version | Date | Theme |
| --- | --- | --- |
| **0.5.0** | 2026-10-31 | **Remote viewing** (#34) with passive capture; one-step desktop bridge install/repair (#36); a sidebar panel that is merely off-screen is no longer judged a lost carrier (#37); canvas pages and image-only links become visible; CDP sessions reconnect |
| **0.4.16 (local release candidate)** | 2026-10-31 | Security and stability: concurrent page ownership, downloads/screenshots that refuse overwrite, bridge and settings safeguards, carrier switching recovery, desktop rc.5 sidebar support; Electron `^44.10.0` and binary preparation during installation |
| **0.4.9**–**0.4.15** | 2026-10-15–19 | Sidebar capability detection and fallback, host contract alignment, headless Chrome/Edge and startup hand-off fixes; see CHANGELOG |
| **0.4.8** | 2026-10-14 | **Tool namespace**: 34 tools move to `dsh_browser_*`; one taken name can no longer cost the whole toolset |
| **0.4.7** | 2026-10-12 | Three defects of one shape: a hardcoded carrier, a dead host never replaced, a setting read once; takes the four suggestions from #26 |
| **0.4.6** | 2026-10-08 | Reading another conversation's sidebar, blank pages spawned while waiting, sign-outs on upgrade |
| **0.4.5** | 2026-10-06 | The real cause of cross-conversation bleed: panel placement keyed by conversation id, not by what the shell displays |
| **0.4.0**–**0.4.4** | 2026-10-02 | Splitting "limitations" into real ones and implementation ones: `dsh_browser_auth` works on all three carriers, JPEG works on an installed Chrome/Edge, downscaling everywhere; plus fixes for defects that crashed the host, silently did the wrong thing, or hung forever |

## Credits

Thanks to the [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) and the DeepSeek AI team: this plugin's seam, tool runtime and plugin system are all built on that project.

Thanks as well to [Cordis](https://github.com/cordiverse/cordis) for the plugin foundation, and to everyone who discussed, tested, reported and built plugins around this one — including the reporters who arrived with a full reproduction and a local patch, which is why these fixes did not have to be guessed.

## Author

If you have an opinion about the plugin, or an idea for another one, add me on WeChat:

**wx: `hui13866591135`** (please say what it is about when you add me)

## License

[MIT License](LICENSE).

> A community plugin for DeepSeek Harness, not an official DeepSeek product.
