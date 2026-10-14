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

- **A real page, not a relay**: pages are hosted by a **real browser** — on the desktop that is the official side panel, on `dsh web` it is a window this plugin launches, and you can point it at **your own installed Chrome / Edge** instead. The user watches what the agent is doing and can take over at any time;
- **Human and agent on the same page** (desktop): the page the agent drives is the *same* page the human sees — no more acting inside a window you cannot watch;
- **Works on install**: the carrier is chosen automatically (desktop side panel first, otherwise self-hosted), and plain `dsh web` needs no extra configuration;
- **One plugin, one toolset**: installing it gives the agent 34 `dsh_browser_*` tools (open, read, accessibility tree, wait, semantic/coordinate actions, scroll, history navigation, batch and single-control form filling, keys, structured extraction, screenshots, downloads, login-state management).

In one line: **install the plugin and you have a real browser shared with, and drivable by, the user's agent.**

## Quick start

```sh
# From npm (point --profile at yours; DSH Desktop uses `desktop`)
dsh plugin --profile web add dsh-builtin-browser
```

Then just ask the agent to use it — no further setup:

```
Open https://example.com and summarise the main content for me.
```

The browser window (the side panel, on the desktop) appears with the first call. You can operate in that window yourself at any point, and the agent carries on from wherever you left it.

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

**Who should update to 0.4.8:** only names changed, not behaviour. **If this is your only browser plugin, you do not need to update.** If you also run another browser plugin (Tencent BrowserSkill especially), updating is recommended. See [the upgrade note](docs/user-guide.md#from-047-to-048).

## Release history

The full record — per round, with the cause and the evidence for each fix — is in [CHANGELOG.md](CHANGELOG.md) (Chinese). Published with a tag since **0.1.16**.

| Version | Date | Theme |
| --- | --- | --- |
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
