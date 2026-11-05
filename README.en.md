<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-browser?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/npm/v/dsh-builtin-browser?style=flat&amp;label=npm&amp;color=CB3837" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/Platform-Windows-4493F8?style=flat-square" alt="Platform: Windows (verified)">
</p>

<p align="center"><sub><a href="README.md">中文</a> · English</sub></p>

# Browser plugin for DeepSeek Harness

Use DSH to open pages, read content, fill forms, and download files in the bundled browser, the desktop sidebar, or a local installation of Chrome or Edge. Each task has its own tabs and action history. In a visible window or the desktop sidebar, you can take over the page the agent is using.

This feature list matches **0.5.7**. [Changelog](CHANGELOG.md)

## Install

The plugin is installed once per end, and the two are **independent**: updating one does not update the other.

| | Desktop (the DeepSeek Harness app) | Web (`dsh web`) |
| --- | --- | --- |
| Plugin profile | `desktop` | `web` (or whichever profile you use) |
| Carriers available | Bundled browser, DSH sidebar, local Chrome / Edge | Bundled browser, local Chrome / Edge |
| Sidebar bridge | Required, installed into the desktop app's directory | Not needed — there is no sidebar in the web shell |
| After an update | Restart the desktop app; **if the desktop app itself was updated, reinstall the bridge** | Restart `dsh web` |

~~~sh
dsh plugin --profile desktop add dsh-builtin-browser   # desktop
dsh plugin --profile web add dsh-builtin-browser       # web
~~~

If it is already installed, remove it first: `dsh plugin --profile <profile> remove dsh-builtin-browser` (since DSH 0.2.1-alpha.2, installing over an installed package fails).

After installation, try this task in DSH.

> Open https://example.com and extract the page title and main content.

DSH prepares the Electron runtime for the bundled browser. Open **Settings → Browser** to check progress and use **Prepare the bundled browser** to retry a failed setup. To prepare Electron ahead of time, run `npx --no dsh-browser-install-electron` from the plugin profile directory. [User guide](docs/user-guide.md)

## Choose a browser

| Option | How it works |
| --- | --- |
| Bundled browser | Opens pages in a separate window with an address bar, navigation controls, and tabs. |
| DSH sidebar | Drives the sidebar on DSH Desktop builds that expose an Electron `webview`, with the bridge installed. |
| Local Chrome / Edge | Launches the installed browser with a dedicated plugin profile. |
| Automatic | Chooses based on the available local browsers and desktop sidebar. |

To use the **DSH sidebar**, run the following from the plugin directory. The installer verifies the DSH Desktop installation, installs the bridge, and restarts the desktop app. After a desktop update, check **Settings → Browser → Diagnostics** and use the same command to repair the bridge.

~~~sh
node desktop-bridge/install.mjs "<DSH Desktop install directory>" --restart
~~~

## Browser settings

- **Readiness** reports browser availability. Expand **Diagnostics** to see the browser selection, bundled runtime, and desktop bridge status.
- **Quiet mode** keeps your current window and tab in place. New Chrome and Edge instances run in the background, and minimized bundled browser windows stay minimized. For the desktop sidebar, open the target page by hand before handing it to DSH.
- **Presentation** controls sidebar expansion, closing the browser with the session, the agent cursor, and remote viewing.
- **Agent permissions** controls page scripts, downloads, and reading or writing sign-in state.
- **Advanced settings** covers browsing history, page targeting, and sign-in persistence and window mode for Chrome and Edge. The delivery form validates and saves the tool name, argument template, failure policy, and per-site rules together.

On the local machine or in an isolated test environment, turn on **Allow remote viewing** and open the DSH viewer for a read-only view of the browser session. The viewer refreshes JPEG frames up to twice per second.

## Download delivery

In **Advanced settings → Delivery**, enter an upload tool registered in DSH and configure its destination arguments. Automatic delivery uses the DSH native tool executor and retains the current task's tool permissions. The result includes the local download path and the upload tool's complete return value.

The official Baidu Netdisk stdio MCP upload tool accepts this argument template:

```json
{
  "local_file_path": "{path}",
  "remote_path": "/来自：mcp_server/DSH下载"
}
```

`{path}` becomes the downloaded file's absolute path. `remote_path` names the destination folder. Use the tool name actually registered in DSH, following `mcp__<serverName>__upload_file`. [Baidu Netdisk MCP parameters](https://github.com/baidu-netdisk/mcp)

For Feishu, configure an MCP tool that provides file uploads and use the argument fields it declares.

## Browser tools

The current source registers 48 tools. The table lists their names after the `dsh_browser_` prefix.

| Purpose | Tools |
| --- | --- |
| Open and navigate | `open` `back` `forward` `refresh` `list_tabs` `switch_tab` `close_tab` |
| Read pages | `snapshot` `a11y` `content` `scrape` `screenshot` `challenge` |
| Click and type | `click` `click_sequence` `type` `key` `scroll` `drag` `hover` `execute` |
| Fill forms | `fill` `set_value` `clear` `check` `select` `get_value` |
| Select and save files | `upload` `download` |
| Run and verify steps | `do` `assert` `wait` `wait_for_response` |
| Inspect page activity | `state` `find` `console` `network` `dialog` |
| Manage sessions | `session` `reset` `reset_session` `restrict` `auth` |
| Review records | `history` `visited` `replay` |
| Diagnose issues and find help | `doctor` `help` |

## Documentation

- [User guide](docs/user-guide.md)
- [Tool parameters and examples](docs/tool-reference.md)
- [Choosing tools, locating elements, and running steps](skills/dsh-builtin-browser/SKILL.md)
- [Architecture](docs/architecture.md)
- [Compatibility and operating conditions](docs/limitations.md)
- [Build and test](docs/development.md)

A community plugin built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [Cordis](https://github.com/cordiverse/cordis). Thanks to everyone who contributed issue reports, reproduction steps, and patches.

Author on WeChat **hui13866591135** · [MIT License](LICENSE)
