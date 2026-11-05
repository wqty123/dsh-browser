/**
 * Browser settings panel (client half): the switches that decide how the shared
 * browser behaves — history retention, login-state persistence, presentation,
 * vision strategy, credential access, and which ACTIONS the agent may take —
 * the one group of switches written where no tool can reach them.
 *
 * The host half owns the document and serves it at `/dsh-builtin-browser/settings`;
 * this panel only renders it and sends patches, so the same file stays the single
 * source of truth (and hand-editable when no panel is reachable).
 *
 * Registered into the settings page's `settings.section` slot with an order above
 * the host's own rows, so it appears under them. Plain ModuleLoader bundle: no
 * build step, matching how the host loads plugin client halves.
 */
window.__ModuleLoader__.load({ id: "dsh-builtin-browser", factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

  const react = require("react")
  const h = react.createElement
  const { useCallback, useEffect, useRef, useState } = react

  const name = "dsh-builtin-browser"
  const inject = ["slots", "locale"]
  const NS = "settings.dsh-builtin-browser"
  const ROUTE = "/dsh-builtin-browser/settings"
  let translate = (key) => key
  /**
   * Re-evaluate the floating watch entry.
   *
   * Set by `installWatchPanel`, called by the settings writer after a `remoteView` change so the
   * switch takes effect on the spot. A no-op until the panel is installed, and a no-op forever on a
   * host without one.
   */
  let refreshWatchEntry = () => {}
  /**
   * Re-apply the locale to the watch panel's static labels.
   *
   * Set by `installWatchPanel`, called from the locale subscription in `apply()`. Separate from
   * {@link refreshWatchEntry} because a language switch must not re-probe or re-mount anything.
   */
  let refreshWatchLabels = () => {}

  const zh = {
    nav: "浏览器",
    "watch.open": "观看浏览器",
    "watch.title": "实时画面",
    "watch.readOnly": "只读,不转发点击与输入",
    "watch.stop": "停止",
    "watch.live": "直播",
    "watch.paused": "已暂停",
    "watch.stopped": "已停止",
    "watch.connecting": "连接中",
    "watch.disconnected": "连接中断",
    "watch.disabled": "主机未开启远程观看",
    "watch.noPage": "该任务尚未打开浏览器",
    "watch.bridgeStale": "桌面端升级后 bridge 已失效,请重跑安装:",
    "watch.bridgeMissing": "桌面 bridge 未安装,侧栏载体不可用。安装命令:",
    title: "浏览器",
    "settings.advanced": "高级设置",
    "settings.saving": "正在保存…",
    "settings.details": "配置文件",
    "browser.profile": "保留登录状态",
    "browser.headless": "窗口模式",
    "browser.headless.hint": "重启 DSH 后生效",
    "browser.headless.auto": "自动检测显示环境",
    "browser.headless.windowed": "显示窗口",
    "browser.headless.headless": "无头运行",
    "delivery.save": "保存交付设置",
    "delivery.invalid": "检查工具名、参数模板和站点规则。参数必须是字符串值的 JSON 对象，站点规则每行填写一个 host=工具名。",
    loading: "读取设置…",
    failed: "读取设置失败:",
    retry: "重试",
    saved: "已保存",
    "history.enabled": "保留浏览历史",
    "ui.title": "展示",
    "ui.autoExpandOnce": "侧栏自动展开(每轮一次)",
    "ui.closeWithSession": "会话结束时关闭浏览器",
    "ui.virtualCursor": "显示 Agent 光标",
    "ui.quiet": "安静模式",
    "ui.quiet.hint": "保留当前窗口和标签。新启动的 Chrome / Edge 在后台运行。",
    "vision.strategy": "页面定位",
    "vision.auto": "自动",
    "vision.nonVisual": "仅按页面结构",
    "credentials.allowRead": "允许 Agent 读取 cookies / 导出登录状态",
    "browser.channel": "默认浏览器",
    "browser.sidebar": "DSH 侧栏",
    "browser.bundled": "内置浏览器",
    "browser.chrome": "本机 Chrome",
    "browser.edge": "本机 Edge",
    "browser.auto": "自动",
    "actions.title": "Agent 权限",
    "actions.allowExecute": "允许在页面里执行脚本",
    "actions.allowDownload": "允许下载文件到磁盘",
    "actions.allowCredentialWrite": "允许写入登录状态",
    "actions.allowCredentialWrite.hint": "可向任意域写入 cookies。",
    "remoteView.enabled": "允许远程观看",
    "remoteView.enabled.hint": "共享只读画面，可能包含敏感信息。",
    "readiness.title": "就绪状态",
    "readiness.loading": "检测中…",
    "readiness.failed": "读取就绪状态失败:",
    "readiness.channel": "配置的载体",
    "readiness.details": "诊断",
    "readiness.electron": "内置浏览器运行时",
    "readiness.bridge": "桌面侧栏 bridge",
    "readiness.recheck": "重新检测",
    "readiness.prepare": "准备内置浏览器",
    "readiness.preparing": "正在准备…",
    "readiness.fix": "修复命令",
    "readiness.carrier.sidebar": "桌面侧栏",
    "readiness.carrier.bundled": "内置 Electron",
    "readiness.carrier.system": "本机 Chrome / Edge",
    "readiness.carrier.auto": "自动",
    "readiness.state.ready": "可用",
    "readiness.state.blocked": "尚不可用",
    "readiness.state.unknown": "需实际启动才能确定",
    "readiness.electron.present": "已就绪",
    "readiness.electron.ready": "已就绪",
    "readiness.electron.preparing": "正在下载",
    "readiness.electron.idle": "尚未开始准备",
    "readiness.electron.skipped": "已跳过(设置了 ELECTRON_SKIP_BINARY_DOWNLOAD)",
    "readiness.electron.failed": "准备失败",
    "readiness.bridge.installed": "已安装",
    "readiness.bridge.installedRunning": "已安装(桌面端正在运行)",
    "readiness.bridge.installedNotRunning": "已安装,但桌面端没在运行",
    "readiness.bridge.missing": "未安装",
    "readiness.bridge.stale": "已失效(桌面端升级后需重装)",
    "readiness.bridge.absent": "本机没有桌面端",
    "delivery.title": "交付",
    "delivery.tool": "接手下载的工具(MCP 工具名,留空=只存本地)",
    "delivery.args": "参数模板(JSON)",
    "delivery.args.hint": "占位 {path} {name} {size}。",
    "delivery.onFail": "远程失败时",
    "delivery.onFail.keep": "保留本地文件并报告两边结果",
    "delivery.onFail.stop": "按失败处理",
    "delivery.sites": "按站点覆盖(每行 host=工具名)",
  }

  const en = {
    nav: "Browser",
    "watch.open": "Watch browser",
    "watch.title": "Live view",
    "watch.readOnly": "Read-only; clicks and typing are not forwarded",
    "watch.stop": "Stop",
    "watch.live": "Live",
    "watch.paused": "Paused",
    "watch.stopped": "Stopped",
    "watch.connecting": "Connecting",
    "watch.disconnected": "Disconnected",
    "watch.disabled": "Remote viewing is off on the host",
    "watch.noPage": "This task has not opened a browser",
    "watch.bridgeStale": "A desktop update invalidated the bridge; re-run:",
    "watch.bridgeMissing": "The desktop bridge is not installed, so the sidebar carrier cannot work:",
    title: "Browser",
    "settings.advanced": "Advanced settings",
    "settings.saving": "Saving…",
    "settings.details": "Configuration file",
    "browser.profile": "Keep sign-ins",
    "browser.headless": "Window mode",
    "browser.headless.hint": "Requires restarting DSH",
    "browser.headless.auto": "Detect display automatically",
    "browser.headless.windowed": "Show a window",
    "browser.headless.headless": "Run headless",
    "delivery.save": "Save delivery settings",
    "delivery.invalid": "Check tool names, the argument template, and site rules. Use a JSON object with string values and one host=tool rule per line.",
    loading: "Loading settings…",
    failed: "Could not load settings:",
    retry: "Retry",
    saved: "Saved",
    "history.enabled": "Keep browsing history",
    "ui.title": "Presentation",
    "ui.autoExpandOnce": "Auto-expand the side panel (once per task)",
    "ui.closeWithSession": "Close the browser when the session ends",
    "ui.virtualCursor": "Show agent cursor",
    "ui.quiet": "Quiet mode",
    "ui.quiet.hint": "Keeps your current window and tab. New Chrome / Edge instances run in the background.",
    "vision.strategy": "Page targeting",
    "vision.auto": "Automatic",
    "vision.nonVisual": "Page structure only",
    "credentials.allowRead": "Allow the agent to read cookies / export login state",
    "browser.channel": "Default browser",
    "browser.sidebar": "DSH sidebar",
    "browser.bundled": "Bundled browser",
    "browser.chrome": "Installed Chrome",
    "browser.edge": "Installed Edge",
    "browser.auto": "Automatic",
    "actions.title": "Agent permissions",
    "actions.allowExecute": "Run scripts in the page",
    "actions.allowDownload": "Download files to disk",
    "actions.allowCredentialWrite": "Write login state",
    "actions.allowCredentialWrite.hint": "Write cookies to any domain.",
    "remoteView.enabled": "Allow remote viewing",
    "remoteView.enabled.hint": "Shares a read-only view that may contain sensitive information.",
    "readiness.title": "Readiness",
    "readiness.loading": "Checking…",
    "readiness.failed": "Could not read readiness:",
    "readiness.channel": "Configured carrier",
    "readiness.details": "Diagnostics",
    "readiness.electron": "Bundled browser runtime",
    "readiness.bridge": "Desktop sidebar bridge",
    "readiness.recheck": "Check again",
    "readiness.prepare": "Prepare the bundled browser",
    "readiness.preparing": "Preparing…",
    "readiness.fix": "Repair command",
    "readiness.carrier.sidebar": "Desktop sidebar",
    "readiness.carrier.bundled": "Bundled Electron",
    "readiness.carrier.system": "Installed Chrome / Edge",
    "readiness.carrier.auto": "Automatic",
    "readiness.state.ready": "Ready",
    "readiness.state.blocked": "Not ready yet",
    "readiness.state.unknown": "Only a real launch can tell",
    "readiness.electron.present": "Ready",
    "readiness.electron.ready": "Ready",
    "readiness.electron.preparing": "Downloading",
    "readiness.electron.idle": "Not prepared yet",
    "readiness.electron.skipped": "Skipped (ELECTRON_SKIP_BINARY_DOWNLOAD is set)",
    "readiness.electron.failed": "Preparation failed",
    "readiness.bridge.installed": "Installed",
    "readiness.bridge.installedRunning": "Installed (the desktop app is running)",
    "readiness.bridge.installedNotRunning": "Installed, but the desktop app is not running",
    "readiness.bridge.missing": "Not installed",
    "readiness.bridge.stale": "Stale (a desktop update needs a reinstall)",
    "readiness.bridge.absent": "No desktop install on this machine",
    "delivery.title": "Delivery",
    "delivery.tool": "Tool that takes the download (MCP tool name; empty = local only)",
    "delivery.args": "Argument template (JSON)",
    "delivery.args.hint": "Placeholders: {path} {name} {size}.",
    "delivery.onFail": "When the remote side fails",
    "delivery.onFail.keep": "Keep the local file and report both outcomes",
    "delivery.onFail.stop": "Treat it as a failure",
    "delivery.sites": "Per-site override (one host=tool per line)",
  }

  /**
   * Read or patch the host-owned settings document.
   *
   * A patch that touches remote viewing re-evaluates the floating entry right away. Without that,
   * turning the switch on wrote the file and did nothing anyone could see until the page was
   * reloaded — unusable from a phone, and reported as such on #46.
   */
  async function callSettings(patch) {
    const response = await fetch(ROUTE, patch === undefined
      ? { method: "GET", headers: { accept: "application/json" } }
      : {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      })
    const data = await response.json().catch(() => undefined)
    if (data === undefined || data.ok !== true) {
      throw new Error((data && data.error) || `HTTP ${response.status}`)
    }
    if (patch !== undefined && patch !== null && typeof patch === "object" && patch.remoteView !== undefined) {
      try { refreshWatchEntry() } catch { /* the entry is a convenience, not the setting */ }
    }
    return data
  }

  /**
   * The panel's own stylesheet.
   *
   * Inline styles cannot express `:hover`, and the rows need one — an interactive row with no
   * feedback reads as decoration. The colours come from DSH's own design tokens
   * (`--dsw-alias-*`, the same ones the host's settings rows use) so this follows the active
   * theme instead of guessing at it; each has a literal fallback because a token may be absent
   * under a third-party theme, and an unstyled row is worse than a slightly-off one.
   */
  const CSS = `
.dsh-bb-settings .dsh-bb-row {
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: .5px solid var(--dsw-alias-border-l2, GrayText);
  border-radius: 0;
  background: transparent;
}
.dsh-bb-settings { font-size: 14px; line-height: 22px; }
.dsh-bb-settings .dsh-bb-diagnostics { margin-top: 4px; }
.dsh-bb-diagnostics code { display: block; }
.dsh-bb-toggle { justify-content: space-between; cursor: pointer; }
.dsh-bb-toggle:has(:disabled) { cursor: default; }
.dsh-bb-switch {
  appearance: none;
  position: relative;
  flex: 0 0 36px;
  width: 36px;
  height: 20px;
  margin: 0;
  box-sizing: border-box;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-border-l3, GrayText);
  color: var(--dsw-alias-switch-thumb, Canvas);
  cursor: inherit;
}
.dsh-bb-switch::after {
  content: "";
  position: absolute;
  inset: 2px auto auto 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  corner-shape: round;
  background: currentColor;
}
.dsh-bb-switch:checked {
  background: var(--dsw-alias-brand-primary, Highlight);
  color: var(--dsw-alias-label-primary-foreground, HighlightText);
}
.dsh-bb-switch:checked::after { transform: translateX(16px); }
.dsh-bb-switch:disabled { opacity: .6; }
.dsh-bb-settings :is(button, input, textarea, select, summary):focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, Highlight);
  outline-offset: 2px;
}
.dsh-bb-settings summary { cursor: pointer; padding: 5px 0; }
.dsh-bb-settings .dsh-bb-dd { flex: 0 1 auto; margin: 0; }
.dsh-bb-settings .dsh-bb-dd-btn {
  min-height: 36px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-module-platform, ButtonFace);
}
.dsh-bb-settings .dsh-bb-dd-list { left: auto; right: 0; }
.dsh-bb-settings .dsh-bb-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border, GrayText);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1, Canvas);
  color: var(--dsw-alias-label-primary, CanvasText);
  font: inherit;
}
.dsh-bb-settings fieldset { min-inline-size: 0; }
.dsh-bb-settings textarea { resize: vertical; }
.dsh-bb-row {
  border-radius: 8px;
  padding: 7px 9px;
  color: var(--dsw-alias-label-primary, inherit);
  transition: background-color .12s ease;
}
/* No resting background: a permanent grey block behind every row reads as a set of buttons
   rather than a list of settings. The highlight belongs to the pointer, not to the row. */
.dsh-bb-row:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15));
}
.dsh-bb-row:active {
  background: var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.22));
}
.dsh-bb-row:focus-within {
  border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.4));
}
/* The dropdown is drawn here rather than by the OS.
   A native <select> paints its popup with system colours on Windows: the highlight overrides
   whatever the option sets (white text on a white bar), and the list carries a border no CSS
   can remove. Only the collapsed control is styleable, so a panel that matches its theme
   everywhere else ends up with one control that does not. Everything below is ours: the
   surface, the highlight, and the absence of that line. */
.dsh-bb-dd {
  position: relative;
  display: inline-block;
  margin-top: 4px;
}
.dsh-bb-dd-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  padding: 4px 8px 4px 9px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12));
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-bb-dd-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18));
}
.dsh-bb-dd-btn:disabled { opacity: .55; cursor: default; }
.dsh-bb-dd-caret { opacity: .6; font-size: 10px; line-height: 1; }
.dsh-bb-dd-list {
  position: absolute;
  z-index: 20;
  top: calc(100% + 4px);
  left: 0;
  min-width: 100%;
  max-width: 340px;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #2f2f2f);
  box-shadow: 0 6px 20px rgba(0,0,0,.28);
}
.dsh-bb-dd-opt {
  display: block;
  width: 100%;
  padding: 6px 9px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
/* The same ellipse the rows use, so the panel reads as one surface — and it is ours to draw,
   which is the whole reason this control exists. */
.dsh-bb-dd-opt:hover,
.dsh-bb-dd-opt[data-active="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18));
}
.dsh-bb-dd-opt[aria-selected="true"] { font-weight: 600; }

/* Live-view panel. Fixed layer rather than a slot: the host has no stable slot for an extra
   surface over the conversation, and a layer works in every layout including a phone. */
.dsh-bw-watch {
  position: fixed; right: 16px; bottom: 16px; font-family: inherit;
  /* Below a modal or popover rather than above everything: the old 2147483000 sat on top of the page,
   * its inputs and any dialog the host opened (issue #46). A floating helper is a guest here. */
  z-index: 1000;
}
.dsh-bw-watch-open {
  display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.45)); border-radius: 999px;
  padding: 7px 13px; font-size: 12px; color: inherit;
  background: var(--dsw-alias-interactive-bg, rgba(128,128,128,.12));
}
.dsh-bw-watch-open:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.2)); }
.dsh-bw-watch-dot { width: 7px; height: 7px; border-radius: 50%; background: #d9534f; }
.dsh-bw-watch-panel {
  position: absolute; right: 0; bottom: calc(100% + 8px); width: min(560px, calc(100vw - 32px));
  /* The panel used to sit at 40px from the bottom while the button it hangs off occupied 16-46px
   * from the bottom edge of its own box: the two overlapped by 6px and, because the panel's
   * background is opaque, it covered the only way back out (issue #46). 100% is the button's own
   * height, so the gap survives a font-size or padding change instead of being a second magic
   * number. */
  border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.35)); border-radius: 10px;
  /* --dsw-alias-bg-elevated does not exist in the theme this ships against (measured on rc.5: 0
   * occurrences, while --dsw-alias-bg-layer-2 has 5). With a token that is never defined, the
   * fallback is what everyone sees — a dark card in a light theme. bg-layer-2 is the token the
   * host's own elevated rows use. */
  background: var(--dsw-alias-bg-layer-2, #1b1b1f); color: inherit; overflow: hidden;
  box-shadow: 0 10px 30px rgba(0,0,0,.35);
}
.dsh-bw-watch-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; font-size: 12px; }
.dsh-bw-watch-title { font-weight: 600; }
.dsh-bw-watch-state { opacity: .7; margin-left: auto; }
.dsh-bw-watch-close {
  /* A visible control, not a hinted one: the old close was a 16px glyph at 70% opacity with no border
   * or background, in the same colour as the title — reported as 'no way out but a page refresh'
   * (issue #46). */
  border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.45)); border-radius: 6px;
  background: var(--dsw-alias-interactive-bg, rgba(128,128,128,.12));
  color: inherit; cursor: pointer; font-size: 14px; line-height: 1; padding: 3px 7px;
}
.dsh-bw-watch-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.2)); }
.dsh-bw-watch-stage { background: #000; min-height: 120px; display: flex; align-items: center; justify-content: center; }
.dsh-bw-watch-img { display: block; max-width: 100%; height: auto; }
/* The hidden ATTRIBUTE is styled by the UA sheet as [hidden]{display:none}, and an author rule
 * defeats it whatever its specificity — so img.hidden = true in the script did nothing and the
 * empty-state image kept taking space (issue #46). */
.dsh-bw-watch-img[hidden] { display: none; }
.dsh-bw-watch-note { margin: 0; padding: 24px 14px; font-size: 12px; opacity: .75; text-align: center; }
.dsh-bw-watch-foot {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  font-size: 11px; border-top: 1px solid var(--dsw-alias-border, rgba(128,128,128,.25));
}
.dsh-bw-watch-readonly { opacity: .6; }
.dsh-bw-watch-bridge { padding: 8px 10px; font-size: 11px; border-bottom: 1px solid var(--dsw-alias-border, rgba(128,128,128,.25)); background: rgba(217,83,79,.12); }
.dsh-bw-watch-bridge-line { line-height: 1.5; }
.dsh-bw-watch-bridge-cmd { display: block; margin-top: 5px; padding: 5px 7px; font-size: 11px; white-space: pre-wrap; word-break: break-all; background: rgba(0,0,0,.28); border-radius: 5px; }
.dsh-bw-watch-stop {
  margin-left: auto; cursor: pointer; font-size: 11px; padding: 4px 10px;
  border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.45)); border-radius: 6px;
  background: transparent; color: inherit;
}
`

  /** Install the stylesheet once, however many times the panel is mounted. */
  function installStyles() {
    if (typeof document === "undefined") return
    if (document.getElementById("dsh-builtin-browser-styles") !== null) return
    const tag = document.createElement("style")
    tag.id = "dsh-builtin-browser-styles"
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  const styles = {
    wrap: { display: "flex", flexDirection: "column", gap: "12px" },
    lead: { opacity: 0.75, lineHeight: 1.6, margin: 0 },
    group: { minWidth: 0 },
    groupTitle: { margin: "0 0 2px", fontSize: "14px", fontWeight: 600, color: "var(--dsw-alias-label-primary, inherit)" },
    row: { display: "flex", gap: "10px", alignItems: "flex-start" },
    label: { display: "flex", flexDirection: "column", gap: "2px", cursor: "pointer" },
    hint: { color: "var(--dsw-alias-label-tertiary, inherit)", fontSize: "12px", lineHeight: 1.5 },
    status: { opacity: 0.7, minHeight: "18px" },
    error: { color: "var(--dsw-alias-label-error, #c9342c)" },
    pathLine: { opacity: 0.6, wordBreak: "break-all", lineHeight: 1.5 },
    button: { minHeight: "32px", padding: "5px 12px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border, rgba(128,128,128,.4))", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" },
    // Readiness: one headline state, three one-line facts, and at most two buttons. The colours are
    // the only place this panel states an opinion, which is why they carry no text of their own —
    // the label next to them is always a locale string.
    badge: { display: "inline-block", padding: "1px 8px", marginRight: "8px", borderRadius: "10px", fontSize: "11px", lineHeight: 1.6, border: "1px solid transparent" },
    badgeOk: { color: "#2f9e44", borderColor: "rgba(47,158,68,.5)", background: "rgba(47,158,68,.12)" },
    badgeWarn: { color: "#e5534b", borderColor: "rgba(229,83,75,.5)", background: "rgba(229,83,75,.12)" },
    badgeUnknown: { color: "#a0a0a8", borderColor: "rgba(160,160,168,.5)", background: "rgba(160,160,168,.12)" },
    kv: { display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 12px", margin: "8px 0 0", fontSize: "12px" },
    kvKey: { opacity: 0.68 },
    kvVal: { lineHeight: 1.5 },
    mono: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: "11px", whiteSpace: "pre-wrap", wordBreak: "break-all", background: "var(--dsw-alias-bg-layer-2, rgba(0,0,0,.22))", borderRadius: "5px", padding: "4px 6px", marginTop: "4px" },
    buttons: { display: "flex", gap: "8px", alignItems: "center", marginTop: "10px", flexWrap: "wrap" },
  }

  /**
   * A dropdown drawn by this panel rather than by the operating system.
   *
   * Replaces a native `<select>`, whose popup Windows paints with system colours: the hover
   * highlight overrode the option's background (white text on a white bar) and the list carried
   * a border no CSS could remove. Both are unfixable from outside the control, and this panel's
   * two dropdowns were the only places it did not match its own theme.
   *
   * Keyboard and assistive-technology behaviour is reimplemented rather than inherited, which is
   * the cost of owning the rendering: Up/Down move, Enter/Space commit, Escape closes and
   * returns focus, Home/End jump, clicking outside closes.
   */
  function Dropdown(props) {
    const [open, setOpen] = useState(false)
    // Index the keyboard has moved to; -1 means "the selected value, unless the user moved".
    const [active, setActive] = useState(-1)
    const rootRef = useRef(null)
    const buttonRef = useRef(null)

    const selected = props.options.findIndex(option => option.value === props.value)
    const current = props.options[selected] ?? props.options[0]

    useEffect(() => {
      if (!open) return undefined
      const away = event => {
        if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
      }
      document.addEventListener("mousedown", away)
      return () => document.removeEventListener("mousedown", away)
    }, [open])

    const commit = index => {
      const option = props.options[index]
      if (option === undefined) return
      setOpen(false)
      setActive(-1)
      buttonRef.current?.focus()
      if (option.value !== props.value) props.onChange(option.value)
    }

    const onKeyDown = event => {
      if (event.key === "Escape") {
        if (open) { event.preventDefault(); setOpen(false); buttonRef.current?.focus() }
        return
      }
      if (!open && (event.key === "Enter" || event.key === " " || event.key === "ArrowDown")) {
        event.preventDefault()
        setOpen(true)
        setActive(selected >= 0 ? selected : 0)
        return
      }
      if (!open) return
      const last = props.options.length - 1
      if (event.key === "ArrowDown") { event.preventDefault(); setActive(a => Math.min(last, (a < 0 ? selected : a) + 1)) }
      else if (event.key === "ArrowUp") { event.preventDefault(); setActive(a => Math.max(0, (a < 0 ? selected : a) - 1)) }
      else if (event.key === "Home") { event.preventDefault(); setActive(0) }
      else if (event.key === "End") { event.preventDefault(); setActive(last) }
      else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); commit(active < 0 ? selected : active) }
    }

    return h("div", { key: "s", className: "dsh-bb-dd", ref: rootRef }, [
      h("button", {
        key: "b",
        type: "button",
        ref: buttonRef,
        className: "dsh-bb-dd-btn",
        "aria-label": props.label + ": " + (current?.label ?? ""),
        disabled: props.disabled,
        "aria-haspopup": "listbox",
        "aria-expanded": open ? "true" : "false",
        onBlur: event => {
          if (!rootRef.current?.contains(event.relatedTarget)) setOpen(false)
        },
        onClick: () => { setOpen(o => !o); setActive(-1) },
        onKeyDown,
      }, [
        h("span", { key: "v" }, current === undefined ? "" : current.label),
        h("span", { key: "c", className: "dsh-bb-dd-caret", "aria-hidden": "true" }, "\u25be"),
      ]),
      open ? h("div", {
        key: "l",
        className: "dsh-bb-dd-list",
        role: "listbox",
        "aria-label": props.label,
      }, props.options.map((option, index) => h("button", {
        key: option.value,
        type: "button",
        className: "dsh-bb-dd-opt",
        role: "option",
        tabIndex: -1,
        "aria-selected": option.value === props.value ? "true" : "false",
        onMouseDown: event => event.preventDefault(),
        "data-active": index === active ? "true" : "false",
        onMouseEnter: () => setActive(index),
        onClick: () => commit(index),
      }, option.label))) : null,
    ])
  }

  /** One boolean switch bound to a settings path. */
  function Toggle(props) {
    const t = translate
    return h("label", { style: styles.row, className: "dsh-bb-row dsh-bb-toggle" }, [
      h("span", { key: "l", style: styles.label }, [
        h("span", { key: "t" }, t(props.labelKey)),
        props.hintKey ? h("span", { key: "h", style: styles.hint }, t(props.hintKey)) : null,
      ]),
      h("input", {
        key: "i",
        type: "checkbox",
        className: "dsh-bb-switch",
        role: "switch",
        "aria-label": t(props.labelKey),
        checked: props.checked,
        disabled: props.busy,
        onChange: event => props.onChange(event.target.checked),
      }),
    ])
  }

  /**
   * Re-render this component when the interface language changes at run time.
   *
   * `translate` is a module-level binding that `apply()` re-binds on every locale snapshot, but
   * React has no idea that happened: every label rendered so far keeps the language it was rendered
   * in, which is exactly the defect the watch panel hit (#40) and the one commit `666cbff` fixed for
   * that panel's DOM. The settings section is rendered by React, so it needs the notification rather
   * than a text pass.
   */
  let localeVersion = 0
  const localeWatchers = new Set()
  function useLocaleVersion() {
    const [, setVersion] = useState(localeVersion)
    useEffect(() => {
      const update = () => setVersion(localeVersion)
      localeWatchers.add(update)
      return () => { localeWatchers.delete(update) }
    }, [])
  }

  /**
   * Readiness: can the browser serve a call right now, and what is missing if not.
   *
   * This is the "it works once you install it" promise, made visible. The bundled runtime downloads
   * on first need (issue #41 moved the download out of `postinstall`), so on a fresh install the
   * honest answer for the first minute is "a download is running" — a state that used to exist only
   * in a log line. Everything shown here comes from `GET /runtime-status`; the button starts the
   * same one background attempt the plugin makes on its own, which is why pressing it is never
   * harmful and never starts a second download.
   */
  function Readiness({ channel } = {}) {
    useLocaleVersion()
    const t = translate
    const [runtime, setRuntime] = useState(null)
    const [error, setError] = useState("")
    const [unsupported, setUnsupported] = useState(false)
    const [busy, setBusy] = useState(false)
    const alive = useRef(true)

    const read = useCallback(async () => {
      try {
        const response = await fetch("/dsh-builtin-browser/runtime-status", { headers: { accept: "application/json" } })
        // A host that predates this route answers 404, and that is a version skew rather than a
        // fault: after an update the client bundle is read at request time while the host's code is
        // what started with the process. Rendering "could not read readiness: HTTP 404" at a user who
        // simply has not restarted yet would be reporting the skew as their problem — so the section
        // stays out of the way, exactly like a document with no `actions` section.
        if (response.status === 404) {
          if (alive.current) { setUnsupported(true); setRuntime(null); setError("") }
          return null
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        if (!alive.current) return null
        setUnsupported(false)
        setRuntime(data && data.runtime ? data.runtime : null)
        setError("")
        return data && data.runtime ? data.runtime : null
      } catch (failure) {
        if (!alive.current) return null
        setError(String(failure && failure.message ? failure.message : failure))
        return null
      }
    }, [])

    useEffect(() => {
      alive.current = true
      void read()
      return () => { alive.current = false }
    }, [read, channel])

    // Poll only while a download is running: that is the one state that changes on its own, and a
    // poll in any other state would be a background request per panel per two seconds forever.
    const preparing = runtime !== null && runtime.electron.state === "preparing"
    useEffect(() => {
      if (!preparing) return undefined
      const timer = setTimeout(() => { void read() }, 2000)
      return () => clearTimeout(timer)
    }, [preparing, runtime, read])

    const prepare = async () => {
      setBusy(true)
      setError("")
      try {
        const response = await fetch("/dsh-builtin-browser/runtime-provision", {
          method: "POST",
          headers: { accept: "application/json" },
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error((data && data.error) || `HTTP ${response.status}`)
        if (alive.current && data && data.runtime) setRuntime(data.runtime)
      } catch (failure) {
        if (alive.current) setError(String(failure && failure.message ? failure.message : failure))
      } finally {
        if (alive.current) setBusy(false)
        void read()
      }
    }

    if (unsupported) return null
    if (runtime === null) {
      return h("div", { style: styles.wrap }, [
        h("p", { key: "l", style: styles.lead }, error === "" ? t("readiness.loading") : `${t("readiness.failed")} ${error}`),
      ])
    }

    const tone = runtime.readiness === "ready" ? styles.badgeOk
      : runtime.readiness === "blocked" ? styles.badgeWarn : styles.badgeUnknown
    const row = (key, label, value) => [
      h("span", { key: `${key}-k`, style: styles.kvKey }, label),
      h("span", { key: `${key}-v`, style: styles.kvVal }, value),
    ]
    // "Installed" and "running" are different facts, and the gap between them is the most common
    // broken state there is (the desktop app is simply closed). The row says which one it means —
    // and when the host does not report the running half at all, it says the plain truth rather
    // than inferring "not running" from an absent field.
    const bridgeLabel = runtime.bridge.state !== "installed"
      ? t(`readiness.bridge.${runtime.bridge.state}`)
      : runtime.bridge.running === true
        ? t("readiness.bridge.installedRunning")
        : runtime.bridge.running === false
          ? t("readiness.bridge.installedNotRunning")
          : t("readiness.bridge.installed")

    return h("div", { style: styles.group }, [
      h("div", { key: "head", className: "dsh-bb-row", style: styles.row }, [
        h("span", { key: "title" }, t("readiness.title")),
        h("span", { key: "state", role: "status", style: { ...styles.badge, ...tone } }, t(`readiness.state.${runtime.readiness}`)),
      ]),
      h("details", { key: "diagnostics", className: "dsh-bb-diagnostics" }, [
        h("summary", { key: "title", style: styles.hint }, t("readiness.details")),
        h("div", { key: "kv", style: styles.kv }, [
          ...row("carrier", t("readiness.channel"), t(`readiness.carrier.${runtime.carrier}`)),
          ...row("electron", t("readiness.electron"), t(`readiness.electron.${runtime.electron.state}`)),
          ...row("bridge", t("readiness.bridge"), bridgeLabel),
        ]),
        runtime.electron.state === "failed" || runtime.electron.state === "skipped"
          ? h("p", { key: "edetail", style: styles.hint }, runtime.electron.detail) : null,
        runtime.bridge.state === "installed" && runtime.bridge.running === false
          ? h("p", { key: "bdetail", style: styles.hint }, runtime.bridge.runningDetail ?? runtime.bridge.detail) : null,
        runtime.bridge.command && runtime.bridge.state !== "installed"
          ? h("p", { key: "command", style: styles.hint }, [
            h("span", { key: "label" }, t("readiness.fix")),
            h("code", { key: "value", style: styles.mono }, runtime.bridge.command),
          ]) : null,
        h("button", {
          key: "recheck",
          type: "button",
          style: styles.button,
          disabled: busy || preparing,
          onClick: () => { void read() },
        }, t("readiness.recheck")),
      ]),
      runtime.canProvision || preparing
        ? h("div", { key: "buttons", style: styles.buttons }, [
          preparing ? h("span", { key: "progress", role: "status", style: styles.hint }, t("readiness.preparing")) : null,
          runtime.canProvision ? h("button", { key: "prepare", type: "button", style: styles.button, disabled: busy, onClick: () => { void prepare() } }, t("readiness.prepare")) : null,
        ]) : null,
      error !== "" ? h("p", { key: "error", role: "alert", style: styles.error }, t("readiness.failed") + " " + error) : null,
    ])
  }

  /** Save the delivery fields together so moving focus never writes a partial template. */
  function DeliverySettings({ delivery, busy, onSave }) {
    const t = translate
    const [invalid, setInvalid] = useState(false)
    const toolPattern = /^[A-Za-z0-9_.-]+$/
    const submit = event => {
      event.preventDefault()
      const fields = event.currentTarget.elements
      const tool = fields.namedItem("tool").value.trim()
      const onFail = fields.namedItem("onFail").value
      const rules = fields.namedItem("sites").value.split("\n").filter(line => line.trim() !== "")
      const entries = rules.map(line => line.split("=").map(value => value.trim()))
      let args
      try {
        args = JSON.parse(fields.namedItem("args").value)
      } catch {
        setInvalid(true)
        return
      }
      if ((tool !== "" && !toolPattern.test(tool))
        || args === null || typeof args !== "object" || Array.isArray(args)
        || Object.values(args).some(value => typeof value !== "string")
        || entries.some(entry => entry.length !== 2 || !/^[A-Za-z0-9.-]+$/.test(entry[0]) || !toolPattern.test(entry[1]))) {
        setInvalid(true)
        return
      }
      const sites = Object.fromEntries(entries.map(([host, name]) => [host.toLowerCase(), name]))
      if (Object.keys(sites).length !== entries.length) {
        setInvalid(true)
        return
      }
      setInvalid(false)
      onSave({ tool, args, onFail, sites })
    }
    const field = (name, control) => h("label", { key: name, style: styles.label }, [
      h("span", { key: "label" }, t("delivery." + name)),
      control,
      name === "args" ? h("span", { key: "hint", style: styles.hint }, t("delivery.args.hint")) : null,
    ])
    return h("form", { onSubmit: submit }, [
      h("fieldset", { key: "fields", disabled: busy, style: { border: 0, margin: 0, padding: 0, display: "grid", gap: "10px" } }, [
        field("tool", h("input", { key: "control", name: "tool", className: "dsh-bb-input", defaultValue: delivery?.tool ?? "", placeholder: "lark_drive_upload" })),
        field("args", h("textarea", { key: "control", name: "args", className: "dsh-bb-input", rows: 3, defaultValue: JSON.stringify(delivery?.args ?? { file_path: "{path}" }, null, 2) })),
        field("onFail", h("select", { key: "control", name: "onFail", className: "dsh-bb-input", defaultValue: delivery?.onFail ?? "keep-local" }, [
          h("option", { key: "keep", value: "keep-local" }, t("delivery.onFail.keep")),
          h("option", { key: "stop", value: "stop" }, t("delivery.onFail.stop")),
        ])),
        field("sites", h("textarea", { key: "control", name: "sites", className: "dsh-bb-input", rows: 3, defaultValue: Object.entries(delivery?.sites ?? {}).map(([host, tool]) => host + "=" + tool).join("\n") })),
        h("div", { key: "actions" }, h("button", { type: "submit", style: styles.button }, t("delivery.save"))),
      ]),
      invalid ? h("p", { key: "error", role: "alert", style: styles.error }, t("delivery.invalid")) : null,
    ])
  }

  /** The settings page section. */
  function SettingsRoot() {
    useLocaleVersion()
    const t = translate
    const [rawSettings, setSettings] = useState(null)
    const [meta, setMeta] = useState({ path: "" })
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)
    const [saved, setSaved] = useState(false)
    const saving = useRef(false)
    const savedTimer = useRef(null)

    const load = useCallback(() => {
      setError("")
      callSettings().then(data => {
        setSettings(data.settings)
        setMeta({ path: data.path || "" })
      }).catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
    }, [])

    useEffect(() => { load() }, [load])
    useEffect(() => () => clearTimeout(savedTimer.current), [])

    const patch = useCallback(next => {
      if (saving.current) return
      saving.current = true
      clearTimeout(savedTimer.current)
      setSaved(false)
      setBusy(true)
      setError("")
      callSettings(next).then(data => {
        setSettings(data.settings)
        setSaved(true)
        savedTimer.current = setTimeout(() => setSaved(false), 1800)
      }).catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
        .finally(() => {
          saving.current = false
          setBusy(false)
        })
    }, [])

    if (rawSettings === null) {
      return h("div", { style: styles.wrap }, [
        error === "" ? h("p", { key: "l", role: "status", style: styles.lead }, t("loading")) : null,
        error !== "" ? h("p", { key: "e", style: styles.error }, `${t("failed")} ${error}`) : null,
        error !== "" ? h("button", { key: "retry", type: "button", style: styles.button, onClick: load }, t("retry")) : null,
      ])
    }

    // A document served by an OLDER host has no `actions` section — which is exactly the state
    // an update leaves behind when the host has not been restarted yet (the client bundle is
    // read at request time, the host's code at startup). Rendering `settings.actions.allowExecute`
    // off that threw, and the throw took the whole panel with it: the section did not merely show
    // stale values, it refused to open. Fill the gap with the defaults an older host behaves by,
    // which is also the honest reading — it has no such switch, so "on" is what it does.
    const settings = rawSettings.actions === undefined
      ? { ...rawSettings, actions: { allowExecute: true, allowDownload: true, allowCredentialWrite: true } }
      : rawSettings

    const toggle = (group, key, labelKey = group + "." + key, hintKey) => h(Toggle, {
      key,
      labelKey,
      hintKey,
      checked: settings[group]?.[key] ?? (group === "cookies" && key === "persist"),
      busy,
      onChange: value => patch({ [group]: { [key]: value } }),
    })
    const selector = (labelKey, value, options, onChange, hintKey) => h("div", {
      key: labelKey,
      className: "dsh-bb-row",
      style: styles.row,
    }, [
      h("span", { key: "text", style: styles.label }, [
        h("span", { key: "label" }, t(labelKey)),
        hintKey ? h("span", { key: "hint", style: styles.hint }, t(hintKey)) : null,
      ]),
      h(Dropdown, { key: "select", label: t(labelKey), value, options, disabled: busy, onChange }),
    ])
    const options = (prefix, values) => values.map(value => ({ value, label: t(prefix + value) }))
    const section = (titleKey, children) => h("section", { key: titleKey, style: styles.group }, [
      h("h3", { key: "title", style: styles.groupTitle }, t(titleKey)),
      ...children,
    ])
    const systemBrowser = settings.browser.channel === "chrome" || settings.browser.channel === "edge"

    return h("div", { style: styles.wrap, className: "dsh-bb-settings" }, [
      selector("browser.channel", settings.browser.channel,
        options("browser.", ["bundled", "sidebar", "auto", "chrome", "edge"]),
        channel => patch({ browser: { channel } })),
      h(Readiness, { key: "readiness", channel: settings.browser.channel }),
      section("ui.title", [
        toggle("ui", "quiet", "ui.quiet", "ui.quiet.hint"),
        toggle("ui", "autoExpandOnce"),
        toggle("ui", "closeWithSession"),
        toggle("ui", "virtualCursor"),
        toggle("remoteView", "enabled", "remoteView.enabled", "remoteView.enabled.hint"),
      ]),
      section("actions.title", [
        toggle("actions", "allowExecute"),
        toggle("actions", "allowDownload"),
        toggle("credentials", "allowRead"),
        toggle("actions", "allowCredentialWrite", "actions.allowCredentialWrite", "actions.allowCredentialWrite.hint"),
      ]),
      h("details", { key: "advanced", style: styles.group }, [
        h("summary", { key: "title", style: styles.groupTitle }, t("settings.advanced")),
        toggle("history", "enabled"),
        selector("vision.strategy", settings.vision.strategy, [
          { value: "auto", label: t("vision.auto") },
          { value: "nonVisual", label: t("vision.nonVisual") },
        ], strategy => patch({ vision: { strategy } })),
        systemBrowser ? toggle("cookies", "persist", "browser.profile") : null,
        systemBrowser ? selector("browser.headless", settings.browser.headless ?? "auto",
          options("browser.headless.", ["auto", "windowed", "headless"]),
          headless => patch({ browser: { headless } }), "browser.headless.hint") : null,
        settings.delivery ? section("delivery.title", [
          h(DeliverySettings, {
            key: JSON.stringify(settings.delivery),
            delivery: settings.delivery,
            busy,
            onSave: delivery => patch({ delivery }),
          }),
        ]) : null,
        meta.path !== "" ? h("p", { key: "path", style: styles.pathLine }, t("settings.details") + " · " + meta.path) : null,
      ]),
      h("div", { key: "status", style: styles.status, role: "status" }, [
        busy || saved ? h("span", { key: "s" }, t(busy ? "settings.saving" : "saved")) : null,
        error !== "" ? h("span", { key: "e", style: styles.error }, ` ${t("failed")} ${error} `) : null,
        error !== "" ? h("button", { key: "r", type: "button", style: styles.button, onClick: load }, t("retry")) : null,
      ]),
    ])
  }

  // ===========================================================================
  // Conversation panel service: the one place a sidebar panel is opened.
  //
  // The shell mounts one right sidebar per conversation, and DSH's own sidebar
  // browser keeps that conversation's tabs and its webview guest inside it.
  // `ctx.sidebarRight.openTab` acts on the conversation the shell is SHOWING
  // (`mounted`), so every path that simulated a shortcut or clicked a card put
  // the page into whichever conversation the human happened to be reading —
  // that is the cross-conversation bleed, and it is a property of the path, not
  // an accident of it.
  //
  // `openTabIn(sessionId, …)` is the same navigation aimed at a NAMED
  // conversation, and it works for one that is not on screen. This service is
  // the only caller; the plugin's host half reaches it by evaluating
  // `globalThis.__dshBuiltinBrowser.openPanel(...)` inside the shell window, so
  // no input event, no key dispatch and no element click is involved.
  //
  // Guest identity is read from the panel's own `<webview>` and only inside the
  // subtree found for THAT conversation — never from the first match in the
  // document, which belongs to somebody else's panel.
  // ===========================================================================

  /** The conversation a sidebar element belongs to, read off its React fiber. */
  function sessionIdOfElement(element) {
    const key = Object.keys(element).find(
      name => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"),
    )
    if (key === undefined) return null
    let fiber = element[key]
    let depth = 0
    while (fiber !== null && fiber !== undefined && depth < 60) {
      const props = fiber.memoizedProps
      if (props !== null && typeof props === "object" && typeof props.sessionId === "string") return props.sessionId
      fiber = fiber.return
      depth += 1
    }
    return null
  }

  /**
   * This conversation's own sidebar strip, or null when the shell has not mounted it.
   *
   * Its presence is the precondition `openTabIn` needs: it is minted together with the
   * conversation's surface store, and a call for a conversation whose store was never
   * minted silently does nothing. Detecting it here turns that silence into a reason
   * the caller can report, instead of a page that never appears.
   */
  function tabStripFor(sessionId) {
    for (const strip of Array.from(document.querySelectorAll("[class*=_tabStrip]"))) {
      if (sessionIdOfElement(strip) === sessionId) return strip
    }
    return null
  }

  /** rc.5 marks both SessionView and its nested SidebarPanel, including floating panes. */
  function panelRootsFor(sessionId) {
    const roots = Array.from(document.querySelectorAll("[data-sidebar-right-session]"))
    // Only shells without DOM ownership markers may use the legacy React adapter.
    return roots.length === 0 ? undefined : roots.filter(root => root.getAttribute("data-sidebar-right-session") === sessionId)
  }

  /**
   * Every live `<webview>` guest inside this conversation's panel subtree.
   *
   * The walk up stops the moment an ancestor carries ANOTHER conversation's sidebar, and that stop
   * condition is the whole point of this function. The shell mounts every conversation's panel in
   * the same document — hidden ones included — so one step too far lands on a subtree that holds
   * all of them, and the first guest found there belongs to whichever conversation the shell
   * happens to render first. Measured: a GitHub login page opened in a different conversation was
   * reported as this one's guest, which is the cross-conversation bleed this service exists to
   * prevent. A sibling strip is the exact, class-name-independent signature of having stepped
   * outside; a conversation may legitimately own more than one strip of its own, so the test is
   * "is there one that is NOT mine", never a count.
   */
  function guestsInPanel(sessionId) {
    const roots = panelRootsFor(sessionId)
    if (roots !== undefined) {
      // The nested markers can enumerate a guest twice. Its closest owner must still
      // name this session, so an embedded foreign session never enters the result.
      return Array.from(new Set(roots.flatMap(root => Array.from(root.querySelectorAll("webview"))))).filter(view => {
        try {
          return roots.includes(view.closest("[data-sidebar-right-session]"))
            && typeof view.getWebContentsId === "function" && view.getWebContentsId() > 0
        } catch { return false }
      })
    }
    const strip = tabStripFor(sessionId)
    if (strip === null) return []
    // Start at the strip itself: it is by construction this conversation's own, so the foreign test
    // below cannot trip on it, and a shell that renders the guest as a sibling of the strip is
    // still reached.
    let node = strip
    while (node !== null && node !== undefined && node !== document.body) {
      const foreign = Array.from(node.querySelectorAll("[class*=_tabStrip]"))
        .some(el => sessionIdOfElement(el) !== sessionId)
      if (foreign) break
      const found = Array.from(node.querySelectorAll("webview")).filter(view => {
        try { return typeof view.getWebContentsId === "function" && view.getWebContentsId() > 0 }
        catch (error) { return false }
      })
      if (found.length > 0) return found
      node = node.parentElement
    }
    return []
  }

  /** Read this conversation's current guest, preferring the one actually drawn. */
  function guestStateFor(sessionId, tabId) {
    const roots = panelRootsFor(sessionId)
    if (roots === undefined ? tabStripFor(sessionId) === null : roots.length === 0) return { panel: false, guestId: null, url: "" }
    const guests = guestsInPanel(sessionId).filter(view => tabId === undefined
      || tabIdOfElement(view, new Set([tabId]), roots) === tabId)
    if (guests.length === 0) return { panel: true, guestId: null, url: "" }
    // A sidebar keeps every tab mounted (`keepMounted`), so a background tab's guest is
    // in the tree too. Prefer the one with a drawn box; fall back to the newest.
    const drawn = guests.find(view => {
      const rect = view.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
    const chosen = drawn === undefined ? guests[guests.length - 1] : drawn
    let url = ""
    try { url = String(chosen.getURL ? chosen.getURL() : "") } catch (error) { url = "" }
    try { return { panel: true, guestId: chosen.getWebContentsId(), url } }
    catch (error) { return { panel: true, guestId: null, url: "" } }
  }

  /** Resolve a shell tab by its stable id, never by the page's displayed title. */
  function tabIdOfElement(element, allowed, roots) {
    if (roots !== undefined) {
      const owner = element.closest("[data-sidebar-right-session]")
      if (!roots.includes(owner)) return null
      let id = null
      for (let node = element; node && node !== owner; node = node.parentElement) {
        for (const value of [node.getAttribute("data-sidebar-right-tab"), node.getAttribute("data-dockkit-tab")]) {
          if (value === null) continue
          if (id !== null && id !== value) return null
          id = value
        }
      }
      return allowed.has(id) ? id : null
    }
    const key = Object.keys(element).find(name => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"))
    let fiber = key === undefined ? null : element[key]
    for (let depth = 0; fiber && depth < 60; depth += 1, fiber = fiber.return) {
      const props = fiber.memoizedProps
      if (!props || typeof props !== "object") continue
      for (const id of [props.tabId, props.tab && props.tab.id]) {
        if (typeof id === "string" && allowed.has(id)) return id
      }
    }
    return null
  }

  /**
   * Publish the service every host-side panel request goes through.
   *
   * The binding is separate from the publication so the API exists from the first
   * apply — a request arriving before `sidebarRight` is ready gets a named reason
   * rather than a missing global, which is indistinguishable from a bridge that
   * never loaded.
   */
  function installPanelService(ctx) {
    let sidebarRight = null
    const pendingTabs = new Map()
    /** The shell's own navigation service: `openSession` is how it is asked to DISPLAY a conversation. */
    let uiWorkspace = null
    // `inject` is how a client plugin waits for a service to appear. A host that does not offer it
    // — an older composition, or a harness that mounted this bundle for its settings panel alone —
    // must still get the panel, so the wait is skipped and the published API names the missing
    // service when it is called. Failing the whole apply here would take the settings panel down
    // with it, which is exactly the shape of regression this file has been bitten by before.
    if (typeof ctx.inject === "function") {
      ctx.inject(["sidebarRight"], (scope) => {
        if (sidebarRight !== scope.sidebarRight) pendingTabs.clear()
        sidebarRight = scope.sidebarRight
        scope.effect(() => () => {
          if (sidebarRight === scope.sidebarRight) {
            sidebarRight = null
            pendingTabs.clear()
          }
        }, "dsh-builtin-browser: conversation panel binding")
      })
      // A separate inject, deliberately: waiting for both services in one call would take the
      // panel down on a host that has the sidebar but not the workspace service (an older
      // composition), and the panel is the part that must keep working.
      ctx.inject(["uiWorkspace"], (scope) => {
        uiWorkspace = scope.uiWorkspace
        scope.effect(() => () => {
          if (uiWorkspace === scope.uiWorkspace) uiWorkspace = null
        }, "dsh-builtin-browser: workspace binding")
      })
    }
    /**
     * Ask the shell to DISPLAY the conversation a page was requested for.
     *
     * The shell renders the sidebar of the conversation it shows and no other, so a request from a
     * background conversation can place a tab but never grow a webview. The old answer was "show
     * that conversation and the page appears" — true, and a dependency on the human's timing.
     * `openSession` is the shell's own navigation for exactly this: the same call its own session
     * list makes, aimed at a session id, with no input event and no DOM touched.
     *
     * Only called when this conversation's panel DOM is absent, so it never fires for the
     * conversation the human is already reading, and never as a side effect of a read.
     *
     * @param sessionId - the conversation the page belongs to.
     * @param state - the panel read taken just before; `panel: true` means nothing to claim.
     * @returns whether the shell was asked to switch.
     */
    /**
     * The conversation the shell is displaying, as the shell itself reports it.
     *
     * `undefined`/`null` means "the shell would not say" — an older shell, or one whose surface was
     * never minted. Both callers treat that as "not this conversation", which is the fail-safe
     * direction: no navigation, no expand, nothing that could move a view it cannot identify.
     * @returns the on-screen session id, or null.
     */
    function onScreenSession() {
      try {
        const screen = sidebarRight === null || typeof sidebarRight.screen !== "function" ? undefined : sidebarRight.screen()
        return screen !== undefined && screen !== null && typeof screen.sessionId === "string" ? screen.sessionId : null
      } catch (error) {
        return null
      }
    }

    function claimConversation(sessionId, state) {
      if (state.panel === true) return false
      if (uiWorkspace === null || typeof uiWorkspace.openSession !== "function") return false
      // Already displayed? Then the shell needs no navigation: the panel simply has not been opened
      // yet, and `revealPlacedPanel` opens it. Re-opening the conversation a human is reading would
      // be a no-op at best and a view reset at worst.
      if (onScreenSession() === sessionId) return false
      try {
        uiWorkspace.openSession(sessionId)
        return true
      } catch (error) {
        return false
      }
    }

    /**
     * Make a page that has been PLACED actually appear: expand the column, focus its tab.
     *
     * A placed tab is not a shown page. The shell renders the body of the ACTIVE tab, and only
     * while the column is expanded. A collapsed column keeps the strip — so the read side still
     * reports `panel: true` — while no `<webview>` is ever created, and every guest read comes
     * back empty. That is the state that used to sit here for 20 s and then get reported as an
     * unusable panel: measured on the running shell as `panel: true`, `guestId: null` in the
     * renderer and `sidebar: []` from the bridge, with no carrier-side step that could have
     * fixed it, because nobody had ever asked the column to open.
     *
     * Both calls are layout commands on a conversation's own surface store — no input event, no
     * key dispatch, no element click. Two guards keep them from touching a conversation the
     * human is not reading:
     *   - only when `screen()` names THIS conversation. `screen()` is the shell's own answer to
     *     "which conversation is displayed", and `toggleExpanded` acts on exactly that one, so
     *     without this check an expand could fold the column a human is reading. A conversation
     *     that is displayed but was never opened (a fresh window has no right sidebar at all until
     *     something asks for it) passes this check — that case is why the DOM alone is not enough;
     *   - `focus` is scoped by the shell itself (a tab outside the mounted surface is ignored),
     *     so passing it a tab id from another conversation's list cannot move that view.
     *
     * @param sessionId - the conversation whose page was just placed.
     * @param state - what the panel read before the placement; a live guest means nothing to do.
     * @returns what was asked for, so a caller can tell "expanded" from "already visible", and
     *   `displayed` so it can tell "the shell is showing this conversation" from "it is not".
     */
    function revealPlacedPanel(sessionId, state, tabId) {
      if (state.guestId !== null || sidebarRight === null) return {}
      const done = {}
      // Which conversation is the shell DISPLAYING? `screen()` answers it, and it is the question
      // that decides whether an expand call is safe: `toggleExpanded()` acts on the on-screen
      // session, so calling it for any other conversation would fold the column a human is reading.
      //
      // It also separates two states that the DOM alone cannot:
      //   - this conversation is displayed but its column has never been opened (a fresh window
      //     starts with no right sidebar at all) — expand, and the panel mounts;
      //   - another conversation is displayed — nothing here may touch the column; the claim step
      //     is what moves the shell, and the caller retries one render later.
      let onScreen = null
      try {
        onScreen = onScreenSession()
      } catch (error) {
        onScreen = null
      }
      if (onScreen !== sessionId) {
        done.displayed = false
        return done
      }
      done.displayed = true
      try {
        if (typeof sidebarRight.isExpanded === "function" && typeof sidebarRight.toggleExpanded === "function") {
          // `isExpanded()` is false both for "folded" and for "never opened". Both want the same
          // thing here, and `screen()` above has already established that the column being toggled
          // is THIS conversation's, so expanding cannot touch anybody else's.
          if (sidebarRight.isExpanded() === false) {
            sidebarRight.toggleExpanded()
            done.expanded = true
          }
        }
      } catch (error) {
        done.expandError = String(error?.message ?? error)
      }
      try {
        const tabs = typeof sidebarRight.tabsIn === "function" ? sidebarRight.tabsIn(sessionId) : []
        const page = Array.isArray(tabs) ? tabs.find(entry => entry !== null && typeof entry === "object" && entry.kind === "browser" && entry.id === tabId) : undefined
        if (page !== undefined && typeof sidebarRight.focus === "function") {
          sidebarRight.focus(page.id)
          done.focused = String(page.id)
        }
      } catch (error) {
        done.focusError = String(error?.message ?? error)
      }
      return done
    }

    const api = {
      /** @returns what happened: an existing guest, a newly opened tab, or a named refusal. */
      openPanel(sessionId, url) {
        const wanted = typeof sessionId === "string" ? sessionId : ""
        if (!/^session-/.test(wanted)) {
          return { ok: false, reason: "not a conversation id: " + JSON.stringify(sessionId), panel: false, guestId: null }
        }
        if (sidebarRight === null || typeof sidebarRight.openTabIn !== "function") {
          return { ok: false, reason: "the shell's sidebar service is not available", panel: false, guestId: null }
        }
        const address = url ? String(url) : ""
        const pending = pendingTabs.get(wanted)
        const state = guestStateFor(wanted, pending?.url === address && pending.scoped ? pending.id : undefined)
        if (state.guestId !== null) {
          return { ok: true, created: false, panel: true, guestId: state.guestId, url: state.url }
        }
        // No panel DOM for this conversation means the shell is not DISPLAYING it, and no tab placed
        // here can ever grow a webview: the shell renders one sidebar, for the conversation it shows.
        // Asking the human to click over was the old answer, and it made a working carrier depend on
        // their timing. Ask the shell instead — `openSession` is its own navigation, one call on its
        // own workspace service, no input events — and report `switched` so the caller can retry one
        // render later instead of reporting a dead carrier.
        const switched = claimConversation(wanted, state)
        // A mounted panel is NOT required to place a tab.
        //
        // `openTabIn` acts on the conversation's own surface store, and the sidebar-right service
        // keeps one for every conversation the shell has shown — "reaches any session's store by
        // id … on screen or not". What a DISPLAYED conversation adds is the DOM to read the guest
        // back out of, which is a separate question. So the tab is placed either way, and `tabsIn`
        // (a public method) is what says whether it actually landed: `openTabIn` SILENTLY ignores a
        // conversation whose store was never minted, and a silent no-op must never be reported as
        // success.
        let beforeTabs = []
        try { beforeTabs = Array.from(sidebarRight.tabsIn(wanted)) } catch {}
        const before = beforeTabs.length
        const beforeIds = new Set(beforeTabs.map(tab => tab.id))
        const remembered = pending?.url === address
          ? beforeTabs.find(tab => tab.kind === "browser" && tab.id === pending.id)
          : undefined
        if (remembered === undefined) {
          try {
            sidebarRight.openTabIn(wanted, "browser", address ? { params: { url: address } } : {})
          } catch (error) {
            return { ok: false, reason: String((error && error.message) || error), panel: state.panel, guestId: null }
          }
        }
        let placedTabs = beforeTabs
        try { placedTabs = Array.from(sidebarRight.tabsIn(wanted)) } catch {}
        const placed = placedTabs.length
        const browserTabs = placedTabs.filter(tab => tab !== null && typeof tab === "object" && tab.kind === "browser")
        const added = browserTabs.filter(tab => !beforeIds.has(tab.id))
        const matching = browserTabs.filter(tab => address !== "" && (tab.params?.url === address || tab.url === address))
        // Multiple browser tabs use separate ids. Correlate this placement before revealing it.
        // Older shells deduplicate the browser kind, so their sole browser is unambiguous.
        const page = remembered
          ?? (added.length === 1 ? added[0] : undefined)
          ?? (matching.length === 1 ? matching[0] : undefined)
          ?? (browserTabs.length === 1 ? browserTabs[0] : undefined)
        const scoped = browserTabs.length > 1 || panelRootsFor(wanted) !== undefined
        if (page !== undefined) pendingTabs.set(wanted, { id: page.id, url: address, scoped })
        if (page === undefined && browserTabs.length > 1) {
          return { ok: false, reason: "the shell did not identify which browser tab was placed", panel: state.panel, guestId: null }
        }
        // `openTabIn` DEDUPLICATES, so "the count grew" is the wrong test for "is this
        // conversation's surface mounted".
        //
        // Placing a page kind the conversation already holds leaves the count unchanged — the shell
        // reveals the tab it has. Testing for growth therefore reported a conversation that already
        // held the page as UNMOUNTED, and refused to drive a page that was right there: that is the
        // "it will not reopen what it already opened" behaviour, and it bites hardest on the second
        // open of an address, which is exactly when a human expects a fast answer.
        //
        // A count that started at zero and stayed there is the real signature of a surface the
        // shell has never minted, because that is the only case where `openTabIn` is a silent no-op.
        if (placed <= before && before === 0) {
          // Name what was FOUND, not just what was missing: "no panel" has two very different
          // causes — the shell has mounted no sidebar for this conversation (nothing this side can
          // do), or it writes its session id somewhere this lookup does not read (fixable) — and a
          // refusal that says only "not mounted" cannot tell them apart.
          const strips = Array.from(document.querySelectorAll("[class*=_tabStrip]"))
          return {
            ok: false,
            reason: "this conversation's sidebar is not mounted, so a panel cannot be opened in it",
            panel: state.panel,
            guestId: null,
            ...switched ? { switched: true } : {},
            found: {
              wanted: wanted,
              strips: strips.length,
              owners: strips.slice(0, 8).map(strip => sessionIdOfElement(strip)),
              reactKeys: strips.length === 0 ? [] : Object.keys(strips[0]).filter(key => key.startsWith("__react")).slice(0, 4),
            },
          }
        }
        // Placing is not showing: ask the shell to expand the column and focus that tab, so the
        // body (and with it the `<webview>`) actually gets created. Without this the caller polls
        // a panel that can never answer, which is exactly what "produced no page" used to mean.
        const revealed = revealPlacedPanel(wanted, state, page?.id)
        return {
          ok: true,
          created: placed > before,
          panel: state.panel,
          guestId: null,
          tabs: placed,
          ...page === undefined || !scoped ? {} : { tabId: String(page.id) },
          ...switched ? { switched: true } : {},
          ...revealed,
        }
      },
      /** Read-only: this conversation's current guest, if it has one. */
      panelGuest(sessionId, tabId) {
        return guestStateFor(
          typeof sessionId === "string" ? sessionId : "",
          typeof tabId === "string" && tabId !== "" ? tabId : undefined,
        )
      },
      /** All guest ids verified inside this conversation, including shell-created popup tabs. */
      panelGuests(sessionId) {
        if (typeof sessionId !== "string" || !/^session-/.test(sessionId)) return []
        return guestsInPanel(sessionId).map(view => view.getWebContentsId())
      },
      /** Close exactly the tab hosting this guest. An unknown shell shape must fail closed. */
      closePanelGuest(sessionId, guestId) {
        const refuse = reason => ({ ok: false, reason, closed: 0 })
        if (typeof sessionId !== "string" || !/^session-/.test(sessionId)) return refuse("a conversation id is required")
        const view = guestsInPanel(sessionId).find(candidate => candidate.getWebContentsId() === guestId)
        if (view === undefined) return refuse("the guest does not belong to this conversation panel")
        const roots = panelRootsFor(sessionId)
        const containers = roots === undefined ? [tabStripFor(sessionId)].filter(Boolean) : roots
        if (containers.length === 0 || sidebarRight === null || typeof sidebarRight.tabsIn !== "function") {
          return refuse("the shell cannot identify its tabs; refresh or upgrade the browser plugin client")
        }
        let tabs
        try { tabs = sidebarRight.tabsIn(sessionId) } catch { return refuse("the conversation tabs are unavailable") }
        const allowed = new Set(tabs.map(tab => tab.id))
        const id = tabIdOfElement(view, allowed, roots)
        if (id === null) return refuse("the shell does not expose this guest's tab identity; refresh or upgrade the desktop")
        // rc.5's scoped controller runs registered cleanup and removes the shell tab as one action.
        if (typeof sidebarRight.closeIn === "function") {
          try {
            sidebarRight.closeIn(sessionId, id)
            if (sidebarRight.tabsIn(sessionId).some(tab => tab.id === id)) return refuse("the shell did not remove the requested conversation tab")
            return { ok: true, closed: 1 }
          } catch (error) { return refuse("the shell could not close the conversation tab: " + String(error?.message ?? error)) }
        }
        const headers = Array.from(new Set(containers.flatMap(container => Array.from(container.querySelectorAll("[role=tab]")))))
          .filter(tab => tabIdOfElement(tab, allowed, roots) === id)
        if (headers.length !== 1) return refuse("the shell does not expose one matching tab control; refresh or upgrade the desktop")
        const buttons = Array.from(headers[0].querySelectorAll("button"))
          .filter(button => /关闭|close/i.test((button.getAttribute("aria-label") || "") + " " + (button.getAttribute("title") || "")))
        if (buttons.length !== 1) return refuse("the shell does not expose one matching close control; refresh or upgrade the desktop")
        buttons[0].click()
        return { ok: true, closed: 1 }
      },
    }
    ctx.effect(() => {
      globalThis.__dshBuiltinBrowser = api
      return () => {
        if (globalThis.__dshBuiltinBrowser === api) delete globalThis.__dshBuiltinBrowser
      }
    }, "dsh-builtin-browser: conversation panel service")
  }

  /**
   * The live-view panel: one frame at a time, for an operator who is not sitting at this machine.
   *
   * A plain floating layer rather than a slot registration, deliberately. The host's layout has no
   * stable slot for "an extra surface over the conversation", and inventing one would tie this
   * panel to a layout that changes; a fixed layer works in every layout including a phone. It is
   * also entirely inert until the host turns `remoteView.enabled` on, which the sessions probe
   * reports.
   *
   * Pulls one frame per request and waits for it to paint before asking for the next, so a slow
   * link shows fewer frames instead of queueing them. Nothing here retries in a tight loop: a
   * refusal or a 503 moves the panel to a paused state, and it resumes on the next user action.
   * @param ctx - the plugin context, for the disposal hook.
   */
  function installWatchPanel(ctx) {
    if (typeof document === "undefined") return
    const SESSIONS = "/dsh-builtin-browser/browser-view/sessions"
    const FRAME = "/dsh-builtin-browser/browser-view/frame"
    const MIN_INTERVAL_MS = 500

    // Built element by element and referenced directly, never through innerHTML + querySelector.
    // Two reasons: the host's test sandbox provides a minimal `createElement`, and re-parsing markup
    // to find elements this code just made is work without a purpose.
    const make = (tag, className, text) => {
      const node = document.createElement(tag)
      if (className !== undefined) node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }

    const layer = make("div", "dsh-bw-watch")
    layer.setAttribute("data-dsh-bw-watch", "")

    const openButton = make("button", "dsh-bw-watch-open")
    openButton.setAttribute("type", "button")
    const dot = make("span", "dsh-bw-watch-dot")
    const openLabel = make("span", "dsh-bw-watch-label")
    openButton.appendChild(dot)
    openButton.appendChild(openLabel)

    const panel = make("section", "dsh-bw-watch-panel")
    panel.hidden = true

    const head = make("header", "dsh-bw-watch-head")
    const title = make("span", "dsh-bw-watch-title")
    const state = make("span", "dsh-bw-watch-state")
    const closeButton = make("button", "dsh-bw-watch-close", "×")
    closeButton.setAttribute("type", "button")
    head.appendChild(title)
    head.appendChild(state)
    head.appendChild(closeButton)

    const stage = make("div", "dsh-bw-watch-stage")
    const img = make("img", "dsh-bw-watch-img")
    img.hidden = true
    const note = make("p", "dsh-bw-watch-note")
    stage.appendChild(img)
    stage.appendChild(note)

    const foot = make("footer", "dsh-bw-watch-foot")
    const readonlyLabel = make("span", "dsh-bw-watch-readonly")
    const stopButton = make("button", "dsh-bw-watch-stop")
    stopButton.setAttribute("type", "button")
    foot.appendChild(readonlyLabel)
    foot.appendChild(stopButton)

    panel.appendChild(head)
    panel.appendChild(stage)
    panel.appendChild(foot)
    layer.appendChild(openButton)
    layer.appendChild(panel)
    // Deliberately NOT appended here. The entry is mounted only when the host reports that watching
    // is on — reported as issue #40: with the feature off, the button still sat on every page and
    // the bridge-status request fired at startup, so a setting nobody turned on produced a permanent
    // control and a permanent diagnostic call.

    /** Localized text, falling back to the key so a missing entry is visible rather than blank. */
    // Localized text.
    //
    // The try/catch that used to sit here was dead code, as Mzy123l pointed out on #40: the locale
    // service does not throw on a missing entry — it returns the key. So a miss shows the key, which
    // is diagnostic, and an empty answer is the only case worth substituting.
    const say = key => {
      const text = translate(key)
      return typeof text === "string" && text !== "" ? text : key
    }

    /**
     * Apply the current locale to every static label.
     *
     * Called at mount, after a locale change, and again once the dictionaries are bound. The panel
     * used to set these exactly once, inside `apply()`, *before* `locale.register` had run — so the
     * shipped build showed `watch.title` as its title and the key was never replaced (issue #40).
     */
    const relabel = () => {
      openLabel.textContent = say("watch.open")
      title.textContent = say("watch.title")
      readonlyLabel.textContent = say("watch.readOnly")
      stopButton.textContent = say("watch.stop")
      openButton.title = say("watch.open")
    }
    relabel()
    // A runtime language switch must reach labels that are already on screen. `subscribe` fires on
    // every locale snapshot change — a switch, and also a late dictionary registration — which is
    // exactly the set of moments these four strings can go stale.
    refreshWatchLabels = () => { relabel() }

    let mounted = false
    /** Put the entry on the page. Idempotent, so a second enable cannot stack copies. */
    const mount = () => {
      if (mounted) return
      mounted = true
      document.body.appendChild(layer)
      relabel()
    }
    /** Take it off again — the host turned the feature off after it had been on. */
    const unmount = () => {
      if (!mounted) return
      mounted = false
      layer.remove()
    }

    /** One running view: a session, its frames, and whether it should keep pulling. */
    const view = { session: undefined, timer: undefined, running: false, lastAt: 0, objectUrl: undefined }

    const setState = text => { state.textContent = text }
    const showNote = text => {
      note.textContent = text
      note.hidden = false
      img.hidden = true
    }
    /** Release the previous frame. A viewer that keeps every frame is a memory leak in a phone browser. */
    const dropFrame = () => {
      if (view.objectUrl !== undefined) {
        URL.revokeObjectURL(view.objectUrl)
        view.objectUrl = undefined
      }
    }
    const stop = () => {
      view.running = false
      if (view.timer !== undefined) { clearTimeout(view.timer); view.timer = undefined }
      dropFrame()
      img.removeAttribute("src")
      img.hidden = true
      setState(say("watch.stopped"))
      showNote(say("watch.stopped"))
      panel.hidden = true
    }

    /** Ask which sessions exist; returns whether watching is enabled at all. */
    const probe = async () => {
      try {
        const response = await fetch(SESSIONS, { headers: { accept: "application/json" } })
        if (!response.ok) return { enabled: false, sessions: [] }
        const data = await response.json()
        return { enabled: data?.enabled === true, sessions: Array.isArray(data?.sessions) ? data.sessions : [] }
      } catch {
        return { enabled: false, sessions: [] }
      }
    }

    /**
     * Pull frames until stopped. One request in flight at a time, and the next one is scheduled only
     * after the current image has painted — that is what makes a slow link degrade into fewer
     * frames rather than a growing queue.
     */
    const pump = async () => {
      if (!view.running) return
      if (document.visibilityState === "hidden") {
        // The design's rule: a hidden panel stops pulling immediately. Resuming is the user's
        // action, not a timer's.
        setState(say("watch.paused"))
        showNote(say("watch.paused"))
        view.timer = setTimeout(pump, MIN_INTERVAL_MS * 4)
        return
      }
      const waited = Date.now() - view.lastAt
      if (waited < MIN_INTERVAL_MS) {
        view.timer = setTimeout(pump, MIN_INTERVAL_MS - waited)
        return
      }
      view.lastAt = Date.now()
      let nextDelay = MIN_INTERVAL_MS
      try {
        const url = `${FRAME}?session=${encodeURIComponent(String(view.session))}`
        const response = await fetch(url, { headers: { accept: "image/jpeg" } })
        if (!view.running) return
        if (!response.ok) {
          const body = await response.json().catch(() => undefined)
          setState(say("watch.paused"))
          showNote(body?.error === "remote-view-disabled"
            ? say("watch.disabled")
            : body?.error === "no-such-session"
              ? say("watch.noPage")
              : say("watch.paused"))
          // Slower polling while paused: a paused view must not turn into a hot loop.
          nextDelay = MIN_INTERVAL_MS * 4
        } else {
          const blob = await response.blob()
          if (!view.running) return
          const painted = new Promise(resolve => {
            img.onload = () => resolve()
            img.onerror = () => resolve()
          })
          dropFrame()
          view.objectUrl = URL.createObjectURL(blob)
          img.src = view.objectUrl
          img.hidden = false
          note.hidden = true
          await painted
          if (!view.running) return
          setState(say("watch.live"))
        }
      } catch {
        if (!view.running) return
        setState(say("watch.disconnected"))
        showNote(say("watch.disconnected"))
        nextDelay = MIN_INTERVAL_MS * 4
      }
      if (view.running) view.timer = setTimeout(pump, nextDelay)
    }

    const start = async session => {
      view.session = session
      view.running = true
      view.lastAt = 0
      panel.hidden = false
      setState(say("watch.connecting"))
      showNote(say("watch.connecting"))
      await pump()
    }

    openButton.addEventListener("click", () => {
      void (async () => {
        const found = await probe()
        if (!found.enabled) { showNote(say("watch.disabled")); panel.hidden = false; return }
        if (found.sessions.length === 0) { showNote(say("watch.noPage")); panel.hidden = false; return }
        await start(found.sessions[0])
      })()
    })
    closeButton.addEventListener("click", stop)
    stopButton.addEventListener("click", stop)
    // A panel hidden by a closed button must not keep pulling frames.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && view.running) {
        if (view.timer !== undefined) { clearTimeout(view.timer); view.timer = undefined }
        view.timer = setTimeout(pump, MIN_INTERVAL_MS)
      }
    })

    ctx.effect(() => () => {
      stop()
      unmount()
      refreshWatchEntry = () => {}
      refreshWatchLabels = () => {}
    }, "dsh-builtin-browser: live view panel")

    /**
     * Report the desktop bridge's install state next to the entry button.
     *
     * A missing bridge used to be a log line and nothing else, so a user on `channel: sidebar` saw
     * "another window opened again" with no way to connect that to the actual cause (issue #36).
     * The reading comes from the install tree, so it is true even before anything has been watched.
     *
     * The repair command is shown, never run: a page that could decide to close the desktop shell
     * would be a worse problem than the one this line solves.
     */
    const showBridgeStatus = async () => {
      let status
      try {
        const response = await fetch("/dsh-builtin-browser/bridge-status", { headers: { accept: "application/json" } })
        if (!response.ok) return
        const data = await response.json()
        status = data?.bridge
      } catch {
        return
      }
      if (status === undefined) return
      // Only the two states a user can act on: an installed bridge needs no notice, and a host
      // without a desktop install has nothing to repair here.
      if (status.state === "installed" || status.present !== true) return
      const notice = make("div", "dsh-bw-watch-bridge")
      const line = make("div", "dsh-bw-watch-bridge-line",
        status.state === "stale" ? say("watch.bridgeStale") : say("watch.bridgeMissing"))
      notice.appendChild(line)
      if (typeof status.command === "string" && status.command !== "") {
        const code = make("code", "dsh-bw-watch-bridge-cmd", status.command)
        notice.appendChild(code)
      }
      panel.insertBefore(notice, panel.firstChild)
    }

    /**
     * Mount the entry only if the host says viewing is enabled, and only then ask about the bridge.
     *
     * Both halves are the point of the ordering: the probe answers "is this feature on", and the
     * bridge-status request is a diagnostic for a feature that is on. Issuing it for a feature that
     * is off is what the review called a default entry manufacturing a call (issue #40).
     *
     * A host that does not serve the sessions endpoint answers `enabled: false`, so the fallback is
     * "no entry" rather than "an entry that cannot work".
     */
    const mountIfEnabled = async () => {
      const found = await probe()
      if (!found.enabled) {
        // Turning the feature off must also stop what it started: a running stream outliving its own
        // switch is the sort of state that looks like a ghost later.
        stop()
        unmount()
        return
      }
      mount()
      await showBridgeStatus()
    }
    // The settings switch calls this after writing `remoteView.enabled` (issue #46): no page reload,
    // which is the difference between usable and useless on a phone.
    refreshWatchEntry = () => { void mountIfEnabled() }
    void mountIfEnabled()
  }

  function apply(ctx) {
    // Before anything renders: the rows need a hover state, and inline styles cannot express
    // one. Idempotent, so a re-apply does not stack copies.
    installStyles()
    installPanelService(ctx)
    // Dictionaries and the bound `t` come BEFORE anything that sets text from them. The watch panel
    // used to be installed first, so its static labels were written while `translate` still returned
    // the key and were never rewritten — the panel shipped with `watch.title` as its title
    // (issue #40).
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-builtin-browser: dictionaries")
    const t = ctx.locale.bind(NS)
    translate = t
    // A language switch has to reach text that is already on screen. `subscribe` fires on every
    // locale snapshot change (switch, and late dictionary registration); guarded, because a host
    // without it must still get the panel — the labels then simply keep their first language.
    if (typeof ctx.locale.subscribe === "function") {
      ctx.effect(() => {
        const off = ctx.locale.subscribe(() => {
          translate = ctx.locale.bind(NS)
          // Two audiences, one notification: the vanilla watch panel rewrites its own text, and the
          // React settings section re-renders (see `useLocaleVersion`). Bumping the counter here is
          // what makes `t()` inside a mounted component return the new language at all.
          localeVersion += 1
          for (const update of localeWatchers) update()
          refreshWatchLabels()
        })
        return () => { if (typeof off === "function") off() }
      }, "dsh-builtin-browser: locale changes")
    }
    installWatchPanel(ctx)
    // Test seam. The readiness section is composed by the settings component, so a harness that
    // renders that component can see the element but never run it — and running it is what proves a
    // user reads a state label rather than `readiness.electron.failed`. Exported on the module rather
    // than published on `globalThis` (where the product's own `__dshBuiltinBrowser` lives, for the
    // shell's benefit): nothing in the product reads this name, and a page-level global would be a
    // side effect of shipping a test.
    exports.__readinessSection = Readiness
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "dsh-builtin-browser",
      // Above the rows the host ships (its furthest sits at 40), so this panel
      // lands beneath them in the settings page.
      order: 60,
      label: () => t("nav"),
      locale: NS,
      inject: () => ({ t }),
    }, SettingsRoot))
  }

  exports.name = name
  exports.inject = inject
  exports.apply = apply
  return module.exports
}})
