<p align="center">
  <img src="https://img.shields.io/github/stars/wqty123/dsh-browser?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars">
  <img src="https://img.shields.io/npm/v/dsh-builtin-browser?style=flat&amp;label=npm&amp;color=CB3837" alt="npm version">
  <img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/DSH-Plugin-47848F?style=flat" alt="DeepSeek Harness plugin">
  <img src="https://img.shields.io/badge/Platform-Windows-4493F8?style=flat-square" alt="Platform: Windows (verified)">
</p>

<p align="center"><sub><a href="README.md">中文</a> · English</sub></p>

# Browser plugin for DeepSeek Harness

Browse inside the DSH sidebar, capture structured references, and use browser tools on the same visible page when the host supplies a controllable sidebar carrier. Each task has its own tabs and action history. External Chrome or Edge is an explicit opt-in, not a fallback.

This feature list matches **0.5.8** (compatible with DSH 0.2.2-alpha.3: plugin routes go through the host session auth). [Changelog](CHANGELOG.md)

## Quick start

**First, which side are you on** — these are two separate installs; updating one does not update the other, and they host the browser differently.

> **Updating an installed plugin takes two steps** (since DSH 0.2.1-alpha.2, installing over an installed package fails outright with `already-installed`): run `dsh plugin --profile <profile> remove dsh-builtin-browser` first, then `add` the target version. See the [user guide](docs/user-guide.md) (Chinese).

### DSH Desktop

```sh
dsh plugin --profile desktop add dsh-builtin-browser
```

When the desktop shell provides a controllable sidebar/webview carrier, the plugin drives the **official side panel**: the agent operates the very page you see. Without that capability, browser tools return an actionable error. They never start a standalone Electron window.

The existing legacy bridge installer modifies the desktop application. **Do not use its install/repair actions where upstream modifications are prohibited.** A compliant integration needs a supported host-provided carrier (`viewHost`) or sidebar API; installing this plugin alone cannot supply that missing host capability. Existing controllable sidebar connections can reconnect without switching carriers.

### Web (`dsh web`)

```sh
dsh plugin --profile web add dsh-builtin-browser
```

The Web sidebar uses an opaque-origin sandboxed iframe. Navigation and selection-reference submission stay inside DSH; guest pages cannot use DSH storage or authenticated API privileges. References travel to the owning app frame through a source-validated message channel. Sites requiring origin storage, workers or other sandbox-restricted features may not work in this carrier. CDP tools require a controllable desktop sidebar; unsupported Web operations report that capability limit rather than opening another browser.

### Both sides

Once installation is complete, ask the agent:

```
Open https://example.com and summarise the main content for me.
```

The default is `browser.channel: "sidebar"`. There is no standalone fallback and no automatic Electron download. **Only explicitly selecting `"chrome"` or `"edge"` permits an external browser**; keep `"sidebar"` for sidebar-only operation.

## Choose a browser

| Option | How it works |
| --- | --- |
| Bundled browser (legacy setting) | Alias for sidebar-only operation; never starts Electron. |
| DSH sidebar | With the bridge installed on a Desktop build that exposes Electron `webview`, opening a URL expands the target conversation's sidebar browser. Lost connections reconnect to the selected sidebar. |
| Local Chrome / Edge | Launches the installed browser with a dedicated plugin profile. |
| Automatic (legacy setting) | Alias for sidebar-only operation; never selects a local browser. |

Legacy maintenance controls are still present but are not a compliant way to obtain the missing host API. They are not run automatically by carrier selection.

## Browser settings

- **Environment check** reports detected Chrome / Edge, the bundled runtime, and sidebar bridge availability. Automatic mode identifies the selected carrier; **Diagnostics** includes the executable path.
- **Quiet mode** avoids raising the host window. With DSH sidebar selected, opening a URL reveals the target conversation's sidebar page; explicit tab switching selects the corresponding sidebar tab. Window behavior applies only to explicitly selected external browsers.
- **Presentation** controls sidebar expansion, closing the browser with the session, the agent cursor, and remote viewing.
- **Agent permissions** controls page scripts, downloads, and reading or writing sign-in state.
- **Advanced settings** covers browsing history, permission for coordinate clicks and drags, and sign-in persistence and window mode for explicitly selected Chrome or Edge. The delivery form validates and saves the tool name, argument template, failure policy, and per-site rules together.

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

The current source registers 51 tools. The table lists their names after the `dsh_browser_` prefix.

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
| Page references | `reference_capture` `reference_reveal` `reference_list` |
| Start-page shortcuts | `shortcuts` |
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
