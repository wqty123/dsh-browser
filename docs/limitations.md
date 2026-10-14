# 已知限制

这些是本插件**有意接受**或**受宿主约束**的边界。它们不是待办事项：写在这里是因为"知道为什么"能省掉一次排查。

## 截图

- JPEG 在**自托管**与**本机 Chrome / Edge** 上可用;**桌面端侧栏**走外壳的 `webContents.debugger`,其 Electron 的 CDP JPEG 编码会挂起,因此该载体下请求 JPEG 会返回 PNG。
- 降采样(`maxWidth`/`maxHeight`)**三种载体都支持**(经 CDP `clip.scale`,或自托管走原生 `capturePage`)。
- 自托管截图优先走 Electron 原生 `capturePage`(CDP `captureScreenshot` 在多视图下会挂起);截图前自动把目标标签置顶。
- `fullPage` 在部分主机的**软件合成**下不稳定 —— 请求 `fullPage` 时**原生 `capturePage` 路径被整体跳过**(它没有捕获滚动区以外内容的能力),因此**三种载体都走 CDP 的 `captureBeyondViewport`**。也就是说 `fullPage` 的不稳定性与载体无关,任何载体都可能碰到;只有视口截图才优先走原生路径。

## 验证与登录

- 人机验证(CAPTCHA)无法自动解决:快照会标注检测到的挑战,此时应请用户在共享窗口中人工完成,而不是反复重试。
- `dsh_browser_auth` 的 cookie 往返**不保留** `hostOnly`/`sameSite` 字段(host-only cookie 恢复后变成 domain cookie)。
- `flush` **只导出当前页所属站点的 cookie**,不是整台机器的共享 cookie 罐 —— 范围按本会话所在页面的 URL 收敛;页面没有可用 URL 时**直接拒绝**,而不是扩大范围去读全部域(自托管侧栏载体报"无法确定 cookie 范围",CDP 载体报 `BROWSER_AUTH_SCOPE_UNKNOWN`)。
- `dsh_browser_restrict` 的白名单**也管着 `dsh_browser_auth`**,因为 `restore` 是向任意域写 cookie 的动作,不是观察。
- 自托管浏览器的 cookie 在磁盘上**以明文存储**(Electron 默认行为);需要加密落盘的部署应在宿主层接入系统钥匙串 / DPAPI。

## 权限与门控

- `dsh_browser_restrict` 是防误操作的**软护栏**,不是安全边界:模型可以自行解除白名单。要一个**模型拿工具改不掉**的限制,用设置页「Agent 能做什么」的三个动作开关(它们写在设置文档里,`dsh_browser_*` 工具没有一个会写它),或部署级的 `tool-browser` 配置 `allowedActions`(见 `cordis.patch.yml` 的注释)。
- **这条边界要说准**:设置走的是本机 HTTP 端点,写入要求带同源 `Origin`(裸 HTTP 客户端因此写不进去),但**同源页面仍然可以写** —— 这是"插件暴露了一个 HTTP 端点"的固有代价,它**不是凭据系统**,面板上的说明也是这么写的。
- 设置文档**存在但读不懂**(JSON 损坏、写到一半、权限读不到)时,四个**门控**开关(`credentials.allowRead` 与三个动作开关)一律按**关**处理,其余设置取默认值 ——"读不透操作者的意图"不等于"操作者什么都允许"。文件**不存在**(首次运行)仍按默认值。单个门控字段类型不对(`"false"` 字符串、`null`、数字)同样按**关**;门控所在的**小节**整个写成非对象(如 `actions: false`)也按**关**,而不是把里面的每个开关当成"缺席"、各取放行的默认值。

## 下载与保存路径

- `dsh_browser_download` 在页面上下文内 `fetch`(带登录态),受同源/CORS 约束;仅允许 HTTP(S) 目标。
- `savePath` 必须为**绝对路径**且位于 `downloadDir` 内(默认系统下载目录,自动识别 `Downloads`/`下载`/`下載` 与 `XDG_DOWNLOAD_DIR`,可用 `downloadDir` 覆盖),**不覆盖已存在文件**;`dsh_browser_screenshot` 的 `savePath` 走同一准入门。
- 单文件上限 **256MB**(流式限流,按 Content-Length 提前拒绝),文件由浏览器子进程直接落盘(临时文件 + 原子改名)。
- 准入还会解析路径的**真实归属**:`downloadDir` 里的符号链接无法把写入带出目录,悬空链接同样被拒(它读作"名字已被占用",而不是"路径空闲")。

## 载体行为

- **侧栏载体不上报"用户操作"事件**:人在那个页面里点击是外壳自己的事件,而 bridge 没有用于回报它的操作。因此依赖该事件的功能(如自定义的接管提示)在桌面端侧栏下不会触发;换到自托管载体则可以。
- **本机 Chrome / Edge 载体使用插件自己的 profile**:插件用它自己的用户数据目录启动浏览器(`$DSH_HOME/dsh-builtin-browser-host/<chrome|edge>-profile`),所以你日常浏览器里的书签、扩展与登录态**不会自动继承** —— 这是刻意的,避免插件操作与你的个人会话混在一起;登录态是否跨重启保留由 `cookies.persist` 决定。
- 页面弹窗(`window.open` / `target=_blank`)不再覆盖当前视图:HTTP(S) 弹窗会在同一会话窗口**新开一个标签页**并计入历史,原页面与 opener 上下文保留;非 HTTP(S) 弹窗(空 URL 弹窗承接、`mailto:`、自定义协议)仍**放行原生窗口**,交给系统处理 —— 这类弹窗不纳入会话模型。
- 自托管浏览器子进程崩溃(或宿主 DSH 重启)后会自动重启;崩溃前已打开的会话在**下一次调用时自动重建** —— 仅页面状态丢失,无需手动 `dsh_browser_reset_session`。`dsh_browser_reset_session` 仍可用于主动重置。
- 新视图创建前会先有界加载 `about:blank`(3 秒上限,保证视图一存在就有可响应的渲染进程),宿主侧命令另有 20s 有界超时。
- 子进程 stderr 与退出码/信号落到 `$DSH_HOME/logs/dsh-builtin-browser-host.log`;写之前若该文件已超过 2 MiB,则**丢弃旧内容、只写入一行带时间戳的轮转记录**(形如 `<ISO 时间戳> log rotated: previous content exceeded 2097152 bytes and was discarded`)—— 旧内容就此消失不留副本,但那一行证明"曾发生过轮转",纯 `dsh web` 自托管可据此自助排查崩溃循环。

## 不提供的东西

- **无痕模式(`privateMode`)未实现**:它需要 Electron 的 session 分区能力,属于宿主层,本插件不承诺。
- **本插件不提供任何浏览器界面**:地址栏、标签条、侧栏面板都不是插件画的。桌面端的浏览器界面是**外壳自带的官方侧栏**,我们只是借它的页面来驱动;自托管载体下画窗口的是插件拉起的那个 Electron 子进程,那是载体本身而非插件 UI。别把"侧栏"或"浏览器列"当成插件能力。

## Electron 运行时

- Electron 随插件安装;但 **Electron 44+ 不再随安装下载二进制**(约 100MB,需网络)—— 插件探测是**纯文件系统**、不触发其懒下载,二进制缺失时首次使用会报错并提示先 `npx install-electron`;也可用 `ELECTRON_PATH` 预装指定的二进制。
