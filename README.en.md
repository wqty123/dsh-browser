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

This feature list matches **0.5.8** (compatible with DSH 0.2.2-alpha.3: plugin routes go through the host session auth). [Changelog](CHANGELOG.md)

## Quick start

**First, which side are you on** — these are two separate installs; updating one does not update the other, and they host the browser differently.

> **Updating an installed plugin takes two steps** (since DSH 0.2.1-alpha.2, installing over an installed package fails outright with `already-installed`): run `dsh plugin --profile <profile> remove dsh-builtin-browser` first, then `add` the target version. See the [user guide](docs/user-guide.md) (Chinese).

### DSH Desktop

```sh
dsh plugin --profile desktop add dsh-builtin-browser
```

When the desktop shell provides a controllable `<webview>` and the bridge is installed, the plugin drives the **official side panel**: the agent operates the very page you see. Otherwise it falls back to the plugin's own Electron window.

The sidebar bridge is installed into **the desktop app's own install directory**. On Windows Desktop, open **Settings → Browser** and select **Install and restart**. The action exits Desktop normally, installs the bridge, reopens Desktop, and verifies the new bridge connection. DSH retains its own confirmation for running tasks.

For terminal installation, save your task and exit DSH Desktop completely, including its tray process, then run this from the plugin directory:

```sh
node desktop-bridge/install.mjs "<DSH Desktop install directory>"
```

Start DSH Desktop after installation. On Windows, `desktop-bridge/install-and-start.cmd` installs and starts the app after Desktop has exited. The settings action uses an independent maintenance process; the installer verifies the closed target, its identity, and backups before writing files.

> **The bridge is optional**: without it, the plugin uses a standalone window. **Reinstall the bridge with the new script after plugin or desktop shell upgrades** — a desktop update restores `app.asar`, the bridge goes stale, and `bridge-status` reports `stale`. The state is visible at the top of the panel. See [carrier limitations](docs/limitations.md) (Chinese).

### Web (`dsh web`)

```sh
dsh plugin --profile web add dsh-builtin-browser
```

There is **no side panel and no bridge** on the web side: the shared browser is **self-hosted** in a standalone window (titled `dsh-browser`) with a full toolbar (address bar, back/forward/reload, tab strip) you can use like any browser.

> Since 0.5.3 nothing is downloaded at install time and there is no `postinstall`: the runtime is prepared in the background on first need. Progress and retry live in **Settings → Browser** (use **Prepare the bundled browser** after a failure). To prepare it ahead of time (offline images, CI), run `npx --no dsh-browser-install-electron` from that profile directory (network required). See the [setup guide](docs/user-guide.md#准备-electron-二进制) (Chinese).

### Both sides

Once installation is complete, ask the agent:

```
Open https://example.com and summarise the main content for me.
```

The browser window appears with the first call, and you can operate in it yourself at any point. **Either side can be pointed at your own installed Chrome / Edge** in settings — that option behaves identically on both.

## Choose a browser

| Option | How it works |
| --- | --- |
| Bundled browser | Opens pages in a separate window with an address bar, navigation controls, and tabs. |
| DSH sidebar | With the bridge installed on a Desktop build that exposes Electron `webview`, opening a URL expands the target conversation's sidebar browser. Lost connections reconnect to the selected sidebar. |
| Local Chrome / Edge | Launches the installed browser with a dedicated plugin profile. |
| Automatic | Chooses based on the available local browsers and desktop sidebar. |

Windows Desktop **Settings → Browser** provides installation, repair, and reinstallation with automatic restart. **Diagnostics** includes uninstall and restart, plus an external-terminal command. Progress and results survive the restart, and successful installation requires a verified connection to the new process. For terminal maintenance, exit Desktop normally and run this from the plugin directory:

~~~sh
node desktop-bridge/install.mjs "<DSH Desktop install directory>"
~~~

Preparation feedback appears immediately. While Desktop is closed, a separate progress window shows installation, startup, connection checks, and elapsed time, then closes after completion. The window stays in the background; closing it leaves maintenance running.

## Browser settings

- **Environment check** reports detected Chrome / Edge, the bundled runtime, and sidebar bridge availability. Automatic mode identifies the selected carrier; **Diagnostics** includes the executable path.
- **Quiet mode** preserves the operating system's foreground window and pointer position. New browser windows appear in the background, and minimized bundled browser windows stay minimized. With DSH sidebar selected, opening a URL reveals the target conversation's sidebar page; explicit tab switching selects the corresponding native tab.
- **Presentation** controls sidebar expansion, closing the browser with the session, the agent cursor, and remote viewing.
- **Agent permissions** controls page scripts, downloads, and reading or writing sign-in state.
- **Advanced settings** covers browsing history, permission for coordinate clicks and drags, and sign-in persistence and window mode for Chrome, Edge, and Automatic mode. The delivery form validates and saves the tool name, argument template, failure policy, and per-site rules together.

On the local machine or in an isolated test environment, turn on **Allow remote viewing** and open the DSH viewer for a read-only view of the browser session. The viewer refreshes JPEG frames up to twice per second.

## Download delivery

In **Advanced settings → Delivery**, enter an upload tool registered in DSH and configure its destination arguments. Automatic delivery uses the DSH native tool executor and retains the current task's tool permissions. The result includes the local download path and the upload tool's complete return value.

DSH sidebar downloads use the target page's authenticated browser session, stream to a temporary file, and commit the completed file while preserving existing destinations.

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
