/**
 * Browser settings panel (client half): the switches that decide how the shared
 * browser behaves — history retention, login-state persistence, presentation,
 * vision strategy and credential access.
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
    "credentials.hint": "关闭后 browser_auth 的导出与恢复都会被拒绝(BROWSER_AUTH_DISABLED)—— 不只是导出:恢复走的是同一个开关。桌面端请注意:Agent 驱动的是侧栏里那一个页面(人机同页),因此它与该页面共用同一个 partition —— 这也正是它能读到登录态的原因,属于有意接受的沙箱边界变化;关闭本项即拒绝读取。",
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
    "credentials.hint": "Off makes browser_auth refuse both export and restore (BROWSER_AUTH_DISABLED) — not just export: restore goes through the same switch. On the desktop, note that the agent drives the sidebar's own page (one page for both parties), so it shares that page's partition — which is exactly why it can reach the login state. That is a deliberate sandbox-boundary change; this switch is how you refuse it.",
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
    const [settings, setSettings] = useState(null)
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

    if (settings === null) {
      return h("div", { style: styles.wrap }, [
        h("p", { key: "l", style: styles.lead }, t("loading")),
        error !== "" ? h("p", { key: "e", style: styles.error }, `${t("failed")} ${error}`) : null,
      ])
    }

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
