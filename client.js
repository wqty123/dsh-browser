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
  const { useCallback, useEffect, useState } = react

  const name = "dsh-builtin-browser"
  const inject = ["slots", "locale"]
  const NS = "settings.dsh-builtin-browser"
  const ROUTE = "/dsh-builtin-browser/settings"
  let translate = (key) => key

  const zh = {
    nav: "浏览器",
    title: "浏览器(Browser Use)",
    lead: "这些开关控制共享浏览器如何工作;改动立即生效,不需要重启 DSH。",
    loading: "读取设置…",
    failed: "读取设置失败:",
    retry: "重试",
    saved: "已保存",
    path: "设置文件",
    "history.title": "浏览历史",
    "history.enabled": "保留浏览历史",
    "history.hint": "记录访问过的页面;关闭浏览器后仍可查询并重新打开,关闭此开关后不再记录新访问。",
    "cookies.title": "登录状态",
    "cookies.persist": "保留 cookies",
    "cookies.hint": "关闭后每次启动浏览器都是未登录状态。",
    "ui.title": "展示",
    "ui.autoExpandOnce": "侧栏自动展开(每轮一次)",
    "ui.autoExpandOnce.hint": "Agent 首次操作时自动展开;你手动收起后,本轮不再打扰。",
    "ui.closeWithSession": "会话结束时关闭浏览器",
    "ui.closeWithSession.hint": "关闭会释放浏览器进程;浏览历史与登录状态会保留。",
    "ui.virtualCursor": "显示可视化鼠标",
    "ui.virtualCursor.hint": "让 Agent 正在操作的位置可见(出现即代表它在接管该标签页)。",
    "vision.title": "视觉策略",
    "vision.strategy": "默认策略",
    "vision.auto": "Auto(坐标与语义都允许;适合能读图的模型)",
    "vision.nonVisual": "纯非视觉(拒绝坐标点击,只用 DOM / 无障碍树定位)",
    "vision.hint": "纯非视觉下,坐标点击会被明确拒绝并提示改用语义定位,避免靠猜坐标点错。两种策略下 DOM、无障碍树、文本提取与结构化抓取的能力完全一致 —— 不需要图像输入也能完整操作页面。",
    "credentials.title": "凭据",
    "credentials.allowRead": "允许 Agent 读取 cookies / 导出登录状态",
    "browser.title": "浏览器载体",
    "browser.channel": "使用哪个浏览器",
    "browser.bundled": "内置 Electron(随插件提供,无需安装)",
    "browser.chrome": "本机 Chrome",
    "browser.edge": "本机 Edge",
    "browser.auto": "自动(优先 Chrome,其次 Edge)",
    "browser.hint": "选本机浏览器时会以**独立 profile** 启动它:不会打开、占用或修改你日常的窗口、书签与登录状态,关闭也不会关掉你自己的浏览器;代价是它看不到你日常浏览器里已登录的站点,需要时请在那个窗口里登录一次(登录态会留在插件自己的 profile 里)。桌面端默认由官方侧栏承载页面,此选项优先于侧栏。",
    "credentials.hint": "关闭后 browser_auth 的导出会被拒绝,报 BROWSER_AUTH_DISABLED —— 导出读的是整台机器共享的 cookie 罐(按当前页所属站点收敛)。它只管**读**:写入登录状态(restore)归下面「Agent 能做什么」里的写入开关。桌面端请注意:Agent 驱动的是侧栏里那一个页面(人机同页),因此它与该页面共用同一个 partition —— 这也正是它能读到登录态的原因,属于有意接受的沙箱边界变化;关闭本项即拒绝读取。",
    "actions.title": "Agent 能做什么",
    "actions.lead": "与 browser_restrict 不同:那一层是模型自己设的软护栏,它随时可以解除;这里的三项由你在设置里决定,模型手里的工具改不了它们。",
    "actions.allowExecute": "允许在页面里执行脚本",
    "actions.allowExecute.hint": "browser_execute 能在当前页面里运行任意 JavaScript —— 它的能力上限就是这个页面能做的事。关闭后该工具一律被拒(BROWSER_EXECUTE_DISABLED),模型手里的工具没有一个能改这项设置。但也别把它当成锁:设置文档由本机 HTTP 端点读写,同源页面可以写它 —— 这不是凭据系统。",
    "actions.allowDownload": "允许下载文件到磁盘",
    "actions.allowDownload.hint": "browser_download 会把 URL 下载到 downloadDir 内(带登录态;仍需通过目录准入,不覆盖已有文件)。关闭后一律被拒(BROWSER_DOWNLOAD_DISABLED)。截图另存走的是同一套目录准入,不受此项影响。",
    "actions.allowCredentialWrite": "允许写入登录状态",
    "actions.allowCredentialWrite.hint": "browser_auth 的 restore 会向任意域写入 cookie。关闭后只能导出、不能导入(BROWSER_AUTH_WRITE_DISABLED);读取仍由上面「凭据」那一项控制。",
  }

  const en = {
    nav: "Browser",
    title: "Browser (Browser Use)",
    lead: "These switches decide how the shared browser behaves; changes apply immediately, no DSH restart.",
    loading: "Loading settings…",
    failed: "Could not load settings:",
    retry: "Retry",
    saved: "Saved",
    path: "Settings file",
    "history.title": "Browsing history",
    "history.enabled": "Keep browsing history",
    "history.hint": "Records visited pages so they can be found and reopened after the browser is closed; off means no new visits are recorded.",
    "cookies.title": "Login state",
    "cookies.persist": "Keep cookies",
    "cookies.hint": "Off makes every browser start a signed-out session.",
    "ui.title": "Presentation",
    "ui.autoExpandOnce": "Auto-expand the side panel (once per task)",
    "ui.autoExpandOnce.hint": "Expands when the agent first operates; after you collapse it, this task stays quiet.",
    "ui.closeWithSession": "Close the browser when the session ends",
    "ui.closeWithSession.hint": "Closing releases the browser process; history and login state survive.",
    "ui.virtualCursor": "Show the synthetic cursor",
    "ui.virtualCursor.hint": "Makes the agent's operating position visible (its presence means the agent has taken over that tab).",
    "vision.title": "Vision strategy",
    "vision.strategy": "Default strategy",
    "vision.auto": "Auto (coordinates and semantics both allowed; for models that read images)",
    "vision.nonVisual": "Non-visual only (coordinate clicks refused; locate via DOM / a11y tree)",
    "vision.hint": "Under non-visual, a coordinate click is refused outright and the error says to use a semantic target — so nothing is clicked on a guessed position. DOM lookup, the accessibility tree, text extraction and structured scraping behave identically in both strategies: the whole page stays operable without image input.",
    "credentials.title": "Credentials",
    "credentials.allowRead": "Allow the agent to read cookies / export login state",
    "browser.title": "Browser",
    "browser.channel": "Which browser to use",
    "browser.bundled": "Bundled Electron (ships with the plugin, nothing to install)",
    "browser.chrome": "Installed Chrome",
    "browser.edge": "Installed Edge",
    "browser.auto": "Automatic (Chrome first, then Edge)",
    "browser.hint": "Choosing an installed browser launches it with a **separate profile**: your everyday windows, bookmarks and logins are never opened, locked or modified, and closing the plugin never closes your browser. The trade-off is that it does not see sites you are already signed into there — sign in once in that window and the session stays in the plugin's own profile. On the desktop the shell's sidebar normally carries the page; this setting outranks it.",
    "credentials.hint": "Off makes browser_auth refuse the export, reporting BROWSER_AUTH_DISABLED — an export reads the machine-wide shared cookie jar (narrowed to the current page's site). It governs READING only: writing login state (restore) answers to the write switch under \"What the agent may do\" below. On the desktop, note that the agent drives the sidebar's own page (one page for both parties), so it shares that page's partition — which is exactly why it can reach the login state. That is a deliberate sandbox-boundary change; this switch is how you refuse it.",
    "actions.title": "What the agent may do",
    "actions.lead": "Unlike browser_restrict, which is the model's own soft guardrail and can be lifted by the model at any time, these three are yours: the model's own tools cannot change them.",
    "actions.allowExecute": "Run scripts in the page",
    "actions.allowExecute.hint": "browser_execute runs arbitrary JavaScript in the active tab — its reach is everything that page can do. Off refuses the tool outright (BROWSER_EXECUTE_DISABLED), and no tool the model holds can change this setting. Do not read that as a lock, though: the document is served over a local HTTP endpoint and a same-origin page can write it. This is not a credential system.",
    "actions.allowDownload": "Download files to disk",
    "actions.allowDownload.hint": "browser_download fetches a URL into downloadDir (with login state; still subject to the directory admission gate, never overwriting an existing file). Off refuses it outright (BROWSER_DOWNLOAD_DISABLED). Saving a screenshot goes through the same directory gate and is not covered by this switch.",
    "actions.allowCredentialWrite": "Write login state",
    "actions.allowCredentialWrite.hint": "browser_auth's restore writes cookies to arbitrary domains. Off allows export but not import (BROWSER_AUTH_WRITE_DISABLED); reading stays under the Credentials switch above.",
  }

  /** Read or patch the host-owned settings document. */
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
    return data
  }

  const styles = {
    wrap: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 2px", fontSize: "13px" },
    lead: { opacity: 0.75, lineHeight: 1.6, margin: 0 },
    group: { border: "1px solid rgba(128,128,128,.28)", borderRadius: "8px", padding: "10px 12px" },
    groupTitle: { margin: "0 0 8px", fontSize: "13px", fontWeight: 600 },
    row: { display: "flex", gap: "10px", alignItems: "flex-start", padding: "5px 0" },
    box: { marginTop: "2px" },
    label: { display: "flex", flexDirection: "column", gap: "2px", cursor: "pointer" },
    hint: { opacity: 0.68, lineHeight: 1.5 },
    select: { marginTop: "4px", padding: "4px 6px", borderRadius: "6px", background: "transparent", color: "inherit", border: "1px solid rgba(128,128,128,.4)" },
    status: { opacity: 0.7, minHeight: "18px" },
    error: { color: "#e5534b" },
    pathLine: { opacity: 0.6, wordBreak: "break-all", lineHeight: 1.5 },
    button: { padding: "3px 10px", borderRadius: "6px", border: "1px solid rgba(128,128,128,.4)", background: "transparent", color: "inherit", cursor: "pointer" },
  }

  /** One boolean switch bound to a settings path. */
  function Toggle(props) {
    const t = translate
    return h("div", { style: styles.row }, [
      h("input", {
        key: "i",
        type: "checkbox",
        style: styles.box,
        checked: props.checked,
        disabled: props.busy,
        onChange: event => props.onChange(event.target.checked),
      }),
      h("label", { key: "l", style: styles.label, onClick: () => props.onChange(!props.checked) }, [
        h("span", { key: "t" }, t(props.labelKey)),
        h("span", { key: "h", style: styles.hint }, t(props.hintKey)),
      ]),
    ])
  }

  /** The settings page section. */
  function SettingsRoot() {
    const t = translate
    const [rawSettings, setSettings] = useState(null)
    const [meta, setMeta] = useState({ path: "" })
    const [error, setError] = useState("")
    const [busy, setBusy] = useState(false)
    const [saved, setSaved] = useState(false)

    const load = useCallback(() => {
      setError("")
      callSettings().then(data => {
        setSettings(data.settings)
        setMeta({ path: data.path || "" })
      }).catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
    }, [])

    useEffect(() => { load() }, [load])

    const patch = useCallback(next => {
      setBusy(true)
      setError("")
      callSettings(next).then(data => {
        setSettings(data.settings)
        setSaved(true)
        setTimeout(() => setSaved(false), 1200)
      }).catch(failure => setError(String(failure && failure.message ? failure.message : failure)))
        .then(() => setBusy(false))
    }, [])

    if (rawSettings === null) {
      return h("div", { style: styles.wrap }, [
        h("p", { key: "l", style: styles.lead }, t("loading")),
        error !== "" ? h("p", { key: "e", style: styles.error }, `${t("failed")} ${error}`) : null,
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

    const section = (titleKey, children) => h("div", { key: titleKey, style: styles.group }, [
      h("p", { key: "t", style: styles.groupTitle }, t(titleKey)),
      ...children,
    ])

    return h("div", { style: styles.wrap }, [
      h("p", { key: "lead", style: styles.lead }, t("lead")),

      section("history.title", [
        h(Toggle, {
          key: "enabled",
          labelKey: "history.enabled",
          hintKey: "history.hint",
          checked: settings.history.enabled,
          busy,
          onChange: value => patch({ history: { enabled: value } }),
        }),
      ]),

      section("cookies.title", [
        h(Toggle, {
          key: "persist",
          labelKey: "cookies.persist",
          hintKey: "cookies.hint",
          checked: settings.cookies.persist,
          busy,
          onChange: value => patch({ cookies: { persist: value } }),
        }),
      ]),

      section("ui.title", [
        h(Toggle, {
          key: "autoExpandOnce",
          labelKey: "ui.autoExpandOnce",
          hintKey: "ui.autoExpandOnce.hint",
          checked: settings.ui.autoExpandOnce,
          busy,
          onChange: value => patch({ ui: { autoExpandOnce: value } }),
        }),
        h(Toggle, {
          key: "closeWithSession",
          labelKey: "ui.closeWithSession",
          hintKey: "ui.closeWithSession.hint",
          checked: settings.ui.closeWithSession,
          busy,
          onChange: value => patch({ ui: { closeWithSession: value } }),
        }),
        h(Toggle, {
          key: "virtualCursor",
          labelKey: "ui.virtualCursor",
          hintKey: "ui.virtualCursor.hint",
          checked: settings.ui.virtualCursor,
          busy,
          onChange: value => patch({ ui: { virtualCursor: value } }),
        }),
      ]),

      section("vision.title", [
        h("div", { key: "row", style: styles.row }, [
          h("label", { key: "l", style: styles.label }, [
            h("span", { key: "t" }, t("vision.strategy")),
            h("select", {
              key: "s",
              style: styles.select,
              value: settings.vision.strategy,
              disabled: busy,
              onChange: event => patch({ vision: { strategy: event.target.value } }),
            }, [
              h("option", { key: "auto", value: "auto" }, t("vision.auto")),
              h("option", { key: "nonVisual", value: "nonVisual" }, t("vision.nonVisual")),
            ]),
            h("span", { key: "h", style: styles.hint }, t("vision.hint")),
          ]),
        ]),
      ]),

      section("browser.title", [
        h("div", { key: "row", style: styles.row }, [
          h("label", { key: "l", style: styles.label }, [
            h("span", { key: "t" }, t("browser.channel")),
            h("select", {
              key: "s",
              style: styles.select,
              value: settings.browser.channel,
              disabled: busy,
              onChange: event => patch({ browser: { channel: event.target.value } }),
            }, [
              h("option", { key: "bundled", value: "bundled" }, t("browser.bundled")),
              h("option", { key: "auto", value: "auto" }, t("browser.auto")),
              h("option", { key: "chrome", value: "chrome" }, t("browser.chrome")),
              h("option", { key: "edge", value: "edge" }, t("browser.edge")),
            ]),
            h("span", { key: "h", style: styles.hint }, t("browser.hint")),
          ]),
        ]),
      ]),

      section("actions.title", [
        h("p", { key: "lead", style: styles.hint }, t("actions.lead")),
        h(Toggle, {
          key: "allowExecute",
          labelKey: "actions.allowExecute",
          hintKey: "actions.allowExecute.hint",
          checked: settings.actions.allowExecute,
          busy,
          onChange: value => patch({ actions: { allowExecute: value } }),
        }),
        h(Toggle, {
          key: "allowDownload",
          labelKey: "actions.allowDownload",
          hintKey: "actions.allowDownload.hint",
          checked: settings.actions.allowDownload,
          busy,
          onChange: value => patch({ actions: { allowDownload: value } }),
        }),
        h(Toggle, {
          key: "allowCredentialWrite",
          labelKey: "actions.allowCredentialWrite",
          hintKey: "actions.allowCredentialWrite.hint",
          checked: settings.actions.allowCredentialWrite,
          busy,
          onChange: value => patch({ actions: { allowCredentialWrite: value } }),
        }),
      ]),

      section("credentials.title", [
        h(Toggle, {
          key: "allowRead",
          labelKey: "credentials.allowRead",
          hintKey: "credentials.hint",
          checked: settings.credentials.allowRead,
          busy,
          onChange: value => patch({ credentials: { allowRead: value } }),
        }),
      ]),

      h("div", { key: "status", style: styles.status }, [
        saved ? h("span", { key: "s" }, t("saved")) : null,
        error !== "" ? h("span", { key: "e", style: styles.error }, ` ${t("failed")} ${error} `) : null,
        error !== "" ? h("button", { key: "r", style: styles.button, onClick: load }, t("retry")) : null,
      ]),

      meta.path !== "" ? h("div", { key: "path", style: styles.pathLine }, `${t("path")}: ${meta.path}`) : null,
    ])
  }

  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-builtin-browser: dictionaries")
    const t = ctx.locale.bind(NS)
    translate = t
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
