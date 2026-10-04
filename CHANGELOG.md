# dsh-builtin-browser CHANGELOG

本文件记录各轮功能开发与问题修复(由仓库外独立文档迁入,随仓库管理)。

---

# 第三十六轮(2026-10-04,一轮外部审计的落实)

**随 0.4.2 发布**(第三十二~三十六轮合并)。一份外部审计给了 8 条带行号与证据链的指控,逐条用代码核实
后分三批修完。其中 **3 条我核实后不同意**,另有 1 条定性有误,都写在第五节 —— 审计的价值在于它逼着人
去看代码,不在于它的每一条结论都对。

### 一、存储与设置:读不透的东西不该等于"全部放开"

- **设置读取从 fail-open 改成 fail-closed**:文件**存在但读不懂**(JSON 损坏、写到一半、权限读不到)时,
  四个门控开关(`credentials.allowRead` 与三个动作开关)一律按**关**;其余设置取默认值。"文件不存在"
  (首次运行)仍按默认值 —— 这两件事不是同一个陈述,而原先都落到同一份全开的默认值上。
- **门控字段的类型错误按 OFF**:`bool(value, fallback)` 原先只认真布尔,其余一律回落 fallback(对这些
  开关就是 `true`),于是 `"false"` 字符串、被截断的 `null`、数字 `1` 全都读成**开**。新增 `gate()`
  区分"缺失"(取默认)与"存在但不对"(拒绝)。
- **`history.jsonl` 的整文件重写改用原子写**:原先 `writeFileSync` 先截断,进程被 TerminateProcess
  (而 Windows 上浏览器宿主正是这么被杀的)就留下半截文件;而读取端丢弃的是**半截尾部**,撕裂点之后
  的内容全丢。现在复用设置那套"写临时文件 + rename"的提交点。
- **`contentMaxChars` 重新生效**:它曾是 `?? 100_000` 的单一上限,按格式分档(html/json 50k、其余 20k)
  之后**赋值却无人读取**,连注释都写着 "No longer read"。配置项静默失效比没有这个旋钮更糟 —— 那是一个
  操作者的决定悄悄落空。现在"不设"取分档默认、"设了"就是操作者的意思,而调用方的 `maxChars` 仍然
  优先级最高。

### 二、生命周期:先请它退出,再杀它

`kill()` 的顺序反了。旧注释声称子进程的退出路径 "closes its window and flushes the profile",所以抢先
杀它才是风险 —— 这句**两半都错**:那条路径走的是 `app.exit(0)`,跳过 before-quit/will-quit 且**不**
冲刷 Chromium 的 profile 写入器;而 Windows 上 `child.kill()` 就是 TerminateProcess,子进程连一个
handler 都来不及跑。于是它"保护"的那条优雅路径从未开始,而 profile 在**每一次** dispose 都没落盘 ——
刚登录过的会话尤其如此。

现在先关 socket(那才是子进程真正处理的信号,它的 close 监听器去 quit),给一段 grace 期,仍活着才强杀。
定时器**故意不 unref**:父进程得活到能执行升级动作,否则"兜底"会随进程一起消失;它在 `fail()` 里被清掉,
所以一次普通的退出不会让事件循环白等一个已经没有目标的 kill。子进程侧也不再 `app.exit(0)`,改成
`app.quit()` 加五秒强制退出兜底。

### 三、可用性:看得见、等得到,却点不到

快照与 `waitFor` 会进 shadow root 与同源 iframe,而 click/type/setValue/fill 的目标解析只看顶层
`document`。模型刚拿到引用的元素因此回答 "not found" —— 读起来像页面过期,实际是定位缺口。两个解析
脚本现在都收集页面的全部根(与快照同一套形状),CSS 分支仍先对顶层 `document` 解析一次,好让"选择器
写错了"继续被当作参数错误而不是"还没出现"。脚本是字符串,编译器看不到,所以新增了一个守卫:驱动
provider 捕获它发出的每个脚本并逐个编译。

Windows 上补了 `%LOCALAPPDATA%` 的用户级安装位置(Chrome 的安装器在无法写 Program Files 时就装在那里,
而这是非管理员安装的常见情形),并把 "exited immediately (exit code 0)" 的文案从"路径不是可运行浏览器"
改成它真正的含义:浏览器把请求交给了已占用该 profile 的实例然后退出。

### 四、两处会静默破坏他人工作的地方

- `tools/install-web-plugin.mjs` 会把 registry 版本号直接写进 profile 的依赖,**覆盖 `link:` 钉版** ——
  那等于把开发者的工作树悄悄换成发布版,而这恰好是"我要求装一个发布版"时最不该发生的事。现在拒绝并
  指明要改哪个文件。
- adopt 失败的回滚路径没有 dispose 那个半成品 host(它可能已持有 socket、监听器或子进程)。现在先
  dispose,再注册自托管的兜底。另外侧栏桥的发现从"启动时一次"改成有限重试: `dsh web` 常在外壳之前
  启动,桥一秒后才起来就永远不会被 adopt。

### 五、核实后不同意的三条

- **"`type()` 不聚焦目标视图"**:`type()` 在页面里执行 `el.focus()`,而它用的 `Input.insertText` 正是
  插入到**页面焦点元素**;需要**视图级**聚焦的是 `key()`(`Input.dispatchKeyEvent`),而它**已经**调了
  `focusView`。两者需求不同,不是漏改。
- **"缺 `window-all-closed` / `before-quit`"**:grep 为 0 不等于行为欠缺 —— Electron 的默认行为本来就是
  "所有窗口关闭即退出"。
- **"需要 `requestSingleInstanceLock` 修孤儿"**:那会**破坏**正常重启(旧实例还在时新实例被拒),而孤儿
  本身会自愈 —— 父进程一死 OS 立刻关掉 socket,子进程据此退出。
- 另有报告把 `contentMaxChars` 说成"schema 里承诺却没人读的参数":schema 里的 `maxChars` **是**接上的,
  死的是**插件配置字段**。

### 六、未做的一条(明确搁置)

桌面侧栏桥的 TOCTOU(`guestFor()` 先查后建)与 `releasePage` 按**标题**关标签页(同名标签会被误关)属实,
但桥当前在本机不可用(两个补丁器互相覆盖 `main.js`),改它的 API 无法验证,反而增加风险。搁置,不做。

---
# 第三十五轮(2026-10-03,DSH 0.2.1 适配)

**当时仍未 bump 版本,最终随 `0.4.2` 一起发布**(与第三十二轮同)。宿主升到 **0.2.1-alpha.1**(相对 `0.2.0-rc.2`
有 **266 个提交**),所以把插件依赖的宿主 API 面逐项重核了一遍 —— 版本范围写在 `package.json` 里
只是**声明**,不是证据。

> 第三十三轮(系统浏览器载体的崩溃恢复)与第三十四轮(操作者级动作开关)的明细**当时**只在 README 的
> 更新记录表里。两节此后都已回填进本文件 —— 第三十三轮在下方,第三十四轮紧随其后。

### 一、核对结果:形状全部未变

- **`cordis`**(vendor 4.0.5-alpha.1):`Context` 与 `Service` 都在;插件用的 `ctx.effect`(含 generator
  形式)、`ctx.get(name)`、`ctx.on` 语义未变。
- **`@deepseek-ai/dsh-tools`**:`defineTool` 仍在,`DefineToolOptions` 的字段逐个比对 —— `name` /
  `description` / `parameters` / `output.schema` / `output.render` / `timeoutMs` /
  `isConcurrencySafe` / `execute` 与插件传入的写法**完全一致**;**参数规格的语义也没变**
  ("per-property parameter schema compiled to an implicit open object root")。
- **`@deepseek-ai/dsh-system-prompt`**:`ctx.systemPrompt.section(spec)` 签名未变。
- **`@deepseek-ai/dsh-llm`**:`HarnessError` 仍是可继承的错误类。
- **`@deepseek-ai/schemastery`**(vendor 3.18.5-alpha.1):默认导出仍是 schema 构造器。
- **客户端侧**:`ctx.slots.inject('settings.section', …)` 与 `ctx.slots.register({ name, id, order, label,
  locale, inject }, Component)` 的形状,与 DSH 0.2.1 自带的客户端插件(`ui-agent-preset`、
  `ui-settings-account`)**逐字一致**;`ctx.locale.register(NS, { zh, en })` 与 `ctx.locale.bind(NS)` 同理。
- `ctx.browser` **是插件自己提供的服务**(`dsh-builtin-browser/browser` 那一行),不依赖宿主 —— 这一点
  值得写下来,因为 DSH 0.2.1 新增了自己的 `ctx.browserUse` 具名槽,两者并存、互不干扰。

### 二、真机验证:新增 `scripts/verify-host-compat.mjs`

把这次的一次性核对沉淀成可复跑的探针:它用某个 profile 里**真实安装**的 `@deepseek-ai/*` 包组装一个
宿主(profile 的 `package.json` 作为解析根,因此 link 依赖与运行时一致),加载插件的**编译产物**,
经宿主自己的 `defineTool` 注册工具,再用一个假 provider 真调 `browser_session` 与 `browser_a11y`。

在 `0.2.1-alpha.1` 上实测:**全部通过** —— 34 个工具注册成功、每个工具定义都带合法的 JSON Schema 与
输出契约、`browser_session` 返回会话、`browser_a11y` 渲染出 `{#id}` 引用选择器。它不覆盖浏览器真正
启动(这里没有 Electron),也不覆盖面板在真实会话里渲染。

无法解析到 profile 时,探针明确报告"跑不了"并**以 0 退出**:探不到的宿主不等于"不兼容",为此让 CI
变红是在报告错误的东西。

### 三、两处声明层面的处理

- `dsh.compatibility.dshReleases` 记入 **`0.2.1-alpha.1` = compatible**(这是实测记录,精确版本白名单)。
- **没有**给 `peerDependencies` / `compatibility.dsh` 的范围打补丁。原因值得记下:范围
  `>=0.1.1-rc.2 <0.3.0` 在 **semver 默认语义**下**不匹配任何**带预发布标签的版本 —— 规范如此,
  预发布只被"同一 major.minor.patch 元组"的比较器允许,因此 `0.2.1-alpha.1` 需要一条
  `>=0.2.1-alpha.1` 这样的分支才认。而 DSH 自己判定插件兼容性用的是 `includePrerelease: true`
  (`packages/boot/app-boot/src/plugin-compatibility.ts:77`),在这些宿主上**本来就通过**。加那种分支是
  "按元组打补丁":DSH 每出一条新的预发布线就要再加一段,还会让人以为范围已经覆盖所有预发布。
  实测确认 `0.2.1-alpha.1` 能在这个宿主上加载运行,所以声明保持原样,把语义写进 README 说明。

---
# 第三十二轮(2026-10-03,输出成本审计与一次独立验证)

**当时仍未 bump 版本,最终随 `0.4.2` 一起发布**。前一半来自一轮"每次调用都在付的输出成本"审计
(按实测字符数量化),后一半来自一次独立验证——**验证者把修复改回旧代码后测试仍然全绿**,因此
下面多数条目同时补上了能真正失败的覆盖。

### 一、每次调用的输出成本

- **`browser_a11y`**:默认节点数 **500 → 150**(真实页面一律顶到上限,实测 38 953 字符 = 一次调用
  10k~13k token;要更多请显式传 `maxNodes`);缩进 **两个空格 → 一个空格**每层(占实测输出的
  19.7%);`states=[…]` **省略字面量 `enabled`**(`unchecked`、`collapsed` 等仍会打印)——500 个节点里有 405 个状态本来就是 `enabled`,那 22% 的
  输出零信息量,现在**没有 `states=` 就是 enabled**;结果里每个节点带 `{#id}` / `{[name=x]}` 引用
  选择器(见下条);结尾那句重复工具描述的提示改为短句 `(no coords; pass coords: true)`。
- **`browser_snapshot` 与 `browser_a11y` 现在给出可引用的选择器**:页面脚本一直为每个元素算了稳定
  选择器,工具层却把它丢掉,而三个定位工具只接受 css/text/xpath —— 模型看到 `[7] button: Submit`
  却无从引用,只能猜文本或退回截图坐标。现在元素有 `id` 或 `name` 时打印 `{#id}` / `{[name=x]}`,
  并**在每个输出 schema 里声明该字段**(`additionalProperties: false` 下,字段不在 schema 里会让
  整个结果在校验时被拒 —— 这就是它第一次真实调用时暴露出来的方式)。
- **`browser_content` 按格式设上限**:原先是一个 100 000 字符的平值(HTML 25k~33k token,而同样的
  数字对纯文本根本不构成上限) → 改为 **html 50 000、json 50 000,其余 20 000**,单次调用
  `maxChars` 可覆盖;截断提示同时说明如何收窄(光写 `(truncated)` 只会换来一次更贵的盲目重试)。
  **`json` 不再返回 `{}`**:对 DOM 节点做 `JSON.stringify` 什么也序列化不出来(属性都在原型链上),
  每个元素都得到同一个空对象,调用方读成"这页没有结构化数据"再换选择器重试一轮 → 现在返回
  `{"html": …, "tag": …}`。
- **`browser_scrape` 结果改紧凑 JSON**:两空格缩进对模型没有信息量,却占实测 39 559 字符里的一成
  以上;条目数仍在最前面。
- **`browser_history` 有了便宜用法**:它把调用方自己刚发出的参数原样回显(200 条操作实测 18 162
  字符,且随会话增长)→ 现在默认只展示**最近 20 条**且不含参数,**首行先给总条数**免得把尾部当成
  全部,要细节时传 `verbose: true`(该参数此前**声明了却没人读**,提示也跟着只在有用时才出现)。
- **`browser_execute` 的返回值上限 50 000 字符**:它原先完全没有上限,`document.body.outerHTML`
  实测 157 350 字符(一次调用 39k~52k token);截断时写明"截断于 50 000 / 实际 N 字符",避免调用方
  把截断值当成真实长度。
- **`browser_visited` 每行不再背一个会话 UUID**:30 条实测 5 319 字符里有 1 140 是那个几乎不变的
  36 位 id → 只在**会话变化时**打印一次并取 8 位前缀,时间戳去掉秒与时区(精确到分钟)。

### 二、一次独立验证(它把修复改回去,测试还是绿的)

- **`browser_visited` 曾经输出空行**:会话标记那次改动把 map 回调的 `return` 一起删掉了,
  `join('\n')` 只产出换行——URL、标题、时间戳全没了,而且没有任何测试会发现。`return` 已补回。
- **"连接卡住"必须能被判定**:只在 `!client.isAlive()` 时丢弃客户端的设计有个洞——浏览器只是
  **不再回答**时 socket 仍然是 OPEN 的,于是客户端被永久缓存,`ensureClient()` 认为它可用,之后每次
  调用都各自等满超时直到重启 DSH(这正是原始报告描述的形态)。现在的判定是"**没有应答**"
  (超时、socket 已死)与"socket 已关闭"都丢弃,而**CDP 协议错误仍然保留连接**,因为那时浏览器答了。
  独立验证者用一个"完成握手之后什么都不回"的假 CDP 服务器复现了这一条。
- 同一次验证还证明:改用例之前,H1~H3 的任何一条被改回旧代码,**测试都还是绿的**——所以这一轮
  的测试是重新做的,而不是"相信已经覆盖"。

### 三、其余修复

- **设置写入改为原子替换**:写同目录的**唯一临时文件**再 `rename` 覆盖(rename 是提交点,读者只会
  看到旧文档或新文档,不会是半份);`writeFileSync` 直接写目标会**原地截断**,崩溃/磁盘满/杀毒锁
  都能留下半个 JSON,而读者把解析失败按默认值处理 —— 那会静默把 `credentials.allowRead`、
  `cookies.persist`、`browser.channel` 一起翻回默认。临时文件带 pid + 随机后缀,两个写者不会互相
  覆盖;失败时只清理临时文件,目标文件保持原样,并且**不再把新值发布为缓存**(否则下次读取会静默
  回退成旧值)。
- **设置缓存先返回、再读文件**:`get()` 原先先读完整个设置文件、再比较 mtime,于是缓存什么都没省下
  —— 每次调用都在事件循环上同步读一遍整个文件然后丢掉。现在只有一次 `stat`,mtime 变了才读。
- **浏览历史不再每次导航重写整个文件**:prune 的判据写反了(问的是"文件是否超过上限",而一旦到达
  上限它就永远为真),于是 5001 条之后**每次导航都重写 648 KB 的整个文件**(实测 17.5~20.6ms 一次,
  9.9ms 一次导航,28.6% 的导航在付这个成本)。现在按重写后推进的水位线判断,成本按"余量"付一次而
  不是每次;另加一个"距上次重写追加了多少条"的计数,让"无事可做"的那条路径退化成一次比较而不是
  读 + 解析整个文件。
- **`browser_content` 的页内脚本曾经整体语法错误**:一个裸赋值夹在 `else if` 与 `else` 之间,IIFE
  直接抛 `SyntaxError`,**四种格式全坏**;套件里没人调用 `content()`,`tsc` 也看不进模板字符串。
  `else if (fmt === 'json')` 分支已恢复,并且页内脚本现在会从编译产物里抽出来在 `vm` 里真跑四种
  格式。
- 其他:`click`/`type`/`key` 派发到 `present()` 屏障**返回的那个 view**,view 换了就明确失败
  (`BROWSER_VIEW_CHANGED`)而不是把为 A 页算出的坐标发给 B 页;`fill` 的 `kind` 默认为 null(不做
  过滤),文本类接受 `TEXTAREA` 与 contenteditable;截图的 MIME 跟随实际请求的格式(JPEG 曾被说成
  PNG);`savePath` 的大小写折叠只在 Windows 上做、等于 `downloadDir` 自身时拒绝;`target.index`
  两层都校验;`browser_wait` 钳到工具预算以内(超预算的参数原先会让整个调用中断,连文档承诺的
  `{ready:false}` 判词都拿不到);`browser_fill` 超过 200 个字段直接拒绝并建议分批;
  `bridge-connection` 真正按请求 id 关联应答(此前发的 id 没被回传,超时请求的迟到应答会交给队列里
  的下一个调用 —— 那是"点击报成功、payload 是别人的"这类静默错误);`tools/install-web-plugin.mjs`
  在**先确认修得回来**之前不再动 profile。

**测试**:132 → **134**。

# 第三十三轮(2026-10-03,系统浏览器载体:崩溃之后真的能用)

**当时仍未 bump 版本**:`package.json` 与 tag 当时都还是 `0.4.1`,以下内容最终随 `0.4.2` 发布。

0.4.1 修的是"进程死了要重连",这一轮修的是**重连之后能不能用**,以及**不要把慢页面当成死浏览器**。

### 一、重连之后确实可用(H1~H3 的收尾)

- **一个命令失败不再拆掉整条连接**:CDP 协议错误意味着浏览器**答了并拒绝**这一条命令,连接是健康的。
  以前 `sendCommand` 把 `client.send` 包在同一个 `try` 里,于是"人类关了标签页(`session not found`)、
  导航把执行上下文换掉、选择器没解析成功"这类普通失败都会关掉浏览器级 WebSocket。
- **重启后清掉的是会话映射,不只是缓存里的连接与子进程**:退出监听原先只清 `client`/`child`,
  `views`/`sessions` 留着,于是新的浏览器收到的每条命令都带着**上一个进程发放的 session id** ——
  这正是上报的"重启之后每条调用都失败、永不恢复"的成因。另外,主动 `kill` 旧进程再 spawn 的那条路
  会在旧 child 的 `exit` 触发前就改写 `this.child`,那个监听器因此**提前返回、什么也没清**:现在
  放弃一个 child 时直接清客户端与两个映射表。
- **同一份 `--user-data-dir` 不会再拉起第二个浏览器**:旧子进程先被 kill,spawn 失败（如 `.cmd` 在
  Windows 上被拒）**同步抛出并说明原因**,而不是逃出 `start()`。
- **回归测试不再恒为绿**:上一版那份测试用的桩是 `.cmd`,Node 拒绝 spawn(EINVAL,同步)——
  三个断言恰好都能被一次 spawn 失败满足,CI 一直是绿的而退出处理一次都没跑。换成真能说 CDP 的
  夹具后,测试走完"写端口文件 → 连接 → 发放 session → 浏览器死亡 → 新端口新 session 的替代进程上线"
  全链路,断言是正向的。

### 二、慢页面不是死浏览器

以错误**文本**判断连接死活,两个方向都会错:外层调用常常只有 5s(等待轮询)或 15s(滚动/定位),
而内层 `CdpClient` 是写死的 30s,所以外层先失败、内层计时器 15~25 秒后才在这个 catch 里触发 ——
**一次慢页面就杀掉浏览器**,人打开的标签与填到一半的表单一起消失(比它要修的"连接被丢弃"更糟)。
状态现在是三态:

- **socket 已关闭** → 丢弃(浏览器确实没了);
- **有应答但拒绝** → 保留(一条命令失败,连接健康);
- **没有应答** → 标记为**存疑**,下一次调用先用 `Browser.getVersion` 探一次,答得上就继续用。

另外,失败的 catch 原先关的是 `this.client` **字段**(在判过本地变量之后),并发下这个字段可能已经是
别的调用刚发布的健康连接 —— 现在只动**本次调用实际用的那个客户端**。

### 三、启动链路的两个竞态

- **kill 之后要等它真的死**:`kill()` 只负责发信号,Windows 上是异步的 `TerminateProcess`,进程可能
  还占着这个 profile 的单例锁 —— 立刻 spawn 会让新进程把命令行交给旧实例然后自己退出,而那个退出
  被报成"检查这个路径是不是可运行的浏览器",**把代码自己制造的竞态怪到用户安装上**。现在**最多等
  3 秒**它的退出事件,拒绝死的进程也不会挂住调用。
- **只认本次启动写下的端口**:`DevToolsActivePort` 从不清除也从不判新旧,而**被杀掉的浏览器没有机会
  清理它**,于是第一次重启之后那份文件描述的一直是**上一个**浏览器;如果那个端口现在属于别的
  Chromium、或者一个 `node --inspect`,宿主会连上去、发布一个不属于自己的客户端,`dispose()` 永远
  杀不掉它。现在 spawn 前先删掉该文件,且**只接受写入时间晚于本次 spawn 的**那一份。

### 四、cookie 导出的作用域(两次修复才真正做到)

- 第一次的写法**无效**:它给 `Storage.getCookies` 传 `urls`,而那个方法只认 `browserContextId`,
  浏览器照旧返回整个 jar,注释却声称做了过滤(`urls` 属于 `Network.getCookies`);更糟的是**页面 URL
  取不到时会退化成不过滤的读**,错误路径反而要得比正常路径更多。现在 CDP 走 `Network.getCookies`,
  自托管侧栏按 view 自己的 URL 过滤,**两侧在范围未知时一律拒绝**,而不是放宽。
- **`browser_auth` 不再是只读工具**:它在 `flush` 时读、在 `restore` 时**向任意域写** cookie
  (没有域白名单,正是会话固定攻击的原语),所以它和别的动作一样受 `browser_restrict` 白名单管辖;
  只豁免 `flush` 挡不住 `restore`。
- **恢复的条数反映真的提交了多少**:`Storage.setCookies` 没有返回值,`result.cookies` 永远是
  `undefined`,计数恒为 0 —— 工具报"Restored 0 cookies."并带成功状态,cookie 其实已经写进去了,
  读起来像失败。同时,无法构成有效 URL 的 cookie 会被**过滤掉并报出丢弃条数**,不再让一条坏数据
  使整批失败。
- 自托管侧的 `cookies.get` / `cookies.set`(后者每条 cookie 一次)与下载的 `Runtime.evaluate`
  都套上了同一套 `COMMAND_TIMEOUT_MS`:这些无上限的 await 会让串行操作队列永久停在那一条上——
  窗口活着、进程活着、之后每个 `browser_*` 都超时,直到重启 DSH。这一轮补齐了先前提交声称做完
  却只做了一半的三条。

**测试**:134/134(与 0.4.1 的 132 相比,新增的是"浏览器真的能被替换"那份夹具与重启用例)。

# 第三十四轮(2026-10-03,操作者级动作开关)

**当时仍未 bump 版本,最终随 `0.4.2` 一起发布。**

> 本节按 README 的更新记录表回填,并逐条对照 `src/` 核实。它当时只进了 README 那张表,没有进本文件 ——
> CHANGELOG 是"每轮都记"的地方,缺的这一段现在补上,不假装它一直在。

`browser_restrict` 是**模型自己**的软护栏:它由模型设定,也由模型解除。所以"别让 agent 在页面里执行
脚本""别让它往磁盘写文件"这类要求,此前**没有任何东西能满足** —— 模型可以把自己的白名单撤掉。这一轮
补上真正由**操作者**持有的那一层。

### 一、设置页新增「Agent 能做什么」

三个开关,与设置文档的 `actions` 段一一对应(`src/browser-electron/settings-store.ts`):

- **执行页面脚本** → `actions.allowExecute`,关闭即拒绝 `browser_execute`(`BROWSER_EXECUTE_DISABLED`);
- **下载文件到磁盘** → `actions.allowDownload`,关闭即拒绝 `browser_download`(`BROWSER_DOWNLOAD_DISABLED`);
- **写入登录状态** → `actions.allowCredentialWrite`,关闭即拒绝 `browser_auth` 的 `restore`(`BROWSER_AUTH_WRITE_DISABLED`)。

三个都默认**开**(即出厂行为)。门控在 `ElectronBrowserProvider.assertActionAllowed()` 里,并且**每次
调用现读**设置文档,所以改完即时生效、不需要重启插件。

### 二、与 `browser_restrict` 的区别是"谁能改",不是"谁更强"

- `browser_restrict`:模型可设定、也可解除;防误操作,不是安全边界。
- 这三个开关:写在**设置文档**里,而 `browser_*` 工具**没有一个会写它** —— 模型只能被拒,不能不认。
- 部署级还有第三层:`tool-browser` 行的 `allowedActions` 配置(见 `cordis.patch.yml` 的注释),对该
  部署里的每个任务生效;任务仍可用 `browser_restrict` 在其中再收窄。

### 三、顺带修正一处读/写混淆

恢复登录态(`browser_auth` 的 `restore`)原先查的是**读**开关(`credentials.allowRead`),报错还说
"reading cookies is switched off"。两个后果都不成立:允许读取的操作者**没有任何开关能拒绝写入**,
而关掉读取的人会连带失去 `restore`,理由还是错的。现在 `restore` 归 `actions.allowCredentialWrite`,
`flush` 归 `credentials.allowRead`,读与写可以分别设置。

**测试**:148 → **157**(此数字取自 README 的更新记录表;本节回填时未重跑当年的用例)。

## 0.4.1 发布(2026-10-02)

**修复 issue #21:系统浏览器载体(chrome/edge)进程死亡后不重连、不重启,所有 `browser_*` 调用挂起 30 秒,**
**只能重启 DSH。**

启动阶段的失败上一轮已经处理(加了 `error` 监听、轮询里检查退出码),但**启动成功之后**的死亡完全没有
观察:没有 `exit` 监听,`this.client` 赋值后从不清空,于是 `ensureClient()` **永远返回那条已断开的连接**,
每条命令各自等满自己的超时。自托管载体一直有崩溃自动重启,这一条没有。

按报告里的两种失败形态分别处理:

- **进程死亡** → 子进程现在**全程**被观察,退出即清空缓存的 client 与 child,下一次调用会**重新拉起**浏览器;
- **socket 死亡而进程存活**(浏览器关掉了调试端点、连接被丢弃)→ 使用缓存的 client 前先查其存活状态;
- **进程与 socket 都在、但命令不再回答** —— 报告者看到的第二种形态:Edge 的 `/json/version` 返回 200、
  `/json/list` 正常列出标签,而 socket 上再也不回来任何东西。**这种状态没有任何存活检查能发现**,所以改为:
  **命令失败即丢弃 client**,下一次调用重新开始。

此外,**在已关闭的 socket 上发命令会立刻失败并说明原因**,而不是等满预算再报一条指向不到真正原因的"超时"——
报告者指出,原来那条超时让人以为插件坏了,排查成本极高。

新增两条回归测试(用一个**立即退出**的桩浏览器):断言命令**及时**失败且错误不误导,以及第二次调用**不会**
挂在陈旧 client 上。

**测试**:130 → **132**。

## 0.4.0 发布(2026-10-02)

第二十七~三十一轮合并发布。这一版的主题是**把"限制"分成真限制与实现限制**:两轮独立
代码审查发现,README 里写着的一批"已知限制"其实不是载体做不到,而是实现没走那条路 ——
同时审出并修掉了若干会崩进程、会静默做错事、会永久挂住的缺陷。

**能力放开**(原本被过度保守地限制)

- `browser_auth` **三种载体都可用**:以前只有自托管能导出/恢复 cookie,因为实现直接调用
  只有它才有的原生方法;但 cookie 本来就在 CDP 里(`Storage.getCookies` / `Storage.setCookies`),
  而三种载体全都走 CDP。现在有原生方法时优先用它,否则走 CDP;两侧换算处理了 domain+path
  与 URL 的差异、前导点写法、秒与毫秒,并**丢弃无法构成有效 URL 的 cookie** 而不是导出个恢复
  不了的东西。
- **本机 Chrome / Edge 支持 JPEG**:JPEG 原本对所有 CDP 路径禁用,理由是"CDP JPEG 在
  Electron 上挂起"——对 Electron 成立,对真浏览器无关。view 现在通过 `supportsCdpJpeg` 声明自
  己能否编码,只有本机浏览器声明;侧栏保持 PNG(在那里这句话仍然成立)。
- **降采样三种载体都可用**:工具描述一直承诺 `maxWidth`/`maxHeight`,却只在原生路径实现。
  CDP 路径改用 `clip.scale`(先读 `Page.getLayoutMetrics` 取文档尺寸,读不到就**不缩放地照常
  截图**)。

**修复**(由两轮独立审查发现,其中多条被审查者亲手复现)

- **会崩宿主**:`spawn` 出来的浏览器子进程**没有 `error` 监听**,而启动失败(ENOENT、无执行
  权限、二进制损坏)是**异步事件** —— 无监听即 unhandled,Node 会**把整个 DSH 进程带走**;
  现在改为让该次命令失败并说明原因。
- **取消被吞**:`navigate` 只在开头检查一次 signal,而 `settleDocument` 遇到 abort 是静默
  return,于是被取消的导航**全程无异常** —— 向调用方报成功、记入历史、还把这一页写进持久
  浏览历史。
- **设置写失败静默回退**:写失败后仍把新值发布为缓存并用当前时间戳,读者拿它和文件 mtime
  比对 → 下次读取重新读盘、**静默回退成旧值**;而且 HTTP 路由无论存没存都回 `ok:true`。现在
  失败即清空缓存并抛错,路由随之返回 400。
- **凭据开关是死的**:`credentials.allowRead` 只存在于设置存储与面板,**没有任何代码读它** ——
  用户关掉"允许 agent 读取 cookies"后 `browser_auth` 照常导出全部 cookie。两条 auth 路径现在
  真的受它门控。
- **只读工具被白名单拦**:工具描述与 README 都承诺只读工具永不被拦,实际只豁免
  `browser_restrict` 自己,过窄的白名单会把 agent 的 `browser_history`、`browser_reset_session`、
  `browser_auth` 一起锁死。现在有显式的只读集合。
- **`browser_restrict` 跨任务锁死**:限制写在每 apply 一份的状态上,却与按任务分键的会话映射
  并列,一个任务的限制会锁死所有任务。现在按任务分键,配置级的单独放。
- **`browser_fill` 漏 `value` 会反向取消勾选 / 清空文本,还报成功** —— 现在报错并指明字段。
- **跨会话操作标签**:`locateTab` 在本会话找不到就遍历所有会话,陈旧 id 能关掉**别的任务或
  人类**的标签页还报成功。现在只查本会话。
- **挂死**:`CdpClient.whenReady()` 等待无界的 promise、`focus()` 是全文件唯一没有预算的 await ——
  两者都能让一次工具调用永不返回。
- **泄漏**:`dispose()` 落在启动轮询期间会让已拉起的浏览器无人可杀;`browser_wait` 每轮泄漏一个
  abort 监听器(30s 等待约 150 个);每个无 agent 的 default 会话各注册一个 exit 监听器且从不
  摘除。
- **报错指向错误的方向**:三种不同的失败(子进程退出/被释放/真超时)共用一条"30 秒内没暴露
  CDP",而且**半秒就报出来**;scrape 的外层超时必然先于页内到期,页内已判明的"no elements
  matched"永远传不回来。
- **明确选择被侧栏顶掉**:选了 chrome/edge 仍被桌面侧栏覆盖,这同时让"你选的浏览器没装"那条
  说明永远无法出现。
- 以及:`el` 别名导致 `kind` 定向打到错误元素、历史首条被 BOM 吞掉、`browser_auth` 空列表静默
  "恢复 0 个"、`fill.kind` 页内从不读取、`focus()` 注释与 Windows 实际行为不符、若干死代码,
  和一条 flaky 测试(30ms 窗口配 40ms 等待,约 11 次失败 1 次)。

**测试**:100 → **130**(新增独立审查要求的回归覆盖,含"只读工具不被白名单拦"这条此前零覆盖
的承诺)。

- **第二十七轮 · 释放后的宿主必须保持释放**:`ensureClient` 未检查 `disposed`,于是释放后再调用会**重新拉起一个没人管的浏览器**;`start()` 轮询端口时也未检查,若 `dispose()` 恰好落在启动过程中,进程被 kill 而循环仍会连上它,留下悬空连接。两处都修,并补测试断言"已释放的宿主报告不可用、命令失败、不产生任何进程"。
- **第二十八轮 · 两条"限制"其实是实现限制**(由文档审查引出):`browser_auth` 原本只走自托管才有的原生方法,但 **cookie 本来就在 CDP 里**且三种载体全走 CDP → 现在有原生方法时优先用它、否则走 `Storage.getCookies`/`setCookies`,**三种载体全部可用**;JPEG 被对所有 CDP 路径禁用虽然对 Electron 成立,但**对本机 Chrome/Edge 无关** → 新增 `supportsCdpJpeg` 能力声明,只有本机浏览器声明;降采样在描述里承诺了却只在原生路径实现 → CDP 路径改用 `clip.scale`。文档同时补齐两条从未写过的载体差异。
- **第二十九轮 · 独立代码审查**(另派审查者通读全树并亲手复现):
  - **会崩宿主**:`spawn` 出的子进程**没有 `error` 监听**,而启动失败(ENOENT / 无执行权限 / 二进制损坏)是**异步事件** —— 无监听即 unhandled,Node 会**带走整个 DSH 进程**;现在改为让该次命令失败并说明原因;
  - **资源泄漏**:`dispose()` 落在 `start()` 的 250ms 轮询期间时,已拉起的浏览器**无人可杀**;轮询现在会在退出前 kill 它;
  - **错误信息误导**:三种不同失败(子进程退出 / 被释放 / 真超时)共用一条"30 秒内没暴露 CDP",而且**半秒就报出来**;现在各自说明真实原因;
  - **抵消修复的优先级矛盾**:**明确选择 `chrome`/`edge` 时仍被桌面侧栏顶掉**(发现流程从不检查 channel),这同时让"你选的浏览器没装"那条说明**永远无法出现**;现在明确选择会跳过侧栏发现;
  - **永不返回**:`CdpClient.whenReady()` 等待的 promise 无界,连接被中间层丢弃时那次工具调用永不返回 → 已加界;
  - **事实错误**:`focus()` 用 `kill('SIGCONT')`,在 Windows 上是空操作,而注释承诺"把窗口前置" → 注释改为实情;
  - **死代码**:删除不可达的 `brave` 分支。

## 0.3.0 发布(2026-10-01)

第二十一~二十六轮合并发布。要点:

- **桌面端改由官方侧栏承载**:agent 操作的页面就是人看到的那个页面,不再多开一个窗口(需要 `desktop-bridge/install.mjs`;桌面端升级后重跑一次);
- **可选用本机 Chrome / Edge**:以独立 profile 启动,不碰用户日常的窗口、书签与登录状态,登录态按 `cookies.persist` 决定是否保留;
- **需求表 v2 全部落地**:视觉策略真正生效、快照对无视觉模型更友好、沙箱边界明示、生命周期开关接线、多会话标签隔离、历史可按关键词与来源会话检索、光标带操作气泡;
- **性能**:每条命令 49.1ms → 0.6ms(长连接复用 + 去掉逐次存活检查);
- **修复**:issue #16(错误上报路径致命)、CVE-2026-84961(undici),以及 6 个实测发现的 bug(逐字动画文本被拆散、重启后首次调用必失败、三个设置项是死的、释放会关掉别人的标签、设置文件带 BOM 时全部设置被丢弃)。

> 升级提示:桌面端需重跑一次 `node desktop-bridge/install.mjs`;Web 端无此步骤。详见 README「更新方式(两端不同)」。

---

## 第一轮:安全与健壮性修复

- **日期**:2026-08-18
- **对象仓库**:`wqty123/dsh-browser`(DeepSeek Harness 共享浏览器插件,版本 0.1.15)
- **状态**:修复已完成并通过验证,已作为**单独一次提交**保存在本地 git,**未推送**。

---

## 一、改了什么

共修改 **30 个文件**:`src/` 15 个(源码)+ `lib/` 15 个(随仓库发布的构建产物,已重新编译同步)。

| 文件 | 改动内容 |
| --- | --- |
| `src/browser-electron/remote-host.ts` | RPC 认证(随机 token 握手 + 单连接强制);下载自动创建目标目录 |
| `src/browser-electron/host-main.ts` | 首条消息回传 token(hello);窗口 resize 同步视图;弹窗接管;下载流式限流 + Content-Length 提前拒绝 |
| `src/browser-electron/provider.ts` | 下载准入(仅 http/s、绝对路径、`downloadDir` 限定);CDP 超时后打断(terminateExecution / stopLoading);click/type 超时与松键恢复;closeTab 激活下一个标签;快照 selector 用 `CSS.escape`;replay 保留 number/boolean 参数 |
| `src/browser-electron/entry.ts` | 透传新增的 `downloadDir` 配置 |
| `src/browser/types.ts` | 修正准入注释(与实际行为一致) |
| `src/tool-browser/index.ts` | 会话/白名单状态改为每 context 作用域;会话绑定 agent 生命周期自动关闭;`browser_auth` 凭证敏感提示;`browser_history` 对输入文本脱敏;5 个变更型工具改为串行标记 |
| `src/browser/runtime.ts`、`src/index.ts` | 相对导入后缀 `.ts` → `.js` |
| `src/types/electron-shim.d.ts` | 补充 `setWindowOpenHandler` / `loadURL` 类型 |
| `tsconfig.json` | 移除 `allowImportingTsExtensions` / `rewriteRelativeImportExtensions`(修 .d.ts 产物) |
| `lib/**` | 全部按新源码重新构建 |
| `README.md`、`README.en.md`、`docs/architecture.md`、`docs/tool-reference.md`、`docs/user-guide.md` | 修正过时表述(测试脚本、版本号),补充下载准入、`downloadDir`、弹窗行为、RPC 认证说明 |

---

## 二、每个问题修了什么

### 🔴 安全问题

**1. 自托管 RPC 无认证——本机任意进程可接管浏览器(高)**
- 问题:父进程在 loopback 临时端口起 TCP 服务,协议无 token、无身份校验。本机任意进程可抢先伪冒子进程(读到全部命令,包括注入页面的 JS、下载内容、cookie),或在子进程已连接后再连一个 socket 劫持回复(id 从 1 递增可猜),造成页面任意 JS、cookie 窃取、任意文件写入。
- 修复:每次 spawn 生成随机 token(`--rpc-token` 传入);子进程首条消息必须回传该 token(`hello`),认证前命令一律排队不发;服务端只接受**一个**连接,其余直接断开。
- 涉及:`remote-host.ts`、`host-main.ts`。

**2. `browser_download` 任意文件写入 + 无 URL 准入 + 先全量缓冲再限流(高)**
- 问题:`savePath` 完全由 agent 控制可覆盖任意文件;URL 不校验协议(可打本地服务);整个 body 先拉进内存,之后才检查 256MB 上限,超大文件直接 OOM。
- 修复:URL 仅允许 http(s);`savePath` 必须为绝对路径;新增 `downloadDir` 配置,设置后保存路径必须位于该目录内(防 `..` 逃逸);下载改为流式读取,按 `Content-Length` 提前拒绝、边读边限流;自动创建目标目录。
- 涉及:`provider.ts`、`host-main.ts`、`remote-host.ts`、`entry.ts`。

**3. `browser_auth flush` 将全部会话 cookie(含 HttpOnly)明文返回给模型(中)**
- 问题:导出 cookie 是实时登录凭证,模型可能回显进对话或写入日志。
- 修复:工具描述与输出结果均明确标注"LIVE CREDENTIALS——请存私有文件、勿回显、勿入日志"。
- 涉及:`tool-browser/index.ts`。

### 🟠 健壮性问题

**4. CDP 调用超时后底层命令仍挂起 → 会话永久卡死(高)**
- 问题:`withTimeout` 只在父侧 reject,不取消底层 CDP 命令;`awaitPromise: true` 下页面死循环/永不 settle 会占死该 target 的 debugger 队列,后续所有命令排队挂起。
- 修复:超时/中止时 best-effort 发送 `Runtime.terminateExecution` 打断页面脚本(导航超时发 `Page.stopLoading`)。
- 涉及:`provider.ts`。

**5. 任务会话泄漏 + 模块级全局状态破坏多 context 隔离(中)**
- 问题:会话映射/白名单是模块级变量,多 context 共享串扰(`browser_restrict` 一个任务限制全局生效);任务结束没有任何 hook 关闭会话,窗口/视图只增不减。
- 修复:全部状态改为**每插件 apply(每 context)作用域**;会话生命周期绑定 agent 作用域 ctx(`agent.ctx`),agent(DSH 会话)销毁时自动关闭浏览器会话。
- 涉及:`tool-browser/index.ts`。

**6. 自托管窗口 resize 后视图不跟随(中)**
- 问题:视图只在创建时设置一次 bounds,窗口调整大小后页面尺寸错位。
- 修复:监听窗口 `resize` 事件,同步更新全部视图 bounds。
- 涉及:`host-main.ts`。

**7. 弹窗不受控(中)**
- 问题:页面 `window.open` / `target=_blank` 会打开未跟踪的原生窗口,破坏"标签即会话"模型。
- 修复:`setWindowOpenHandler` 拒绝弹窗,并把 http(s) 弹窗重定向到当前标签页内打开。
- 涉及:`host-main.ts`、`electron-shim.d.ts`。

**8. click/type 无超时 + 状态污染(中)**
- 问题:`click` 的 press/release 是两个独立命令且无超时;中途失败会留下"鼠标按住"状态。
- 修复:两个命令均包 30s 超时;press 成功后 release 失败时 best-effort 补发 release。
- 涉及:`provider.ts`。

### 🟡 正确性 / 小问题

| # | 问题 | 修复 |
| --- | --- | --- |
| 9 | `closeTab` 关闭活动标签后激活**最后一个**标签,文档写"激活下一个" | 改为激活下一个(被关闭的是最后一个时收敛到上一个) |
| 10 | 发布包 `.d.ts` 仍引用 `./types.ts`(TS 的 `rewriteRelativeImportExtensions` 只改 `.js` 不改 `.d.ts`,见 TS#61037) | 源码相对导入改 `.js` 后缀,移除两个不再需要的编译选项,重新构建 `lib/` |
| 11 | 快照 selector 用 `'#' + id`,含特殊字符的 id 生成无效 CSS | 改用 `CSS.escape(id)` |
| 12 | `browser_history` 暴露 `type` 输入文本(可能含密码) | 工具输出脱敏(provider 内部保留原文供 `browser_replay` 使用) |
| 13 | `browser_open` 等 5 个会变更会话状态的工具标记 `isConcurrencySafe: true` | 全部改为 `false`(框架内 exclusive 串行) |
| 14 | 类型注释声称"拒绝凭据/私网目标",实现并未做 | 修正注释为"仅 HTTP(S) 准入",明确不拦 localhost(共享浏览器合法访问本地开发服务) |
| 15 | `browser_replay` 只保留 string 类型的 args | 保留 string/number/boolean |
| 16 | README 声称"见仓库测试脚本"(仓库实际无测试),版本号写 0.1.11(实际 0.1.15) | 修正两处表述,并同步补充新行为说明 |

---

## 三、验证情况

- `tsc --noEmit`:零错误(本地临时安装 TypeScript 5.9.3 + peer 依赖验证,验证后已清理 `node_modules`)。
- 构建产物:重新编译 `lib/`,声明文件 `.d.ts` 的导入后缀已全部为 `.js`。
- 冒烟测试(用假 `ElectronBrowserViewHost` 驱动编译后的 provider,共 15 项断言全部通过):
  - closeTab 激活逻辑(关闭活动/非活动/中间标签);
  - 下载准入:非 http(s) 拦截、相对路径拦截、`..` 逃逸拦截、目录内放行;
  - 挂起的 `Runtime.evaluate` 超时返回 `BROWSER_EXECUTE_TIMEOUT` 且触发 `Runtime.terminateExecution`;
  - click 第一次 release 失败后自动补发 release(不留"按住"状态)。

---

## 四、备注

- 本次提交**未 bump 版本号**(当前仍为 0.1.15);如需发布,按仓库惯例应 bump 到 0.1.16 并重新 `prepack`。
- 改动已提交到本地 git(**未推送**);如需上传请另行告知。

---

# 第二轮:功能补全与体验优化(2026-08-18)

在第一轮修复之后,针对评审列出的剩余不足做了一轮功能补全。同样已作为单独一次提交保存在本地 git,未推送。

## 改了什么

| 文件 | 改动内容 |
| --- | --- |
| `src/browser-electron/host-main.ts` | 窗口标题实时显示当前可见会话(任务)+ 页面标题/URL;重复 showView 跳过 remove/re-add 消除闪烁;下载改为子进程直接落盘(临时文件 + rename,不再经 RPC 传 base64);截图支持 JPEG/缩放 |
| `src/browser-electron/provider.ts` | 新增 `waitFor`/`scroll`/`back`/`forward`/`key`;快照穿透 iframe/Shadow DOM(绝对坐标 + frame 标记);content 的 txt/markdown 穿透;challenge 检测扫同源 iframe/shadow;`available()` 委托 host 探测;`downloadDir` 默认收敛到 `~/Downloads`;快照脚本先 rect 后 style |
| `src/browser-electron/remote-host.ts` | `showView` 携带会话 label;`available()` 探测 Electron 二进制(带缓存);Electron 扫描范围收敛(去掉 cwd/execPath);capture 透传格式/缩放参数 |
| `src/browser/types.ts` | 新增 `BrowserWaitRequest/Result`、`BrowserScrollRequest`、`BrowserKeyRequest`;`open(label?)`;快照元素 `frame` 标记;截图 `format/quality/maxWidth/maxHeight` |
| `src/browser/runtime.ts` | seam 透传 `waitFor`/`scroll`/`back`/`forward`/`key`/`open(label)` |
| `src/tool-browser/index.ts` | 新增 6 个工具:`browser_wait`、`browser_scroll`、`browser_back`、`browser_forward`、`browser_key`;`browser_screenshot` 增加 JPEG/缩放参数;`browser_restrict` 标注为软护栏 |
| `src/types/electron-shim.d.ts` | `setTitle`/`getTitle`/`getURL`/`toJPEG`/`resize` |
| `package.json` | 新增 `test` 脚本 |
| `tests/provider.test.mjs` | 新增 11 项单元测试(假 host,无需 Electron) |
| `.github/workflows/ci.yml` | 新增 CI(安装/构建/测试) |
| `README.md`、`README.en.md`、`docs/*` | 工具表、配置表、已知限制、操作纪律、自托管说明同步更新 |
| `lib/**` | 重新构建 |

## 每个问题怎么解决的

| # | 问题 | 解决 |
| --- | --- | --- |
| 7 | 多任务可见性:多会话抢同一窗口、无归属标识、每次操作视图闪烁 | 窗口标题实时显示当前可见会话(任务)+ 页面标题/URL;重复 showView 跳过 remove/re-add(消除每次操作的闪烁);resize 自动跟随 |
| 1 | 看不到 iframe / Shadow DOM 内容 | 快照穿透同源 iframe 与 shadow root(跨域 iframe 受浏览器安全限制仍不可读),iframe 内元素标注 `frame` 且坐标换算为顶层文档绝对坐标;content 的 txt/markdown、challenge 检测同步穿透 |
| 2 | 没有等待页面就绪原语(白屏快照重试) | 新增 `browser_wait`(等加载完成 + 可选期望 URL/选择器,未就绪返回原因不抛错) |
| 3 | 交互原语太裸 | 新增 `browser_scroll`(增量/选择器/顶底)、`browser_back`/`browser_forward`(历史)、`browser_key`(Enter/Tab/方向键等命名按键) |
| 4 | `available()` 恒为 true,provider 选择逻辑形同虚设 | host 增加可选 `available()` 探测;自托管 host 探测 Electron 二进制(缓存),缺失时返回 `BROWSER_PROVIDER_UNAVAILABLE` |
| 5 | 桌面壳下 download/auth 不可用 | 属宿主层能力缺口(宿主未实现该接缝方法),文档明确标注自托管专用;接缝已就绪 |
| 6 | 平台承诺窄(仅 Windows 实测) | 属实测范围问题,保持文档如实声明(macOS/Linux 未验证) |
| 8 | `browser_restrict` 是软护栏但未说明 | 工具描述与文档明确标注:防误操作软护栏,模型可自行解除,非安全边界 |
| 9 | `downloadDir` 默认未设置,agent 仍可写任意路径 | 默认收敛到 `~/Downloads`(系统下载目录,人类可见),可配置 `downloadDir` 覆盖为沙箱目录 |
| 10 | cookie 明文落盘;下载走 base64 大消息(内存峰值高) | 下载改为**子进程直接写文件**(临时文件 + rename),body 不再经 RPC 传输,彻底消除大消息;cookie 明文属 Electron 默认行为,文档标注需宿主层钥匙串/DPAPI |
| 11 | Electron 二进制扫描范围过广(可能捡到无关项目) | 扫描范围收敛为插件自身安装树 + DSH 锚点,去掉 cwd/execPath |
| 12 | 零测试、零 CI | 新增 `tests/provider.test.mjs`(11 项,假 host 无需 Electron)+ `package.json test` + GitHub Actions CI |
| 13 | 快照性能(O(n) 布局抖动) | 先 `getBoundingClientRect` 后 `getComputedStyle`(只有尺寸通过才强制样式重算) |
| 14 | 截图仅 PNG 且不可缩放 | 自托管原生路径支持 JPEG(`toJPEG`)+ 等比缩放(`maxWidth`/`maxHeight`);桌面壳 CDP 回退仍 PNG(平台缺陷) |

## 验证

- `tsc --noEmit` 零错误;构建通过。
- `node --test tests/*.test.mjs` 11 项全部通过:标签生命周期、`open(label)` 透传、`available()` 委托、下载准入(协议/相对路径/`..` 逃逸/默认目录)、`waitFor` 就绪与超时、挂起 execute 超时并触发 terminate、click 失败补发 release、key 支持/拒绝未知、back/forward 步进与边界空操作、scroll 记录。

## 备注

- 新增工具后共 25 个 `browser_*` 工具(原 20 + wait/scoll/back/forward/key)。
- 未 bump 版本号;未推送。

---

# 第三轮 + 审查修复说明 (commit 87508cc)

- **日期**:2026-08-18
- **状态**:已提交,未推送。22 个文件,+4271/-429 行。

## 一、第三轮新增功能

| 特性 | 文件 |
| --- | --- |
| browser_a11y:无障碍树工具(role/name/value/states/坐标,iframe/shadow 穿透) | provider.ts, types.ts, runtime.ts, index.ts |
| browser_scrape:静态 CSS 结构化提取(不执行任意代码) | provider.ts, types.ts, runtime.ts, index.ts |
| browser_set_value/check/select/clear/get_value:完整表单控件 | provider.ts, types.ts, runtime.ts, index.ts |
| browser_click/type 支持 target {by: css/text/xpath, value} 语义定位 | provider.ts, types.ts, runtime.ts, index.ts |
| browser_refresh:刷新当前页 | provider.ts, types.ts, runtime.ts, index.ts |
| 每个会话独立 BrowserWindow + 真实工具栏(地址栏/后退前进/刷新/标签条) | host-main.ts |
| 用户工具栏操作路由回会话模型(人和 agent 共享标签/导航) | host-main.ts, remote-host.ts, provider.ts |

## 二、审查修复 (5 HIGH + 10 MEDIUM)

| # | 级别 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | HIGH | RPC token 通过 --rpc-token argv 暴露给同用户进程 | token 改从 stdin 传入(首行);spawn stdio 改为 pipe |
| 2 | HIGH | browser_replay 的 type 条目绕过脱敏 | 挂载对 replay+type / replay+setValue 同样掩码;execute 脚本/参数/结果全部脱敏 |
| 3 | HIGH | host-main Cookie.domain? 合并 string 类型错误 | `c.domain ?? ''` 兜底 |
| 4 | HIGH | CI pnpm cache 需要 lockfile(仓库无) | 改用 npm + npx tsc + node --test |
| 5 | HIGH | README 声称"无测试套件"但已新增 | 修正 README/README.en |
| 6 | MEDIUM | download() 超时无打断 | 文档化(子进程无 abort 机制,父侧 pending 已清理) |
| 7 | MEDIUM | downloadDir 大小写敏感(Windows 假拒绝合法路径) | 比较前 toLowerCase() |
| 8 | MEDIUM | 默认 ~/Downloads 可能是 OneDrive 重定向 | 注释+文档说明非安全边界 |
| 9 | MEDIUM | terminatePage 无界 fire-and-forget | WeakMap 计数,上限 3 并发 |
| 10 | MEDIUM | 无 agent 的 default 会话永不关闭 | process.on('exit') 清理 |
| 11 | MEDIUM | agent.ctx.effect 抛错后 pendingOpens 永久毒化 | 先 set/delete 再 effect,catch 中 undo |
| 12 | MEDIUM | browser_close_tab 缺 assertAllowed | 补上 |
| 13 | MEDIUM | restrictedTo 跨任务泄漏疑虑 | 注释澄清:per-Cordis-context = per-task |
| 14 | MEDIUM | 窗口销毁后标题残留;OAuth window.open 被拒 | 销毁可见视图后重置标题;非 http(S) popup 放行 |

## 三、验证

- `tsc --noEmit` 零错误。
- `node --test tests/*.test.mjs` 18 项全部通过(含第三轮新增: a11y、form ops、scrape、target、userAction、reload)。
- 版本号未 bump。三轮合计 3 个提交未推送。

---

# 第四轮:DSH 更新对齐 + 复查修复

## 一、DSH 更新对齐

- DSH(Harness)已更新到 **0.1.1-rc.2**(`@deepseek-ai/dsh` latest = next = 0.1.1-rc.2;`dsh-llm`/`dsh-tools`/`dsh-system-prompt` 同版本)。
- 验证:用 0.1.1-rc.2 安装后 `tsc --noEmit` 零错误、18 项既有测试全绿 —— 插件与新版 DSH 完全兼容。
- `package.json` peerDependencies 下限从 `^0.1.0-rc.1` 对齐到 **`^0.1.1-rc.2`**(语义上旧范围已覆盖,显式对齐当前基线)。
- `cordis`(4.0.1)、`schemastery`(3.18.1)无更新。

## 二、复查发现并修复的问题

| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | **HIGH** | `type()` 带 target 时把文本丢弃(只发空 insertText)——上次审查已点名,本轮确认仍存在 | `'text' in request ? request.text : ''`,保留文本并记录进 history |
| 2 | MEDIUM | `key()` Space 缺 CDP `text` 字段,输入框收不到空格字符 | KEY_SPECS.Space 增加 `text: ' '`,keyDown 参数透传 |
| 3 | MEDIUM | `key()` keyUp 失败无释放恢复(键可能卡住按下) | 仿 click 的 release 恢复:press/release 分离,失败重试 release |
| 4 | MEDIUM | `waitFor` URL 前缀匹配跨域误匹配(https://a.com 匹配 https://a.com.evil.com) | 仅同 origin 内允许前缀匹配,否则要求精确相等 |
| 5 | LOW | hello 竞态:子进程在 stdin token 到达前连接会发空 token(被父进程当伪造连接) | 连接回调等待 stdin 首行/超时兜底后再发 hello;顺带修复 stdin readline 变量名与 socket readline 遮蔽问题 |
| 6 | LOW | `snapshotMaxElements`/`contentMaxChars` 配置未接线(provider 接受但入口不暴露) | entry.ts Config 增加两个字段并透传 |
| 7 | LOW | index.ts 缺第三轮新类型导出(a11y/scrape/target/form ops 等) | 全部补上 |
| 8 | LOW | 下载 `.part` 临时文件 rename 失败时残留 | catch 中 unlinkSync 清理后重抛 |

## 三、验证

- `tsc --noEmit` 零错误;构建通过。
- `node --test tests/*.test.mjs` **20 项**全部通过(新增 3 项回归:type-with-target 不丢文本、Space 带 text、waitFor 同源判定)。
- 版本号未 bump。四轮合计 4 个提交未推送。

---

# 第五轮:修复 electron 44 懒下载导致插件不可用 + 构建回归

## 一、症状与根因

- 症状:安装后用 pnpm 装依赖,插件报不可用/浏览器起不来。
- 根因一:electron 44+ **不再有 postinstall**,改为**首次 `require('electron')` 时懒下载**二进制。pnpm 安装后 `node_modules/electron/` 里没有 `dist/` 与 `path.txt`(二进制缺失)。插件的 `available()` 探测走 `require('electron')`,会在 DSH 启动/provider 选择时**同步阻塞下载**(或离线失败),表现为插件不可用。
- 根因二:装上 electron 44 后其自带类型把 `Cookie.domain` 标为可选,`flushAuth` 里两处裸用 `c.domain` 触发 TS18048,`tsc` 构建必挂(HIGH 3 的修复当时只覆盖了导出对象一处)。

## 二、修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | `available()` 探测触发 electron 懒下载,阻塞/失败 | `resolveElectronPath()` 改为无副作用探测:先检查 `path.txt`/`dist` 是否已下载,已下载才 `require('electron')`;未下载走 ELECTRON_PATH/锚点/自身安装树扫描,全部缺失时抛错(不触发网络下载) |
| 2 | 二进制缺失时错误信息没给指引 | 错误信息补充:Electron 44+ 首次使用自动下载(需网络),可先跑 `npx install-electron` 或设 `ELECTRON_PATH` |
| 3 | `flushAuth` 的 `c.domain` 两处裸用导致构建失败 | `const domain = c.domain ?? ''`,host/hostPart/导出均基于它 |
| 4 | 首次使用无感知 | 懒下载仍保留在真正 spawn 时触发(electron 44 官方机制);首次运行需网络 |

## 三、补充修复:Windows 握手回归(RPC token 收不到)

- 症状:真机端到端验证时子进程日志 `warning: no token received on stdin`,hello 带空 token,认证失败,插件完全不可用。
- 根因:Windows 上 **Electron 是 GUI 子系统进程,收不到 piped stdin**。第一轮把 token 从 argv 改为 stdin 传递(安全修复)在 Windows 上直接断了握手——旧版(argv)能跑,新版(stdin)跑不了。
- 修复:token 双通道传递 —— spawn 时同时写入 stdin **和** `DSH_BROWSER_RPC_TOKEN` 环境变量;子进程 **stdin 优先、env 兜底**(Windows GUI 收不到 stdin 时用 env;env 比 argv 隐蔽,默认进程列表工具不可见)。

## 四、验证

- `tsc --noEmit` 零错误;构建通过。
- `node --test tests/*.test.mjs` 20 项全部通过。
- `RemoteElectronViewHost.available()` 实测 **6ms** 返回(纯文件系统探测,不再触发下载);electron 44 二进制下载后正常定位。
- **真实端到端验证通过**(真机 Windows):spawn electron → stdin/env token 握手 → `navigate` → `snapshot` → `listTabs` → `close` 全链路 E2E PASS。
- 版本号未 bump。五轮合计 5 个提交未推送。

---

# 第六轮:修复自托管模式下 switch_tab/close_tab 按 id 操作失败

## 一、症状

自托管(plain dsh web)模式下:`browser_switch_tab` 对任何 tab id 都报 `tab "<id>" is not open in this session`;`browser_close_tab` 返回 `closed: true` 但标签没关。其余工具全部正常。

## 二、根因

- **closeTab 静默假成功**:tab 找不到时 `index < 0` 直接 resolve(幂等设计),返回 `closed: true` 掩盖了真实错误——这就是"返回 Closed. 但没关闭"。
- **按 id 查找被限定在"调用方 session"内**:工具层 `ensureSession` 解析出的 session 与实际持有该 tab 的 session 可能错位(宿主工具执行上下文差异),导致 findIndex 找不到。tab id 是全局唯一的 UUID,但查找范围错了。

## 三、修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | closeTab 静默假成功 | 找不到时改为抛出 `BROWSER_TAB_UNKNOWN`(与 switchTab 一致),不再返回假成功 |
| 2 | 按 id 查找限定调用方 session | 新增 `locateTab()`:优先调用方 session,找不到则**跨全部 session 按 id 兜底**(tab id 全局唯一,不会误命中其他任务);真的不存在才抛错。**该兜底后来被移除**:跨会话命中意味着陈旧 id 能关掉别的任务(或人)的标签页还报成功,与工具承诺的隔离矛盾 —— 现在只查调用方会话,仅保留"裸 uuid 与 `tab:<uuid>` 两种写法都接受" |
| 3 | 错误无诊断信息 | `BROWSER_TAB_UNKNOWN` 信息附带调用方 session 的现有 tab id 列表,便于线上定位 |

## 四、验证

- `tsc --noEmit` 零错误;构建通过。
- `node --test tests/*.test.mjs` **21 项**全部通过(新增:跨 session 切换/关闭兜底、未知 id 抛错回归测试)。
- 版本号未 bump。六轮合计 6 个提交未推送。

---

## 第七轮:内置浏览器工具栏交互修复(焦点路由)

- **日期**:2026-08-26
- **状态**:修复已完成并通过验证,已作为单独提交保存在本地 git,**未推送**。

### 问题

"让内置浏览器同时可以作为真正浏览器使用"(地址栏导航、工具栏按钮、标签条)在 Windows 上交互不可用:点击按钮无反应、地址栏无法输入。经真机探针(真实系统鼠标/键盘事件)定位:

1. **`before-input-event` 只触发键盘事件**——此前用它检测鼠标点击是探针误判;修正后用 `input-event` + DOM title 变化实测:**真实鼠标点击能到达工具栏 view**,DOM 处理器与 IPC 链路本身正常。
2. **真正的问题在键盘焦点路由**:Windows 上键盘输入只派发给**有焦点的 webContents**,而窗口重新获得焦点(alt-tab、点击)时 Electron **不会自动恢复任何 view 的焦点**(electron#28163)——最后一个 `addChildView` 的 view 抢占焦点。插件里页面 view 抢走焦点后,点击地址栏无法聚焦,键盘输入全部进页面,表现为"UI 不能正常使用"。

### 修复(host-main.ts)

| # | 问题 | 修复 |
|---|---|---|
| 1 | 键盘输入只进有焦点的 view,页面 view 抢占焦点 | 新增 `wireFocusRouting()`:任何 view 收到 `input-event` mouseDown 即 `webContents.focus()`——**点击地址栏 → 焦点切到工具栏 → 可输入网址;点击页面 → 焦点切回页面** |
| 2 | 窗口重新聚焦时不恢复 view 焦点 | `win.on('focus')` 恢复**上次点击的 view**(`lastFocusedViewId`,工具栏用哨兵 key),回退到可见页面 view |
| 3 | 工具栏 view 不在 `win.views` 里 | 定义 `TOOLBAR_FOCUS` 哨兵区分工具栏/页面焦点目标 |

### 验证

- 真机探针(hit2/hit3):真实 OS 点击到达工具栏 view(`input-event mouseDown`)、DOM mousedown 触发;焦点路由生效(点击工具栏 → `toolbar.isFocused()=true`,点击页面 → `page.isFocused()=true`)。
- `tsc --noEmit` 零错误;`node --test tests/*.test.mjs` **21 项**全部通过。
- 版本号未 bump。七轮合计 7 个提交未推送。

---

## 0.1.16 发布(2026-08-26)

bump `0.1.15 → 0.1.16`,将第一至第七轮全部修复随版本发布(本地 11 个提交,origin/master 自 `9ffe5d6` 起):

- **第一轮**:安全与健壮性修复(详见上文)
- **第二轮**:功能补全 + 测试 + CI(详见上文)
- **第三轮**:对标 browser-bridge 的功能 + 审查修复(详见上文)
- **第四轮**:DSH 0.1.1-rc.2 对齐 + 复查修复(详见上文)
- **第五轮**:`available()` 无副作用探测(electron 44 懒下载)+ flushAuth 构建修复
- **第六轮**:Windows RPC 握手 token env 兜底;switch/close_tab 定位(当时的跨 session 兜底后续已收紧为只查本会话)+ closeTab 不再假成功
- **第七轮**:工具栏焦点路由——点击聚焦目标 view,地址栏可输入,窗口 refocus 恢复上次 view

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` 21 项全部通过。tag `v0.1.16`。

---

# 第八轮:DSH Desktop 宿主 Electron 复用(2026-08-27)

## 症状与根因

- **症状**:在 DSH Desktop(基于 Electron 43 宿主,`desktop` profile)装好插件后,调用 `browser_*` 工具直接报 `cannot locate the Electron binary`。安装插件不带来 electron(optional peer,`dependencies` 为空),`ELECTRON_PATH` 未设置,desktop / web / profiles 的 `node_modules` 均无 electron 包——共享浏览器窗口永远起不来。
- **根因**:插件自托管模式需要可启动的 Electron 二进制,而 `resolveElectronPath()` 只查 peer 依赖 / `ELECTRON_PATH` / DSH 锚点与 pnpm store。DSH Desktop 宿主本身基于 Electron 运行,宿主二进制就在本机,却从未被利用;报错示例 `--profile web` 对 DSH Desktop 用户还有误导。

## 修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | 插件运行在 Electron 进程内(DSH Desktop 主进程)时仍去找 peer 依赖 | `resolveElectronPath()` 第一步:检测 `process.versions.electron`,是则直接复用 `process.execPath` 宿主二进制——零额外安装,且不可能缺失(我们正运行在它上面) |
| 2 | DSH Desktop 把插件跑在 Electron 主进程的**子 Node 进程**时,第 1 步不生效,依旧找不到二进制 | 新增进程祖先树回退(最后手段):向上扫描父进程可执行文件,命中 Electron 二进制(名字含 `electron`,或旁有 `resources/electron.asar`/`app.asar`/`default_app.asar`)即复用;POSIX 走 `/proc`,Windows 走 PowerShell CIM,仅在其它路径全部落空时才执行,不影响正常路径 |
| 3 | 报错示例 `--profile web` 对 DSH Desktop 用户有误导 | 报错改为按当前 profile 动态提示(`<your-profile>`,并注明 DSH Desktop 的 profile 是 `desktop`) |
| 4 | 文档未说明"何时需要 electron" | 环境要求 / FAQ / 架构 / README 同步:DSH Desktop 零安装;纯 `dsh web` 自托管才需要 `dsh plugin --profile <profile> add electron` 或 `ELECTRON_PATH`(44+ 懒下载可先 `npx install-electron`) |
| 5 | CI 类型检查失败(electron 是 optional peer,CI 无该包,走 shim 类型;第七轮焦点路由新增的 API 未入 shim) | `electron-shim.d.ts` 补齐:`WebContents.focus()`、`WebContents.on('input-event')`、`BrowserWindow.on('focus')`——无 electron 包环境 `tsc` 同样零错误 |

## 验证

- `tsc --noEmit` 零错误(无 electron 包环境即 CI 环境同样零错误);构建通过。
- `node --test tests/*.test.mjs` 21 项全部通过。

---

## 0.1.17 发布(2026-08-27)

bump `0.1.16 → 0.1.17`,将第八轮 DSH Desktop 宿主 Electron 复用修复随版本发布:

- **第八轮**:插件运行在 Electron 进程内直接复用宿主二进制;插件跑在宿主子 Node 进程时沿进程祖先树找到宿主 Electron 兜底(Windows 用 PowerShell CIM,仅最后手段)——DSH Desktop **零安装开箱可用**;报错按当前 profile 动态提示;补齐 electron shim(`WebContents.focus()` / `on('input-event')` / `BrowserWindow.on('focus')`)修复无 electron 包环境(CI)的类型检查;文档与 CHANGELOG 同步。

**验证**:`tsc` 构建零错误(有无 electron 包两种环境);`node --test tests/*.test.mjs` 21 项全部通过。

---

# 第九轮:electron 改为必装依赖(2026-08-27)

## 动机

issue #4 报告者的核心诉求是「装完插件即可用」:此前 electron 是 optional peer,安装插件不会自动带来 electron 包,DSH Desktop 之外(纯 `dsh web` 自托管)的用户仍需手动 `add electron`。本轮按报告者建议 ① 的 A 分支,把 electron 从 optional peer 改为**真实依赖**。

## 改动

| # | 改动 | 说明 |
|---|---|---|
| 1 | `package.json`:`electron` 从 `peerDependencies`(+ `peerDependenciesMeta.optional`)移入 `dependencies`(`>= 30.0.0`),删除 `peerDependenciesMeta` | 安装插件即自动带上 electron 包;electron 44+ 无 postinstall,二进制首次使用懒下载,安装不增重 |
| 2 | `remote-host.ts` 注释与报错措辞同步 | 定位顺序 ③ 改为「随插件安装的 electron 包」;报错区分新旧安装(新装自带 electron,旧装仍可 `dsh plugin --profile <profile> add electron`) |
| 3 | `electron-shim.d.ts` 注释同步 | electron 现在是运行时依赖,shim 仍保留(供独立 typecheck src/ 时自洽) |
| 4 | 文档同步(README 中英、user-guide、architecture、CHANGELOG) | 「环境要求」改为必装依赖;定位顺序、FAQ、已知限制同步 |

## 说明

- **DSH Desktop 行为不变**:依旧优先复用宿主二进制(步骤 0/②),随包安装的 electron 仅作后备——安装体积变重是换取「装完即可用」的代价,符合报告者建议。
- **CI 影响**:electron 成为 dependencies 后,CI 的 `npm install` 会装上 electron 包(44+ 无 postinstall,不下载二进制),`tsc` 将使用真实 electron 类型(shim 同步保留,双环境仍零错误)。

## 验证

- `tsc --noEmit` 零错误(有/无 electron 包两种环境);构建通过。
- `node --test tests/*.test.mjs` 21 项全部通过。

---

## 0.1.18 发布(2026-08-27)

bump `0.1.17 → 0.1.18`,将第九轮「electron 改为必装依赖」随版本发布:

- **第九轮**:electron 从 optional peer 移入 `dependencies`,安装插件即自动带上 electron 包——纯 `dsh web` 自托管开箱可用,不再需要手动 `add electron`;DSH Desktop 依旧优先复用宿主二进制;文档、报错与 shim 注释同步。

**验证**:`tsc` 构建零错误(有/无 electron 包两种环境);`node --test tests/*.test.mjs` 21 项全部通过。

---

# 第十轮:DSH-Store 兼容性声明(2026-08-27)

## 背景

DSH STORE 自动化(AI-Scarlett/DSH-Store #243)固定 Commit 检查发现:`dsh-builtin-browser` 对官方最新 3 个 DSH 版本(`0.1.0-rc.8` / `0.1.1-rc.1` / `0.1.1-rc.2`)没有任何 compatible 的 `dshReleases` 记录 → 触发 `DSH_LATEST_THREE_COMPATIBILITY_HOLD`,插件被临时下架。仅写宽泛范围不算安装证据,必须逐版本声明。

## 改动

`package.json` 新增 `dsh.compatibility`(参照已收录插件 `dsh-vision` 的 schema):

- `dsh`: `>=0.1.1-rc.1 <0.2.0`(覆盖两条 compatible 声明);
- `profiles`: `["web", "desktop"]`;
- `dshReleases`:
  - `0.1.1-rc.2`: `compatible`(peer 对齐 `^0.1.1-rc.2`、CI 全绿、真实 DSH E2E 验证);
  - `0.1.1-rc.1`: `compatible`(真实 DSH `0.1.1-rc.1` profile-boot E2E 实测通过:open→navigate→snapshot 全链路);
  - `0.1.0-rc.8`: `unknown`(未实测,不宣称兼容)。

目的:恢复 DSH STORE 收录。推送后自动化每 8 小时复检,确定性 blocker 清除后自动更新/关闭 issue #243。

## 验证

- `tsc` 构建零错误;`node --test tests/*.test.mjs` 21 项全部通过。

---

## 0.1.19 发布(2026-08-27)

bump `0.1.18 → 0.1.19`,将第十轮「DSH-Store 兼容性声明」随版本发布(tag `v0.1.19`)。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` 21 项全部通过。

---

# 第十一轮:自托管浏览器宿主崩溃后的会话自愈(2026-08-27)

## 背景

issue #5 报告:自托管模式下 DSH 重启 / 会话 checkpoint 恢复后,`browser_*` 工具间歇性报 `dsh-builtin-browser: browser host is not running`,且恢复不自动。典型半死态:`browser_session` / `browser_list_tabs` 能返回会话与标签,但 `browser_content` 超时或 `browser_open` 直接拒绝;手动 `browser_reset_session` 或再 `browser_open` 一次才恢复。

## 根因

`DeferredRemoteView.materializeOnce()` 把物化后的 `RemoteView` **永久缓存**,而 `RemoteView` 硬引用创建它的 `ElectronChildClient`。浏览器子进程一死(DSH 重启 → 父进程 socket 关闭 → 子进程 `app.exit(0)`;或崩溃),`onChildExit` 虽然重置了宿主(下次可起新子进程),但**已物化的视图句柄仍指向死掉的 client** → 之后每次调用都命中 `call()` 的 `dead` 检查,永远报 "browser host is not running"。会话元数据(session id / tab)仍在 → 半死态;只有新建会话(新视图句柄)才会重新物化 → 手动 reset/open 后"恢复"。

## 改动

| # | 改动 | 说明 |
|---|---|---|
| 1 | `remote-host.ts` 新增 `HostGoneError` 标记错误 | `fail()` 与 `call()` 的 dead 检查、`ensureView` 的 host 缺失全部标记为 host-gone,与页面级错误区分 |
| 2 | `DeferredRemoteView` 新增 `withRecovery`:宿主已死时丢弃物化缓存 → 对新子进程重建视图 → **重试该操作恰好一次** | 存活会话在宿主死亡后的**第一次调用**即自动拉起新宿主并重试,不再永久报 "browser host is not running";页面级错误不触发重建 |
| 3 | `ElectronChildClient` 支持注入 spawn 可执行文件(测试缝) | 默认行为不变(`resolveElectronPath()`);供无 Electron 环境的集成测试使用 |
| 4 | 子进程意外退出时父侧输出一条日志 | 可观测性:宿主"已死 / 将重启"一目了然 |
| 5 | 新增 `tests/remote-host-recovery.test.mjs` + `tests/fixtures/fake-host-child.mjs` | 用纯 Node 的假子进程(与 host-main.js 同协议)实测:同一视图句柄在子进程崩溃后自动重启并重试成功——旧代码下该句柄会永久失败 |
| 6 | 文档同步(README 中英、user-guide、architecture) | 「崩溃后旧会话失效需 reset 重建」改为「崩溃后会话自动重建,仅页面状态丢失」 |

## 说明

- **未采用**把浏览器子进程改成 DSH 服务受管子进程(生命周期随 DSH 启停)——那是 DSH 宿主层的架构职责,不在插件能力内;插件的等价保障是:父进程断开时子进程自动退出(已有,不留孤儿),宿主死后会话在下次调用自动重建。
- **未加心跳/看门狗**:子进程事件循环被卡死(RPC 无响应)与"进程已死"是两种情形;本次修复覆盖"进程已死"这一明确缺陷。卡死场景由 provider 的 withTimeout + terminateExecution 打断兜底。

## 验证

- `tsc --noEmit` 零错误(有/无 electron 包两种环境);
- `node --test tests/*.test.mjs` **22 项全部通过**(新增 1 项回归测试);
- 回归测试实测日志链路:`__die` → ECONNRESET → "browser host gone; will restart on next use" → 重新拉起 → 重试成功。

**状态**:已提交本地,未 bump 版本、未发布(发布时 bump)。

---

# 第十二轮:resolveElectronPath 排除打包应用(2026-08-27)

## 背景

issue #6 报告:0.1.19 在 DSH Desktop(打包的 Electron 应用)上 `browser_*` 报 `browser host exited (code=0)`。`resolveElectronPath()` 能找到"某个 electron",但选中的是**打包的宿主应用 exe**——spawn 它不会按脚本参数拉起,而是启动第二个 DSH Desktop 实例 → 命中单实例锁 → 秒退 code=0,报错完全不指向根因。

## 根因(三层,报告者已定位)

1. **layer 0 抢跑**:插件运行在 DSH Desktop 主进程内,`process.versions.electron` 已设置 → 直接返回 `process.execPath` = 打包的 DSH Desktop.exe;
2. **layer 1 在 Electron 主进程内失效**:`require('electron')` 解析为内置 API 模块(非 npm 包路径),bundled 探测永不命中;
3. **layer 4 同样选错**:`isElectronBinary()` 把 `resources/app.asar` 存在即判定为 electron → 祖先树里的 DSH Desktop.exe 被当作可复用二进制。

## 改动

| # | 改动 | 说明 |
|---|---|---|
| 1 | 新增 `isBareElectron()`:旁有 `resources/app.asar` 即**打包应用**,不可按脚本参数拉起,一律排除 | 裸 electron(dev 模式 `electron.exe`、`resources/electron.asar`/`default_app.asar` 而无 `app.asar`)才可 spawn |
| 2 | layer 3(当前进程复用)与 layer 4(祖先树)都改为**仅裸 Electron** | DSH Desktop.exe 被正确跳过,不再秒退 |
| 3 | layer 0 改为**bundled 纯文件系统探测**(`bundledElectronBinary()`),置于最优先 | 不依赖 `require` 语义(主进程内解析为内置模块)、不触发 electron 44+ 懒下载(probe 保持无副作用);覆盖普通 node_modules 布局 + pnpm store(`node_modules/.pnpm` 与 `.pnpm` 两种路径) |
| 4 | 定位顺序重排:bundled → `ELECTRON_PATH` → 锚点最新者 → 当前进程裸宿主 → 祖先树裸宿主 | 打包 DSH Desktop 的正确路径是随插件安装的 electron 44 二进制;dist 缺失时给出明确报错(提示 `npx install-electron` / `ELECTRON_PATH`),不再 silent 秒退 |
| 5 | 新增 `internals` 测试钩子(镜像 tool-browser 惯例)+ `tests/electron-resolution.test.mjs` | 打包应用(含名为 electron.exe 但带 app.asar 者)一律 false;裸 electron 为 true |
| 6 | 文档同步(README 中英、user-guide、architecture) | 定位顺序更新 + 「打包应用不参与复用」说明 |

## 说明

- **DSH Desktop 行为变化**:不再复用宿主打包 exe(那是 #4 修复在打包宿主上的漏洞);0.1.18+ 插件自带 electron 包,优先用它的 dist 二进制——首次使用需触发 44+ 懒下载(`npx install-electron` 或首次 require),报错已给出指引。
- **dev 宿主不受影响**:裸 electron 的 dev 宿主(如 `electron .` 的开发环境)仍走 layer 3/4 复用宿主二进制,零安装。

## 验证

- `tsc --noEmit` 零错误(有/无 electron 包两种环境);
- `node --test tests/*.test.mjs` **23 项全部通过**(新增 1 项打包判定回归测试);
- 本机实测:`resolveElectronPath()` 返回 `node_modules/electron/dist/electron.exe`(bundled 优先,非 `process.execPath`);`isBareElectron(node.exe)` = false。

**状态**:已提交本地,未 bump 版本、未发布(发布时 bump)。

---

## 第二次全面复审加固(2026-08-27)

对第十一、十二轮改动换角度重审(并发时序 / 跨平台 / 子进程侧),发现并修复第一轮审查漏掉的问题:

| # | 问题 | 修复 |
|---|---|---|
| 1 | **并发恢复双重建竞态**:child 死时同一句柄上有两个并发 op,两个 catch 各自重建 → 对新 child 发两次 `createView(同 id)` → host-main 覆盖 map 并再挂一个 WebContentsView → 第一个视图泄漏(堆叠、不可销毁) | host-main 的 `createView` 幂等化:同 id 已存在直接回 ok,双重建收敛到同一视图 |
| 2 | **isBareElectron 在 macOS 上失效**:resources 目录检查用 `dirname(exe)/resources`,而 macOS bundle 的资源在 `Contents/Resources` → macOS dev 宿主被误判为非裸 electron,宿主复用失效 | darwin 检查 `Contents/Resources`;打包判定扩展到解包 `app` 目录;「无 resources 目录」排除 portable(全平台一致,测试平台无关) |
| 3 | **anchors 探测在 Electron 主进程内可返回内置名** `require.resolve('electron')` → `'electron'`(非路径),`electronExeBeside` 退化为检查 CWD 相对路径 | 加 `isAbsolute` 守卫,非绝对路径一律跳过 |
| 4 | **dispose 期间 in-flight 重建可 spawn 僵尸 child** | `ensureView` 加 disposed 守卫,disposed 后直接抛 host-gone |
| 5 | 新增测试:解包 `app` 目录的打包应用判定;既有打包/裸/portable 断言保持全平台一致 | |

**验证**:`node --test tests/*.test.mjs` **24 项全部通过**;lib(src+host-main)重建同步;本机实测解析行为不变(bundled 优先、node.exe 非 bare)。

**状态**:已提交本地,未 bump 版本、未发布(发布时 bump)。

---

# 项目整体交叉复审(2026-08-27)

超出两份 issue 的范围,对整个项目做系统性重审:provider.ts 全部 2167 行、tool-browser 工具层(会话/白名单/参数)、browser seam(runtime.ts + types.ts)、provider↔host-main 协议逐字段比对、错误流。结论:协议两端 10 个 op 的消息形状完全匹配(含 hello 认证与 userAction 单行通知),tool 层的会话去重(pendingOpens)与 agent 绑定生命周期正确,seam 的 provider 选择语义与 close() 的容错吞没符合契约。

## 发现并修复

| # | 问题 | 修复 |
|---|---|---|
| 1 | **dispose() vs start() 僵尸 child 竞态**(第二次复审的 disposed 守卫只挡住了 ensureView 入口):恢复路径会在 dispose 清空状态后重新进入 `ready()` → `start()` 从 listen 挂起点恢复,新建 server 并 **spawn 出一个没人会 kill 的 electron child**(`onChildExit` 在 disposed 时提前返回,`dispose()` 又已跑完) | `ready()` 入口 disposed 快速失败;`start()` 在 spawn 完成后复检 disposed 并完整自清理(kill child + close server);`ensureView` 在 `ready()` 之后复检 disposed |
| 2 | **pendingSocket 泄漏**:三处(onChildExit / ready 失败清理 / dispose)都只把 `pendingSocket` 置 undefined,不 destroy | 统一改为 `destroy()` 后再置空 |
| 3 | 新增回归测试:dispose 后的宿主拒绝操作且不再 spawn(旧守卫下第一次调用会真实拉起 child 并留下僵尸窗口) | `tests/remote-host-recovery.test.mjs` 新增 dispose 快速失败用例 |

## 确认无问题(交叉审查覆盖面)

- **协议比对**:客户端 `command/capture/download/flushAuth/restoreAuth/userActionError/groupView/showView/destroyView/createView` 与 host-main 各 case 的字段读取逐一匹配;hello 认证前命令排队、乱序 hello 拒绝、2 秒 token 等待兜底均正确;
- **生命周期**:`ready()` 失败自清理(promise 身份校验防误杀新启动)、`onChildExit` 保留 views map(配合 #5 自愈)、`kill()` 幂等;
- **withRecovery 并发**:双 catch 交错最多产生两次 createView(子进程幂等收敛),重试有界;
- **tool 层**:每 context 状态隔离、`assertAllowed` 白名单、`browser_restrict` 自身始终放行、history 脱敏;
- **seam**:选择语义无注册顺序依赖,`close()` 对四类 provider 缺失错误吞没为 no-op。

**验证**:`node --test tests/*.test.mjs` **25 项全部通过**;`tsc --noEmit` 有/无 electron 包两种环境零错误;lib 重建同步。

**状态**:已提交本地,未 bump 版本、未发布(发布时 bump)。

---

## 0.1.20 发布(2026-08-28)

bump `0.1.19 → 0.1.20`,将第十一轮(issue #5 会话自愈)、第十二轮(issue #6 打包应用排除)与三轮审查加固随版本发布(tag `v0.1.20`)。README 中英同步:更新记录新增三行、Electron 定位顺序与环境要求与修复后的代码对齐(打包宿主不复用、bundled 优先、ELECTRON_PATH 最优先)、验证版本表 bump 0.1.20。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **25 项全部通过**。

---

## 第十三轮(2026-08-28,issue #7 macOS 输入框无法键入)

**根因**:0.1.16 引入的 `4a13e20 fix(host): route keyboard focus to the clicked view on Windows` 把 Windows 专属 workaround(`wireFocusRouting` mousedown 焦点引导 + 窗口 `focus` 时恢复上次视图焦点,针对 electron#28163)无平台判断地应用到所有平台。macOS/Linux 原生会把键盘输入路由到被点击的视图,在 mousedown 的 `input-event` 里强制 `webContents.focus()` 反而与原生 click-to-focus 打架,页面输入框收不到键入字符。0.1.15(无此代码)正常、0.1.16+ 异常,与报告者降级 0.1.15 即恢复完全吻合。

**修复**:两处 Windows 专属焦点逻辑加 `process.platform === 'win32'` 门——非 Windows 平台恢复 0.1.15 的原生行为,Windows 保留 workaround(修复 #6 期间引入的工具栏/页面点击聚焦行为不变)。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **25 项全部通过**;lib 重建同步。

**状态**:已改未提交,未 bump 版本、未发布(发布时 bump)。

---

## 第十四轮(2026-08-28,issue #8 window.open/target=_blank 覆盖当前视图致 403)

**根因**:`setWindowOpenHandler` 把所有 HTTP(S) 弹窗直接 `loadURL` 到当前视图并 deny——原页面被覆盖、opener 上下文丢失,依赖新窗口携带 token/referer 的页面(门户「工作台」类跳转)被后端判无权限返回 403。报告者定位准确。

**修复**(采纳报告者方案 + 一个防御分支):HTTP(S) 弹窗改为 `sendUserAction({ type: 'newTab', windowId, url })`——父进程 provider 的 newTab 动作在同一会话窗口建新标签、导航并计入会话历史,原页面与 opener 上下文保留;新标签成为活动标签,agent 的 snapshot 自然跟随。未分组的共享窗口视图(无会话归属,防御路径)保留旧的 loadURL 行为避免退化。非 HTTP(S) 弹窗(OAuth/mailto/自定义协议)仍放行系统处理。附带修正:旧 loadURL 路径绕过父进程历史记录,新路径走 `openUrl` 正常记账。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **25 项全部通过**(父侧 newTab user-action 已有回归覆盖);lib 重建同步;README 中英弹窗行为描述同步。

**状态**:已改未提交(#7 + #8 两轮),未 bump 版本、未发布(发布时 bump)。

---

## 0.1.21 发布(2026-09-02)

bump `0.1.20 → 0.1.21`,将第十三轮(issue #7 macOS/Linux 输入框无法键入)与第十四轮(issue #8 window.open/target=_blank 覆盖当前视图)随版本发布(tag `v0.1.21`)。README 中英同步:更新记录新增三行、验证版本表 bump 0.1.21、弹窗行为描述与修复后的代码对齐。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **25 项全部通过**。

---

## macOS 二进制探测修复(2026-09-09,issue #9 / #14)

**根因**:`electronDistExe()` 只探测 `dist/electron(.exe)`,而 macOS 的 Electron 二进制在 bundle 内部(`dist/Electron.app/Contents/MacOS/Electron`)。bundled 与 profile/anchor 两条解析层共用这个探测函数,于是 macOS 上永远定位不到二进制,任何 `browser_*` 调用都以 "no usable browser provider is registered"(或 "cannot locate the Electron binary")失败。

**修复**:在共用的平台探测里补上 darwin 候选路径,两层同时受益;新增覆盖该路径的回归测试。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **26/26 全部通过**(含新增的 macOS 布局用例);lib 重建同步。

**状态**:已提交并推送(`8bef6f8`,upstream master),**尚未随版本发布**(npm 最新仍为 0.1.21)——macOS 用户需等下一次发版,或从 git 安装。

---

## 第十五轮(2026-09-16,issue #11 工具栏脚本解析期 SyntaxError 导致整个工具栏失效)

**根因**:`host-main.ts` 的工具栏内联脚本用 `const bridge = window.bridge` 取 preload 通过 `contextBridge.exposeInMainWorld('bridge', …)` 装上的句柄。`exposeInMainWorld` 装的是**不可配置**的全局属性,而全局作用域再声明同名 `const`(或 `let`/`class`)会命中规范里的 `HasRestrictedGlobalProperty` —— 这是**解析期 early error**,整段 `<script>` 一行都不执行:`tb`/地址栏/回退前进刷新/新标签/标签条/错误条全部失效(报告者的根因分析完全正确)。

**修复**:两件一起做,而不只改名 ——

1. 整段脚本包进 IIFE,所有绑定落进函数作用域:这一类与 `exposeInMainWorld` 全局的冲突从结构上不可能再出现(以后新增 expose 也不会重演);
2. 局部名改为 `tb`,断掉"照抄 `const bridge`"的习惯(报告者建议);
3. 注释写明为什么不能改回顶层 `const`,并注明该段位于 TS 模板字符串内(反引号会触发 TS1005)。

**验证**:新增 `tests/toolbar.test.mjs`(3 用例)—— 从**随包发布的** `lib/browser-electron/host-main.js` 里按 JS 语义解析出 `TOOLBAR_HTML` / `TOOLBAR_PRELOAD`,再在 `vm` 里真执行:全局按 `contextBridge` 的方式装成 non-configurable,配一套 stub DOM。用例 1「脚本在 contextBridge 全局下解析并接线」、用例 2「显式复现 #11 故障模式」(对未修版本抛 `Identifier 'bridge' has already been declared`,与 CDP 抓到的一字不差)、用例 3「全局作用域零声明」是真守卫。顺带审计:全仓只有这一处内联 `<script>`,工具栏 HTML 无内联 `on*=` 与 `javascript:` URL,IIFE 包裹不破坏其它绑定。

---

## 第十六轮(2026-09-16,issue #10 自托管三连:空快照 / 点击静默失效 / 崩溃不自愈)

**缺陷 1 · `browser_open` 返回「有标题、0 个交互元素」的空快照**

- 根因:`Page.navigate` 在导航 commit 时就 resolve,而工具层紧接着取快照,此时新文档已 commit(`location.href`/`document.title` 已是新的)但 DOM 尚未解析 → 标题正确、元素为空。
- 修复:`navigate()` 先读导航前的文档指纹(`performance.timeOrigin`),导航后在有界 5s、best-effort 前提下等新文档 `readyState ∈ interactive/complete`。指纹用于区分「同 URL 重载」与「A→B→A 重定向」,不会把旧文档误判成新文档;commit 期间 `Execution context was destroyed` 继续轮询而非放弃;`reload()` 与 back/forward 同样处理。成本受控:文档看着已 settle 但指纹未变(同文档/锚点跳转)只等 150ms grace,不烧光预算。

**缺陷 2 · 点击静默失效(报成功但页面收不到任何事件)**

- 根因:`showViewInWindow()` 只对**已存在**的视图置可见,而宿主侧 `showActive` 是 fire-and-forget;新标签页里 `newTab()` 的 `showActive()` 与子进程 `createView` 竞争——`showView` 先到时 `windowOfView(viewId)` 查不到视图、静默跳过,视图随后才创建,于是从未被 present。没有显示表面的 `WebContentsView`,Chromium 会静默丢弃合成的 `Input.*` 事件(`Runtime.evaluate` 不受影响,所以快照/执行都正常,只有点击与输入无效),而工具层无从区分"成功"与"无效"。
- 修复:新增**等待式** host seam `presentView?(handle, label)`:先 materialize 视图,再 `showView`,最后发一个 ping 屏障;同时把子进程消息处理改为严格串行(原 `void handle(...)` 会让 op 互相超车)。`click()`/`type()`/`key()` 在派发任何 `Input.*` 前调用它,present 不了就报 `BROWSER_VIEW_NOT_PRESENTED` 并带原因,不再假报 "Clicked."。

**缺陷 3-A · userData 隔离被未闭合的文档注释吞掉**

- 根因:`host-main.ts` 的块注释缺少收尾 `*/`,`try { app.setPath('userData', …) }` 整段被注释吞掉,产出物里根本没有这段代码。
- 修复:闭合注释,`app.setPath('userData', join(base, 'dsh-builtin-browser-host'))` 已是真实代码(已在发布产物中核对)。

**缺陷 3-B · 新建视图无渲染进程时 CDP 永不 settle(「宿主重启后不自愈」卡死的那一步)**

- 根因:新建的空白视图还没有可响应的渲染进程,而宿主重启后的第一个动作就是读 `location.href` → 命令永不 settle,表现为一串 timeout。
- 修复:`createView` 在应答前先有界(3s)加载 `about:blank`,视图一存在就有可响应的渲染进程。

**补充修复**

- 导航后第一次输入被丢:`did-navigate` 给视图打 `needsRepresent` 标记,`showViewInWindow` 对带标记的视图强制走一次 hide/show + remove/add —— 原来「已经可见就跳过」的防闪烁快速路径,恰好把新渲染进程建立显示表面这一步跳掉了。
- 宿主侧 `command` 加 20s 有界超时:渲染进程卡死得到明确错误而不是挂死。
- 子进程 stderr + 退出码/信号落到 `$DSH_HOME/logs/dsh-builtin-browser-host.log`(2MB 自截断):纯 `dsh web` 自托管场景终于能自助排查宿主崩溃循环。
- `locateTab()` 同时接受裸 uuid 与 `tab:<uuid>`,消除自相矛盾的 "is not open in this session"(却把该 tab 列出来)。

**验证**:`tsc -p tsconfig.json` 零错误;由 `src/` 重新编译 `lib/` 与已提交产物**逐字节一致**(本仓库提交 lib 产物);`node --test tests/*.test.mjs` **31/31 全部通过**(未修版本 739ms → 修复后约 993ms,无明显变慢),其中新增 2 条针对缺陷 1/2 的回归测试对未修版本失败、对修复版本通过(真守卫);行为脚本模拟 commit→loading→interactive 时 navigate 轮询 3 次才返回(证明真的等了解析),同文档导航 152ms 返回(证明没卡满预算)。

**边界**:本环境起不了 Electron,未做真机点击冒烟;缺陷 3-A/3-B、导航后首次输入、`locateTab` 按代码 + 产物核对验证,缺陷 1/2 有真测试兜底。Windows 上手动确认一次工具栏与首击行为仍然值得。

**状态**:第十五、十六两轮随一次提交落库(源码 + lib 产物 + 测试);未 bump 版本、未发布(发布时 bump)。宿主侧改动需推送并重装依赖、重启浏览器宿主子进程后才在安装副本上生效。

---

## 第十七轮(2026-09-16,issue #13 截图 savePath 沙盒逃逸 + 下载目录本地化)

**根因**:`browser_screenshot` 的 `savePath` 直接 `writeFileSync`,不走任何准入 —— 可写到 DSH 进程有权限的任意路径(工作区之外、`$HOME`、`/.bashrc` 等),并会静默覆盖已存在文件(报告者实测把一个 13 字节文本文件覆盖成 17KB PNG)。而 `browser_download` 自第一轮就有准入(仅 HTTP(S)、绝对路径、`downloadDir` 限定),两条写盘路径的准入不对称,等于从截图侧绕过了只读沙箱的写保护。

**修复**:抽出唯一的准入门 `admitSavePath(savePath, kind)`,下载与截图共用同一套规则 ——

1. 必须为绝对路径;
2. 解析后必须位于 `downloadDir` 内(大小写不敏感比较,拒绝 `..` 逃逸);
3. 目标不得已存在:绝不静默替换现有文件(原有内容不可恢复,且该目录可能存放用户自己的文件),换一个文件名即可。

截图路径另外补上父目录自动创建(`mkdirSync(dirname(target), { recursive: true })`),与下载"自动建目录"的行为对齐。准入失败按操作分别报 `BROWSER_DOWNLOAD_BLOCKED` / `BROWSER_SCREENSHOT_BLOCKED`(既有错误码保持不变)。

**下载目录本地化**:默认下载目录不再写死 `~/Downloads`,改为按序探测 —— 配置的 `downloadDir` → 存在的 `XDG_DOWNLOAD_DIR`(freedesktop 标准,中文 Linux 桌面写的就是它)→ home 下第一个存在的 `Downloads`/`下载`/`下載` → 回退 `~/Downloads`(首次使用时创建)。中文桌面不再需要手动配置 `downloadDir`。

**文档同步**:`browser_screenshot`/`browser_download` 的 `savePath` 参数描述、README 中英、`docs/tool-reference.md`、`docs/user-guide.md` 均改为"限定在 `downloadDir` 内且不覆盖已有文件";`downloadDir` 配置行的默认值与适用范围(下载 + 截图)一并更新。

**验证**:`tsc` 构建零错误;新增 `tests/save-path-admission.test.mjs` 4 个用例 —— 截图越界/相对路径/`..` 逃逸被拒、截图正常写入且拒绝覆盖、下载同样拒绝覆盖、中文目录(显式配置与 `XDG_DOWNLOAD_DIR` 默认值)可用且仍受限;`node --test tests/*.test.mjs` **35/35 全部通过**(原 31 项保持通过;两条下载准入测试顺带改用临时目录,不再依赖 `~/Downloads`/`C:/dl` 的真实状态)。

**行为变更提示**:下载现在同样拒绝覆盖已存在文件(此前会覆盖)。这是与截图对齐同一准入门时的刻意选择;需要替换同名文件时换一个文件名。

**状态**:已改并随本次提交落库(源码 + lib 产物 + 测试 + 文档);未 bump 版本、未发布(发布时 bump)。

---

## 0.1.22 发布(2026-09-16)

bump `0.1.21 → 0.1.22`,把此前未发版的全部修复随一个版本交付:macOS 二进制探测(issue #9 / #14)、第十五轮(issue #11 工具栏解析期 SyntaxError)、第十六轮(issue #10 自托管三连)、第十七轮(issue #13 截图 savePath 逃逸 + 下载目录本地化)。tag `v0.1.22`。

README 中英同步:更新记录新增五行;`browser_download`/`browser_screenshot` 的 `savePath` 限制与 `downloadDir` 默认值(含本地化目录)说明对齐;崩溃自愈条目补上 `about:blank` 预加载、20s 命令超时与宿主日志路径。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **35/35 全部通过**;`lib/` 由 `src/` 重新编译后与提交产物逐字节一致。

---

## 第十八轮(2026-09-20,Windows 真机三连:页面被判定不可见 / 首击丢失 / 首键丢失 + 探测自愈 + 定位失败可读性)

本轮在真实 Windows 11 + Electron 44.0.0 自托管宿主(`dsh web` profile)上实测,缺陷 1–4 都是「CDP 报成功、页面什么都没收到」这一类:快照与脚本执行始终正常,只有输入无效,因此从工具输出完全看不出区别。缺陷 5 是修好之后照真实调用走一遍才撞出来的报错可读性问题。

**缺陷 1 · 页面被 Windows 判定为「不可见」,整站停帧且所有合成输入被丢**

- 根因:Chromium 在 Windows 上的 `CalculateNativeWinOcclusion` 特性会把被其他窗口遮挡的窗口置为 `Visibility::HIDDEN`。插件窗口长期排在人的窗口之后 → 页内 `visibilityState` 恒为 `"hidden"`、`requestAnimationFrame` 一帧都不发,而 `RenderWidgetHostImpl::CanReceiveInput()` 同时返回 false,于是每一条 `Input.dispatchMouseEvent` / `dispatchKeyEvent` 都被渲染端**静默丢弃**,CDP 依旧回 `{}`。
- 修复:子进程在 `app.whenReady()` 之前追加 `disable-features=CalculateNativeWinOcclusion`(仅 `win32`,其他平台行为不变)。验证:窗口仍排在后序时 `visibilityState` 回到 `"visible"`、帧持续产出。

**缺陷 2 · 新视图的第一次点击落空,第二次才生效**

- 根因:`click()` 只发 `mousePressed` + `mouseReleased`,没有前置 `mouseMoved`。Chromium 对合成按下事件是按 widget 当前 hover 目标路由的(未先移动就会路由到旧位置/无目标),首次点击被丢。
- 修复:改为 **move → press → release**(见 `provider.ts` 的 `send()` 辅助与 `CdpMouseParams`);新增回归测试断言派发序列严格为 `['mouseMoved','mousePressed','mouseReleased']`。
- 顺带实测点击投递延迟:6 次采样,`click()` resolve 后效果立即可见(往返 6–110ms),因此**不加** settle 或重试步骤。

**缺陷 3 · 键盘首键丢失(`browser_key` 第一次调用无效)**

- 根因:新建的视图从未持有 web focus,`Input.dispatchKeyEvent` 无处投递,而 CDP 仍回 `{}`。页内 `document.hasFocus()` 两种情况都读 `true`,不能当信号用。
- 修复:宿主新增 `focus` op(`webContents.focus()`,返回是否已聚焦),view handle 接口加可选 `focus?()`(DSH Desktop 宿主与既有测试替身不实现也照常编译),`provider.key()` 在派发前 best-effort 调用 `focusView()`。焦点落地是异步的:同一轮内紧随派发的键仍会被丢,所以**只在焦点确实需要移动时**等 `FOCUS_SETTLE_MS`(80ms)。窗口激活(`win.focus()`)试过,证明多余,已去掉以免抢前台。
- 实测(真实宿主,进程内第一个视图、且键盘是该视图收到的第一个输入):修复前 `[]`,修复后 `["keydown:Escape","keyup:Escape"]`;冷 Escape / 冷 Enter / 先执行脚本再按键等四种组合全部落屏。

**缺陷 4 · Electron 探测的「失败」被永久缓存,provider 再也无法自愈**

- 根因:`available()` 把失败结果按宿主生命周期缓存,而 provider 选择每进程只发生一次。Electron 到位晚于 DSH 启动(懒下载、pnpm 拦下 postinstall 等)时,此后每次 browser 调用都报 `no usable browser provider is registered`,只能重启 DSH。
- 修复:成功仍永久缓存;失败改为冷却窗口(默认 30s,可用 `DSH_BROWSER_PROBE_RETRY_MS` 调整)后重探,晚到的 Electron 自己就能被接上。`resolveProvider()` 的报错同时区分「一个 provider 都没注册」与「注册了但自报不可用」,后者附上可执行处置(`npx install-electron` / `ELECTRON_PATH`)。新增 `tests/electron-probe.test.mjs`:失败不重扫、窗口过后重探并成功、成功后不再扫(构造器第三参为探测 seam)。
- 实测:插件目录布局下探测返回 `available=true`(profile 内 `electron@44.0.0` 带 `dist/electron.exe`)。

**缺陷 5 · 定位失败被外层超时掩盖,报错说不出「查了什么」**

- 根因(两条凑在一起):`buildTargetScript` 生成的页内脚本会把预算**轮询到底**才回答,而 `runTargetScript` 的外层超时用的是**同一个**预算 —— 两边同一刻到期,外层那句 `browser: click timed out after 10000ms` 抢先返回,页内已经写好的判词(哪个选择器、哪种策略没找到)永远发不出来。另一条:css/xpath **解析失败**(选择器根本不合法)被写成 `return null`,也就是「还没找到」,于是对着一个永远不可能变合法的选择器把预算轮完。
- 修复:①解析失败即刻终止 —— 返回 `invalid CSS selector "…" (…)` / `invalid XPath …`,不再重试;②外层预算改为页内预算 + `TARGET_SCRIPT_GRACE_MS`(2s),让页内判词赶得上;③未命中判词补上提供方**实际采用的策略**(`by` 缺省即按 css,判词里就写 `"by":"css"`)与实际耗时;④`scrape` 的 item 选择器同样改成立刻失败并给同样的措辞。
- 实测(真实宿主 + 本地页):同一个漏写 `by` 的调用,修复前 `browser: click timed out after 10000ms`;修复后 `browser: click failed: element not found: {"value":"Learn more","by":"css"} (looked for 10000ms)`;`div[` 这类不可解析选择器 **2ms** 返回 `invalid CSS selector "div[" (… is not a valid selector.)`。
- 说明:**未**改成「页面加载完就只试一次」。合法选择器在 SPA 注水完成后才出现是常态,提前判死会伤掉真正的等待场景 —— 这里只把「说不清原因」修成「说清原因」,不缩短等待。
- 新增 3 条单测跑在**真正执行**页内脚本的小 DOM(`node:vm` + 会解析选择器的 `querySelectorAll`)上:解析错误只试一次且一个鼠标事件都不派发、xpath 解析错误单独命名且不回落到 css、合法但不存在的选择器确实逐轮轮询并给出带策略的判词。

**环境备注(未改代码)**:pnpm v10+ 默认不执行依赖 install 脚本,`electron` 的 postinstall(下载二进制)会被 `allowBuilds` 门拦下 —— 包在但 `dist/electron.exe` 不在,正是缺陷 4 的那类触发场景;`npx install-electron` 或放行构建即可。另外所有宿主实例共用一个 Chromium userData(`$DSH_HOME/dsh-builtin-browser-host`,代码注释本身也点了锁的问题),同时开多个宿主实例会在 profile/GPU cache 锁上互相争用,表现为偶发一次操作不生效、单独运行不复现;建议按宿主实例分目录,本轮未改。

**验证**:`tsc -p tsconfig.json` 零错误;`node --test tests/*.test.mjs` **47/47 全绿**(新增 7 条:3 条键盘聚焦(次序 / 宿主无 `focus` / 聚焦抛错也不影响按键)+ 1 条探测冷却窗口 + 3 条定位判词);真实宿主端到端脚本 **17/17**(新增一步:从未被点击过的页面收到第一个键);真实宿主定位判词脚本 **4/4**(合法但不存在 / 解析错误即刻终止 / 文本目标仍可点击 / 判词抢先于外层超时)。

**边界与状态**:未 bump 版本、未发布(发布时 bump)。缺陷 1 仅影响 Windows,缺陷 2/3/4 与平台无关,但 macOS / Linux 真机未复测。

---

## 第十九轮(2026-10-01,DSH 0.2.0-rc.2 兼容性)

**背景**:DSH 进入 0.2 线(`@deepseek-ai/dsh@0.2.0-rc.2`,peer 包 `dsh-llm` / `dsh-tools` / `dsh-system-prompt` 同步到 `0.2.0-rc.2`),而插件此前的兼容性声明是 `>=0.1.1-rc.1 <0.2.0` —— 声明层面把 0.2 挡在外面(DSH-Store 会据此判定不兼容)。

**核对与实测**:插件的运行时依赖面很窄 —— `@deepseek-ai/cordis`(`Context`/`Service`)、`@deepseek-ai/dsh-tools`(`defineTool`)、`@deepseek-ai/dsh-llm`(`HarnessError`)、`@deepseek-ai/schemastery`。在**真实 0.2.0-rc.2 宿主**上跑通了完整链路:`browser_session` 返回会话与标签;`browser_open https://example.com` 导航成功并返回快照元素;`browser_screenshot` 三态验证 —— 越界路径被 `must be inside downloadDir "C:\Users\<user>\Downloads"` 拒绝、合法路径写入成功、同名文件被 `refusing to overwrite existing file` 拒绝。结论:核心 API 未发生破坏性变更,**无需改代码**。

**改动**:`peerDependencies` 里三个 dsh 包的范围由 `^0.1.1-rc.2` 改为 `>=0.1.1-rc.2 <0.3.0`(`cordis` 的 `^4.0.1`、`schemastery` 的 `^3.18.1` 本已覆盖 0.2 所用的 4.0.4 / 3.18.4);`dsh.compatibility.dsh` 由 `>=0.1.1-rc.1 <0.2.0` 放宽为 `>=0.1.1-rc.1 <0.3.0`;`dshReleases` 增加 `0.2.0-rc.1` / `0.2.0-rc.2` = `compatible`。

**验证**:`tsc` 零错误;`node --test tests/*.test.mjs` **47/47 全绿**;上述真实宿主端到端三态验证。

**状态**:已改未提交,未 bump 版本、未发布(发布时 bump)。

---

## 0.1.23 发布(2026-10-01)

bump `0.1.22 → 0.1.23`,把**第十八轮**(PR #15:Windows 合成输入三连 —— 遮挡导致输入被丢弃 / 首击丢失 / 首键丢失,外加 Electron 探测自愈与定位判词可读性;此前已合入 master 但一直未发版)与**第十九轮**(DSH 0.2 兼容性声明)随版本发布,tag `v0.1.23`。

README 中英同步:更新记录新增两行;兼容性说明从 `<0.2.0` 更新为覆盖 0.2 线。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **47/47 全部通过**;真实 `dsh web` 0.2.0-rc.2 宿主上跑通会话 / 导航 / 快照 / 截图三态。

---

## 第二十轮(2026-10-01,浏览历史持久化 / 设置栏 / 可视化鼠标 / 收尾语义)

**背景**:使用反馈集中在四件事 —— 浏览器操作后的收尾不符合预期、访问过的页面事后无从追溯、展示方式打扰、以及看不到 agent 究竟在操作哪里。本轮按"不依赖宿主新接口的先做"落地,并为桌面端侧栏集成留出可降级的位置。

**1. 浏览历史持久化(新增 `browser_visited` 工具)**

- 新模块 `src/browser-electron/history-store.ts`:追加式 JSONL,落在浏览器 profile 旁(`$DSH_HOME/dsh-builtin-browser-host/history.jsonl`),与 cookies 同一套持久化规则 —— 关掉界面、重启 DSH 都还在;截断或损坏的行只丢那一行,不会毁掉整份历史。
- 记录点:`navigate` / 前进 / 后退 / 刷新,在 `settleDocument` 之后读 `location.href` + `document.title` 写入;写入是 fire-and-forget(历史永远不拖慢、也不弄挂一次导航),`about:` / `devtools:` 不计入。保留上限 **5000 条或 90 天**(先到者为准),超限自动裁剪。
- 工具层新增 **`browser_visited`**(可按域名过滤、限量);重开页面沿用现有 `browser_open`。现有 `browser_history`(会话内操作日志,内存态)语义不变,两者分工写进 README。
- 配置:`history: { enabled, maxEntries, maxAgeDays, file }`。

**2. 设置栏(客户端插件 + 设置端点)**

- 新增 `client.js`(手写 ModuleLoader bundle)与 `package.json` 的 `dsh.client` 声明(`platform: web`,inject `dsh-client-locale` / `dsh-client-ui-slots` / `dsh-client-ui-settings`),注册到 `settings.section` 插槽并取 `order: 60` —— 排在宿主自带栏目(最靠后 `order: 40`)的**下面**。
- 服务端:`src/browser-electron/settings-store.ts`(设置文档:字段逐个校验、未知键丢弃、损坏文件按默认值处理、mtime 变化即重读)+ `entry.ts` 中的 `GET/PUT /dsh-builtin-browser/settings`(带**同源防护**与 64 KiB 体积上限)。
- **开关实时生效**:provider 通过 `settings: () => store.get()` 每次读取,不重启即改变行为(实测:关掉历史后新访问不再记录,既有记录保留)。
- 开关清单:保留浏览历史 / 保留 cookies / 侧栏自动展开(每轮一次)/ 会话结束时关闭浏览器 / 显示可视化鼠标 / 视觉策略(Auto 或纯非视觉)/ 允许读取凭据;面板同时显示设置文件路径便于排查。

**3. 可视化鼠标(新增 `src/browser-electron/virtual-cursor.ts`)**

- 页面内叠加层(不动系统鼠标):`position: fixed` + 视口坐标 —— 与元素定位的 `getBoundingClientRect`、`Input.dispatchMouseEvent` 处于同一坐标空间。**全部内联样式 + Web Animations**,不使用 `<style>` 元素,否则页面的 `style-src` CSP 会把它拦掉。
- 落点来源:`buildTargetScript` 统一在脚本返回值上附加元素中心 `__point`,于是 `click`(语义与坐标两种)、`type`、`setValue`、`check`、`select`、`clear` **都有落点** —— DOM 级操作不再"看不见"。已有 x/y 的 click 不受影响(附加键名不覆盖)。
- 语义:**光标出现即表示 agent 已接管该标签页**;点击带涟漪动画。可由设置 `ui.virtualCursor` 关闭。

**4. 收尾语义(关界面 = 结束该会话)**

- `host-main` 在窗口 `closed` 时:①释放该窗口全部视图的 `webContents`(BrowserWindow 不连带销毁子视图,否则每关一个窗口就泄漏一个渲染进程);②向父进程发送 `viewClosed` 通知(复用既有 `id: 0` 通知通道)。
- `remote-host` 新增 `onViewClosed(handler)` 注册(与既有 `onUserAction` 同构);provider 收到后**结束对应会话**。`browser` seam 新增 `exists(session)`,工具层的会话缓存先核验再复用 —— 人关掉窗口后,下一次调用开的是一个**干净的新会话**,而不是继续驱动一个谁也看不见的窗口。
- 浏览历史与登录状态不受影响(它们保存在磁盘上)。

**5. 设置栏一度"隐形"的根因与修复(真机验证后追加)**

- **现象**:安装后浏览器功能全部正常,但设置页里**看不到**「浏览器」栏;`dsh web` 启动日志也没有报任何与插件相关的失败,启动图(`window.__DSH_BOOT__.entries`)里**没有** `dsh-builtin-browser` 条目。
- **根因**:宿主的客户端模块扫描(`client-modules`)从 **Loader 行的 specifier** 解析包根,再读该包的 `dsh.client` 声明;而它只接受**精确包名**——

  ```ts
  function exactPackageSpecifier(specifier) {
    return specifier.length > 0 && !specifier.includes('/') && !specifier.includes(':') ? specifier : undefined
  }
  ```

  本插件的 `cordis.patch.yml` 三行全部使用**子路径名**(`dsh-builtin-browser/browser`、`/browser-electron`、`/tool-browser`),含 `/` 即被判为"不是客户端包"并**静默跳过**——于是这个包没有任何一行能让宿主读到它的 `dsh.client`,`ui-slots` / `locale` / `ui-settings` 三个 inject 目标也就无从解析。对照:同环境里能进启动图的第三方插件(purge、vdesktop)都有一行 `name:` 写着**包名本身**。
- **修复**:①`cordis.patch.yml` 增加一行 `id/name: dsh-builtin-browser`(置于最前,惰性);②`src/index.ts` 补上 `export const name` 与一个空的 `apply()` —— 原先根入口只有 re-export,不足以成为一个合法的 Loader 行。
- **验证(真实 `dsh web` 0.2.0-rc.2 宿主,带 token 打开 GUI 实测)**:启动图条目 67 → **68**,出现 `{ id: 'dsh-builtin-browser', url: 'plugins/??dsh-builtin-browser/client.js&rev=b0ff3e951670' }`;设置页出现「浏览器」栏并排在「规则设定」下方,**6 个开关**全部渲染(保留浏览历史 / 保留 cookies / 侧栏自动展开 / 会话结束时关闭浏览器 / 显示可视化鼠标 / 允许读取凭据)与视觉策略下拉;拨动开关后 `$DSH_HOME/dsh-builtin-browser-host/settings.json` 立即落盘,`history.jsonl` 同步开始记录。
- **附带说明**:界面显示的版本号 `0.1.7-rc.2-<hash>-dirty` 来自 `git describe --tags` 的**最近 tag**,而实际代码是 `package.json` 的 **0.2.0-rc.2**(HEAD 为 "release-dsh-0.2.0-rc.2" 合并提交);本地未拉取 0.2 的 tag,与插件无关。

**验证**:`tsc -p tsconfig.json` 零错误;`node --test tests/*.test.mjs` **68/68 全绿**(新增 21 条:历史 7、设置 5、可视化鼠标 5、关窗口 4)。

**边界与状态**:桌面端"官方侧栏承载 agent 浏览器(人机同页)"需要宿主提供 guest 控制权接口,本轮**未做** —— 接口缺席时插件按现状(自托管弹窗)工作,以上功能均不受影响。

---

## 第二十轮补记(2026-10-01,真机复现后追加)

**6. 宿主日志与崩溃诊断**

- 真机复现(隔离 `DSH_HOME`、带真 TCP 监听的 `repro2.mjs`,7 个用例)把一类崩溃锁到唯一签名:**`code=1` + 零 stderr**,只对应"Electron 加载不了 app 入口脚本";同时否证了"抢 GPU cache/session 锁""信息被吞进没人读的 stdout""父进程未监听"三条假设。
- 由此暴露日志本身的三处缺陷,已修:①**无时间戳** → `hostStamp()` 给每行加 ISO 前缀;②**入口与二进制路径没被记录** → spawn 前写 `spawning: electron=<path> (exists=…) hostMain=<path> (exists=…) port=…`;③**2 MiB 轮转整体清空** → 改为写入带时间戳的轮转标记(就是它把几周历史销毁的)。`exit` 行另加 `pid=` 与 `entryExists=`(退出时复查入口),于是"启动时存在、退出时不存在"这一组合**自己就能命名**"安装被就地替换"这一根因。
- **测试污染修复**:`host-log` / `remote-host-recovery` / `electron-probe` 三个测试会真实 spawn 子进程,而 `dispose()` 是**异步**杀子进程的 —— 它的 exit 行写在测试 `finally` 恢复 `DSH_HOME` **之后**,于是合成记录进了操作者真实的 `$DSH_HOME/logs/dsh-builtin-browser-host.log`(正是崩溃诊断所依赖的那份)。三处改为**模块级**隔离且不再恢复,并以"跑测试前后真实日志行数不变"验证。

**验证**:`tsc` 零错误;`node --test tests/*.test.mjs` **70/70 全绿**(新增 host-log 2 条)。

---

## 0.2.0 发布(2026-10-01)

bump `0.1.23 → 0.2.0`,发布**第二十轮**(浏览历史持久化 / 设置页「浏览器」栏 / 可视化鼠标 / 收尾语义)及其真机补记(客户端设置栏"隐形"的根因修复、宿主日志与崩溃诊断)。这是插件的第一个**行为可见面**发生变化的版本:工具数 **33 → 34**(新增 `browser_visited`),设置页多出一栏。

**验证**:`tsc` 构建零错误;`node --test tests/*.test.mjs` **70/70 全部通过**;真实 `dsh web` 0.2.0-rc.2 宿主上带 token 打开 GUI 实测 —— 启动图条目 67 → 68、设置栏出现并排在「规则设定」下方、6 个开关与视觉策略渲染正常、拨动开关即时落盘、`history.jsonl` 同步开始记录。

**顺手记录**:`git describe` 显示 `0.1.7-rc.2-…` 只是本地 tag 未含 0.2 线;`git fetch --tags` 后为 `dsh-v0.2.0-rc.2`。

---

## 第二十一轮(2026-10-01,桌面端侧栏接管:agent 的页面 = 人看到的页面)

**背景**:需求表 §1/§2 要求桌面端**由官方侧栏承载 agent 的浏览器**(人机同页),而不是插件再开一个平行窗口。此前插件在桌面端的真实表现已实测确认:它 spawn 自己的 Electron,弹出一个与桌面主窗口毫无隶属关系的独立窗口(`dsh-browser — about:blank`)。

**关键调查(全部真机验证,非推断)**

- 桌面端是**两层**:`DeepSeek Harness.exe`(Electron 外壳)+ `--expose-internals` 的 **Node 模式宿主**(`dsh-desktop-host`,插件就跑在这里,**没有 Electron API**);窗口只是加载宿主给出的 `dsh-app://app/`。
- 宿主与外壳之间的事件集(`host-process.ts`)**没有任何与视图/窗口相关的通道**;0.2 又移除了 `electronViewHost` —— 所以"把视图贴进桌面窗口"没有现成机制可复用。
- 桌面端安装目录里的 `app.asar` 已被替换为**解包的 `resources/app/`**(旁边还有 `app.asar.bak` 与 `app.asar.rename-pending`),因此**主进程代码可直接修改**;`lib/main.js` 旁还躺着 `main.js.dshpurge.bak`,说明改这台机器的桌面端是既有做法。
- 侧栏浏览器的 guest **是懒创建的**:未导航时只有一个地址栏,**不存在任何 webContents**;导航后才出现 `type=webview` 的 guest(URL 形如 `about:blank#<leaseId>`,即 `browser-guests` 的租约)。

**实现:一个 loopback bridge + 插件侧换一个宿主**

| 位置 | 改动 |
| --- | --- |
| `apps/desktop/bridge/plugin-browser-bridge.js`(新增) | 主进程内的 bridge:loopback TCP + 随机 token;`list`(列出全部 webContents,标注 sidebar guest)、`cdp`(经 `webContents.debugger` 转发任意 CDP,按 guest 串行)、`ensureSidebar`(按需逼出侧栏 guest);endpoint 写入 `$DSH_HOME/dsh-builtin-browser-bridge.json` 并**每 15 秒刷新** |
| `apps/desktop/bridge/install.mjs`(新增) | 幂等安装/回滚:备份 `main.js.before-bridge`、在 `export {};` 前注入启动片段、`--revert` 还原 |
| `resources/app/lib/main.js`(已安装的桌面端) | 尾部 +8 行:app ready 后启动 bridge;失败不影响外壳 |
| 插件 `src/browser-electron/desktop-bridge-host.ts`(新增) | 实现**同一个** `ElectronBrowserViewHost` seam,但命令走 bridge;缓存 guest 且**每次复用前核对存活** |
| 插件 `src/browser-electron/entry.ts` | 先注册自托管(任何 surface 从第一次调用起就可用),发现 bridge 后**热切换**到侧栏并释放子进程;发现不到则照旧 |

**实测(桌面端 `0.2.0-rc.2`,带 token 的真机)**

- `browser_open https://example.com/` → 返回 `Example Domain`,`browser_content` 直接读到侧栏页面正文;
- bridge 侧:`[webview] id=2 Example Domain https://example.com/` + 主窗口;
- **零 `electron.exe` 进程、本次会话零 spawn、桌面端只有主窗口一个窗口** —— 独立浏览器窗口不再出现。

**过程中被实测纠正的三个想当然**

1. **地址栏那条路不可靠**:React 受控输入忽略合成的 `KeyboardEvent`(字段显示地址而组件状态未变),且字段的 focus 会被重渲染夺走(`document.activeElement` 实测为 `BODY`)。改为优先点侧栏自带的**「恢复页面」**(1 秒内逼出 guest),再用纯 CDP `Page.navigate` 导航 —— 不经过 UI。
2. **endpoint 必须反复刷新**:一次性写入会让读者拿到**已退出实例**的地址(现象是莫名 `ECONNREFUSED`);改为每 15 秒重写并附带 `pid`/`updatedAt`。
3. **认证消息不是命令**:把 token 单独一行发送时,服务端会把它也送进命令处理并回 `unknown op ""`;现在认证后立即 `continue`。

**收尾语义(需求表 §3 按新载体重写)**:插件在此载体上**没有自己的窗口**,故"关界面 = 释放进程"不再适用 —— 改为:人关掉侧栏那个 tab → 插件下次操作前 `guestAlive` 核对失败 → **自动开一页新的**(等价于"这一页结束了"),而浏览历史与登录状态照旧保留在磁盘。

**验证**:`tsc` 零错误;`node --test tests/*.test.mjs` **70/70 全绿**;上述真机端到端。

**状态**:插件侧未 bump 版本、未发布;桌面端改动以 `install.mjs` 形式可重放(桌面端升级后需重跑)。

---

## 第二十二轮(2026-10-01,issue #16:错误上报路径不得致命)

**报告**:`notifyUserActionError detaches the host method, crashing the whole DSH host`。诊断准确,两条路径都成立:

1. `ElectronBrowserProvider.notifyUserActionError` **把宿主方法取出来再非绑定调用**,于是宿主实现第一句 `void this.ready()` 抛出 `Cannot read properties of undefined (reading 'ready')`;该异常位于 async 的 catch 里,变成 unhandled rejection,宿主退出 1。
2. 即便绑定正确,`RemoteElectronViewHost.ready()` 在宿主已 dispose 时**同步抛**,`.catch()` 接不住 —— 同一类 fire-and-forget 方法(`destroyView`/`groupView`/`showView`)形状相同。

**修复**:provider 改为**在属主上调用**(`notify.call(host, …)`)并全程容错(上报失败只记一行 stderr);`ready()` 不再同步抛,改为返回 rejected promise(并标记已处理,忘了挂 catch 也不会变成 unhandled)。**回归测试** 4 条(含用报告里那个会读 `this` 的 stub 驱动的失败工具栏动作)。

## 第二十三轮(2026-10-01,undici CVE + 依赖卫生)

**报告**:issue/PR #18 —— 自动安全修复建议升级 `undici`(CVE-2026-84961,BalancedPool 选项处理)。

**核实**:CVE 真实;**但 PR 的做法在本仓库失效** —— `pnpm.overrides` 写在 `package.json` 里,pnpm 10 起已不再读取该字段(实测打印警告并忽略,lock 里仍是 7.29.0)。

**修复**:新建 `pnpm-workspace.yaml`(pnpm 11 的正确位置),锁 `undici: 7.29.1`(同大版本,不做无收益的 8.x 跳跃)。影响面已说明:undici 只是传递依赖,插件不 import 它,发布物也不含 `node_modules` —— 价值在于保持仓库依赖树干净。

## 第二十四轮(2026-10-01,需求表 v2 逐条落地)

| 需求 | 实现 |
| --- | --- |
| §7 视觉策略 | `nonVisual` 下**拒绝坐标点击**并给出可执行替代;工具描述改为语义优先;设置面板文案与真实行为对齐(**此前该设置项是死的**) |
| 非视觉输出 | 快照用 `depth` 做**层级缩进**、坐标改按需(`coords: true`)、去空 `states`;`content(txt)` 改用浏览器渲染文本 |
| §8 明示 | README 中英 + 设置面板写明沙箱边界变化(三个后果 + 两个开关 + 回退方式) |
| §3 生命周期 | `closeWithSession`(会话结束释放页面)/ `autoExpandOnce`(不抢屏则折叠)真正接线;bridge 新增 `closeSidebarBrowser`、`collapseSidebar` |
| §4 多会话隔离 | 每个 view 独占一个侧栏标签;释放时**只关自己的**(按 guest id 反查标题) |
| §5 历史检索 | 新增 `query`(URL/标题)与 `session`(来源会话)过滤,可组合 |
| §6 可视化鼠标 | 新增**操作气泡**,在指针旁叙述当前动作 |

**顺带修掉的 6 个真 bug**(均为实测发现):`content(txt)` 把逐字动画页面的文字拆成一列字母;`ensureSidebar` 因找不到地址栏而直接抛错,**重启后第一次调用必失败**;`vision.strategy`/`closeWithSession`/`autoExpandOnce` 三个设置项**存了却不被读取**;`releasePage` 会**关掉别人的标签**(多会话时结束一个会带走另一个的页面,自己引入的);**设置文件带 BOM 时全部设置被静默丢弃**(记事本/PowerShell 写入即触发)。

## 第二十五轮(2026-10-01,速度优化 + 结构拆分)

**量化**(真机测量,10 次均值):每次**新建连接** 24.8ms、复用连接 **0.2ms**;每条命令原本要付 `连接 + list 存活检查 + 命令` = **49.1ms**,而一次 `browser_click` 会发多条 CDP,开销成倍。

**优化**:`BridgeConnection` 改为**长连接 + 请求串行**(0.6ms);**去掉每条命令前的 `list` 存活检查**,改为"命令失败才重建 guest"(真实错误照旧上抛)。传输层拆成独立模块 `bridge-connection.ts`(`desktop-bridge-host.ts` 426 → 306 行)。

**鼠标**:位置未变时**不再重绘**(省一次往返,也消除同点重绘造成的顿卡),点击仍强制播放涟漪;缓动改为 `190ms cubic-bezier(.22,.85,.24,1)`;新增 `forgetCursor` —— 文档被替换后必须清缓存,否则导航后**指针再也不会出现**。

## 第二十六轮(2026-10-01,可选用本机 Chrome / Edge)

**新增载体**:设置里可选 `bundled` / `auto` / `chrome` / `edge`(`browser.channel`),做法与 Codex Browser Use 一致 —— `--remote-debugging-port=0` 启动,读浏览器自己写下的 `DevToolsActivePort` 取端口,全程走 CDP(Node 22 内置 `WebSocket`,**零新增依赖**)。

**数据隔离**:使用**独立 profile**(`$DSH_HOME/dsh-builtin-browser-host/<chrome|edge>-profile`),绝不打开、占用或修改用户日常的窗口、书签与登录状态;插件退出也不会关掉用户的浏览器。

**登录态**:`cookies.persist` **开**(默认)→ 固定 profile 保留,重启 DSH 仍是登录状态,`browser_auth` 照常可导出/恢复;`persist` **关** → 临时 profile,释放时整个目录删除。

**优先级与回退**:显式选择的本机浏览器 > 桌面端侧栏 > 自托管。载体缺失分两种:`自动` 找不到 Chrome/Edge 时**记警告并继续用内置**;**明确选了某个浏览器**而它没装时不再只写日志 —— 改挂 `MissingSystemBrowserHost`,**每次命令都向调用方报出找不到的浏览器、查过哪些名字与位置,以及三条出路**(装上它 / 用 `DSH_BROWSER_CHROME_PATH`、`DSH_BROWSER_EDGE_PATH` 指定路径 / 把载体改回内置或自动),不静默替换。

**结构**:bridge 纳入插件仓库(`desktop-bridge/`,`install.mjs` 幂等 + `--revert`),并写进 npm 打包清单 —— 此前它只存在于 DSH 仓库,用户装了插件也拿不到。
