# 扩展 UI 全量对齐方案（v2，经 oracle 审核后修订）

目标：把 SDK `ExtensionUIContext` 里**尚未实现或只部分实现**的成员全部落地，不再用「可见降级」代替实现。
只有浏览器物理上没有对应物的语义才保留刻意分叉，且逐条写明理由。

对照基准：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` 的
`ExtensionUIContext`（30 个成员）+ 扩展 API 的 `registerShortcut` / `registerMarkdownTransformer`。

> **本版的由来**：v1 由 oracle 独立审核（报告见 `/tmp/pidance-wt/oracle-parity.md`，不进仓库）。
> 它指出 v1 有 5 项走错层（B4/B6/B7/B8/A2）并漏了若干特殊处理。**下面每条我都回代码核过**，
> 核实结论标在「核实」一行；只有我无法从代码确证的点才标「待实现时确认」。

---

## 0. 先定接口（其余项都受它影响）

### 0.1 渲染结果要能带图片（否则 A3 做完还得回改）

现在渲染桥的产物只有 `string[]`（文本行），且**单行 4000 字符、合计 200KB 上限，超限整段作废**
（`lib/tui-render-bridge.ts:161,432`）。B4 要的图片承载必须先进共享结构，否则 A3 的页头/页脚
槽位做完还要再改一遍。

**决定**：渲染结果扩成 `{ lines: string[]; images?: RenderedImage[] }`，
`RenderedImage = { id: string; mime: string; base64: string; cols: number; rows: number; alt?: string }`。
长度/体积校验仍只针对 **去掉图片序列之后的文本**；图片另有字节上限（见 B4）。

### 0.2 能力开关是进程级的

`getCapabilities()` / `setCapabilities()`（pi-tui）是**进程全局**，主题（`initTheme`/SDK 全局槽位）
同理。所以：**任何切换都必须同步包住使用点并立刻还原**（不可长期置位），否则多会话/多标签会串色
或让别的渲染走错分支。隐藏标签**不得上报**渲染几何（`hooks/useRenderSize.ts` 目前不看 visibility，
要一并修），否则会污染宽度/行数缓存与 bounds。

---

## A. 有落点，直接实现

### A1. `setHiddenThinkingLabel(label)`

- **TUI 语义（核实）**：改的是**收起的思考正文**那块（`hiddenThinkingLabel`），作用于
  `AssistantMessageComponent` 与流式组件；`setHiddenThinkingLabel()` 无参恢复默认。
  来源：`interactive-mode.js` 的 `setHiddenThinkingLabel` 实现。
- **实现**：适配器存 per-session 值 → 宿主机状态投影带出去 → 时间线里**思考块的正文首行**用它；
  无参/`undefined` 恢复我们的 i18n 文案。
- **特殊处理**：插件给的是任意串，**绕过 i18n 原样显示**；限长（60 字符）截断并保留 `title`；切会话重置
  （SDK 的 `resetExtensionUI` 会重置，我们对齐）。
- **验收**：单测（设置/清除/切会话重置/超长截断）+ 浏览器看收起态正文首行变化。
- **已落地**（issue #96，2026-09-26）：适配器 per-session 存值 → 状态投影 `hiddenThinkingLabel`（水合 4 条路径）
  + 既有 `extension_ui_request` 实时下发；折叠行用它、展开仍渲染正文；超过 60 码点中部截断且**仅在被截断时**挂 `title`；
  切会话与插件 `reload()` 都重置（后者对齐 TUI 的 `handleReloadCommand` → `resetExtensionUI`）。真浏览器验证过 `思考· 检索记忆…`。

### A2. `getAllThemes()` / `getTheme(name)` / `setTheme(name|Theme)` + `ui.theme`

- **TUI 语义（核实）**：
  - `getTheme(name)` 是**只加载不切换**（`types.d.ts:183` 注释原文 “Load a theme by name without switching to it”）；当前主题是 `ui.theme`。
  - `setTheme(x)`：`x instanceof Theme` → `setThemeInstance(x)`；否则按**名字**加载；名字成功时**还会写设置**
    （`interactive-mode.js`）。返回 `{success, error?}`，**不抛错**。
  - `getAllThemes()` 返回 `{name, path}[]`。
- **重大简化（我核实）**：SDK **入口公开导出了真实的 `Theme` 类**（152 个导出成员里有 `Theme`、`initTheme`），
  且 `Theme` **可公开构造**：`new Theme(fgColors, bgColors, mode, {name, sourcePath, sourceInfo})`
  （`theme.d.ts:19-30`）。所以：
  - **删掉我们手写的 `Theme` 类**（`lib/tui-render-bridge.ts`），改用 SDK 的 ——
    `ui.theme`、`getTheme()`、`getEditorComponent` 之类返回的对象终于是**真 Theme**，
    `instanceof Theme` 也过（`setTheme(Theme)` 分支因此可用），SDK 渲染器读全局槽位的机制不再需要「同一对象」的额外解释。
    注入方式沿用既有约束：**SDK import 只能出现在 allowlist 的宿主模块**（`lib/sdk-session-host.ts`），
    由它把 `Theme`/`initTheme` 注入渲染桥（`lib/sdk-import-allowlist.test.mjs` 会卡）。
  - 主题清单 = SDK 自带 `dark.json` / `light.json`（**必须 vendoring**，禁止运行时读 node_modules：桥文件头有审计红线）
    + 用户主题目录（若存在 `~/.pi/agent/themes/*.json`）。
  - `setTheme(name)` 切主题：load → 换当前 Theme → 重装 SDK 全局槽位 → **重渲已渲染的插件行**（复用 invalidate 管线）；
    `setTheme(Theme 实例)` 直接切。
- **特殊处理**：
  - **不做「CSS 同源」的虚假承诺（oracle 指出、我核实为真）**：我们的壳配色是 chamber/fusion × 明暗
    （`hooks/useTheme.ts`），插件色是烤进 ANSI 的 RGB。忠实映射是：主题名 `dark`/`light` **同时**切换壳的明暗
    （壳的皮肤保持不变），插件 ANSI 用 SDK 主题；文档如实写明「两者不是同一套调色板」。
  - 修 `BG_COLOR_KEYS` 缺 `searchMatchBg`（`lib/tui-render-bridge.ts:193` 对比 vendored `dark.json:38`）。
  - 持久化写**我们自己的 UI 偏好**，不写 SDK 的 `settings.json`（避免两个事实来源）。
  - 未知主题名 → 返回 `{success:false,error}`（与 SDK 一致），并给一次可见提示。
- **验收**：单测（清单/只加载不切换/切换/未知名/缺键回退/全局槽位仍是同一个 Theme 实例）+
  浏览器：切主题后插件输出与壳明暗都变、切回可逆。
- **已落地**（issue #97，2026-09-26）：删掉手写 Theme，改用 SDK 导出的 `Theme`（**子类**只覆盖 chalk 走的那 5 个文本样式方法 ——
  非 TTY 进程里 chalk.level=0 会让基类返回纯文本；已与真实 chalk level 3 逐字节对齐，含多行/嵌套）；
  `getAllThemes`/`getTheme`（只加载不切换）/`setTheme`（返回 `{success,error}`，不抛）+ `ui.theme`；
  vendoring `light.json`；修 `BG_COLOR_KEYS` 缺 `searchMatchBg`；切主题会重渲**所有适配器**的 widget/custom（工厂拿到的是
  每次访问都解析当前主题的 Proxy，对齐 TUI 做法），并同步 SDK 全局槽位；dark/light 与壳明暗**双向耦合**（进程启动按偏好对齐 +
  用户在设置里切明暗时也切插件主题），自定义主题只走插件侧。真浏览器验证：已挂 widget 的 accent 在 `rgb(90,128,128)` ↔ `rgb(138,190,183)` 之间切换可逆，壳同步 light/dark。
- **残留**（未纳入 #97 范围，另开 issue #109）：已下发的**消息投影行**（`renderedLines`）在切主题后仍是旧色，直到页面重载或重新投影。

### A3. `setFooter(factory)` / `setHeader(factory)`

- **TUI 语义（核实）**：`setFooter(factory)` → 先 `customFooter?.dispose()`，再 `factory(ui, theme, footerDataProvider)`
  （**第三个参数是 footer 数据**：git/status 之类）；`setFooter(undefined)` → **恢复内置页脚**。
  `setHeader` 同理，替换/插入容器首位，并对 `isExpandable` 的组件跟随 `toolOutputExpanded`。
- **实现**：两个槽位 `extensionFooter` / `extensionHeader`，走**既有渲染桥**（headless 组件 → 结果），
  复用 widget 的 invalidate → 重渲 → 下发行管线；**替换时 dispose 旧组件**（对齐 SDK）。
  - 页脚：输入框下方、我们的状态行之上；`setFooter(undefined)` → 显示我们自己的状态条。
  - 页头：聊天列顶部（顶栏之下）。
- **特殊处理**：手机 390px 高上限（≤4 行）内部滚动；组件抛错 → 槽位隐藏 + 一次警告（不贴异常文本）；
  与我们的 chip 不混排。
- **依赖**：必须先落 0.1（否则页脚里出现图片时还要回改）。
- **已落地**（issue #98，2026-09-26）：槽位走与 widget 同一条渲染桥，替换时先 `dispose()` 旧组件、`undefined` 恢复内置
  （页脚回到我们自己的状态条）、失败隐藏槽位并**每种槽位只提示一次**且异常文本不进界面；页头在转写区**上方**（容器 `flex-col`，
  审查抓到原来被排成左兄弟、390px 上会挤掉转写区）、页脚在输入框下方；工厂的第三个参数按 SDK 契约给四个成员
  （`getGitBranch` 恒 null、`getAvailableProviderCount` 恒 0 —— 都没有同步来源，理由写在实现里），**不传会让官方示例那样的页脚整槽抛错**；
  插件 `reload()` 前清槽位并对齐 TUI 的 `resetExtensionUI`。真浏览器验证过位置与 `undefined` 恢复。
- **验收**：单测（设置/清除恢复内置/dispose 被调用/抛错降级/超行数）+ 桌面与 390px 各看一次。

### A4. `overlay.focus()` / `unfocus(target?)` / `getBounds()`

- **TUI 语义（核实）**：`unfocus` 可以带 target（不一定回到输入框）；`getBounds()` 是**同步**读几何。
- **实现**：`focus()` 把键盘焦点交给面板；`unfocus(target)` 按 target 决定落点（缺省回输入框）；
  `getBounds()` 读**客户端缓存的几何**（挂载/resize 时上报一次，换算用 `lib/render-width.ts` 的测量助手，
  未挂载返回 `undefined`）。
- **特殊处理**：隐藏标签不上报几何（见 0.2）；服务端不得为了几何去 `ensureLive`。
- **验收**：单测（状态机/换算/未挂载 null/隐藏不上报）+ 浏览器验焦点与几何。
- **已落地**（issue #99，2026-09-26）：`focus()`/`unfocus(target)` 三态（`null`=谁都不聚焦、缺省=回输入框）、
  `nonCapturing` overlay 初始焦点留在编辑器、`getBounds()` 返回**客户端上报**的字符单元格矩形（原点取会话滚动区，与鼠标坐标同源），
  后台标签不上报、量不出不报。真浏览器验证：`focused=true → false → true` 且三条报告的 bounds 都是真实矩形。
  **期间抓到并修掉一个真 bug**：`lastBoundsRef` 只比几何，而同一个组件实例会被复用给下一个请求、新面板几何往往完全相同，
  于是新 id 永远不会上报 → 插件读 `getBounds()` 恒为 undefined（见 83cf2f2）。

### A5. 对话框 `timeout`

- **TUI 语义（核实）**：超时**等于取消**——`select`/`input` 得到 `undefined`，`confirm` 得到 `false`；
  `editor()` **没有** timeout。
- **实现**：服务端已自结算；把 `deadline` 随请求下发，`ExtensionDialog` 显示剩余秒数；到点与既有结算一致。
- **特殊处理**：结算权威在服务端（客户端只显示）；倒计时用 `aria-live="off"`。
- **验收**：单测（到点取消/confirm=false/格式）+ 浏览器看倒计时与超时关闭。
- **已落地**（issue #100，2026-09-26）：宿主下发**绝对过期时刻** `expiresAt`（与结算定时器同源，`timeout` 先收口：非有限/≤0 不设、超过 32 位上限截断）；
  结算（含 `responded`/`abort`/`disposed`/`failed`）立刻经既有 SSE 推一条 `extension_ui_settled{id,reason}`，客户端据此**收起面板且不回响应**，
  并记住已结算 id 挡住迟到的快照；删掉客户端按本地时钟自己关面板的旧死代码（手机与宿主不同钟会提前消失/闪回）。
  真浏览器验证：对话框按秒倒计时 剩余 6→5→4→3→1 秒，到点面板自行消失，扩展收到 `undefined`（超时=取消）。

---

## B. 需要新通道或特殊处理

### B1. `addAutocompleteProvider(factory)`

- **TUI 语义（核实）**：`AutocompleteProvider = { triggerCharacters?, getSuggestions(lines, cursorLine, cursorCol, {signal, force?}), applyCompletion(lines, cursorLine, cursorCol, item, prefix) }`
  （`pi-tui/dist/autocomplete.d.ts:17-24`）。适配器把 factory **push 进链**后重建 provider（SDK 实现：`autocompleteProviderWrappers.push`）。
- **实现**：
  - 宿主按 SDK 语义维护 provider 链（`factory(current)` 依次包裹）；
  - 新增命令 `completion_suggestions {lines, cursorLine, cursorCol, trigger, force?}`；
    客户端只在**触发字符**（`@`、以及 provider 声明的 `triggerCharacters`）时调用，**防抖 120ms + 请求序号 + AbortSignal 取消上一次**（与 #75 命令参数补全同模式）；
  - **无 provider 注册 → 完全不发请求**（零往返）；
  - 插件返回 `[]` = 明确「无候选」→ **不回退我们自己的补全**；只有「没注册 provider / 请求失败 / 超时」才回退；
  - 选中条目走 `applyCompletion(...)` 由插件给出替换区间（不再由我们猜）。
- **特殊处理**：只读会话不得为了补全去 `ensureLive`（不抢租约）；IME 组合期不请求；迟到响应按序号丢弃。
- **验收**：单测（链式包裹、`[]` 不回退、失败回退、AbortSignal、无注册零请求）+ 真装 pi-fff 后用浏览器验 `@` 出插件条目。

### B2. `onTerminalInput` 窗口扩容

- **现状**：两个窄窗口（widget 选择态；已收起面板的 Esc/F/Alt/Ctrl 组合）。
- **实现**：新增「插件拥有焦点面」窗口——**custom 面板 / overlay / 扩展对话框处于活动态且输入框未聚焦**时，
  把按键（除浏览器保留组合）交给插件；输入框聚焦时保持现状。
- **特殊处理（oracle 指出、我核实）**：
  - 保留键用**现有全表** `lib/extension-panel-keys.ts:20` 的 `BROWSER_RESERVED_CTRL_KEYS`，**不要缩成 W/T/N/L**；
  - IME：沿用现有 **compositionend 后 80ms 宽限**（`hooks/useExtensionWidgetKeys.ts` 已有），组合期不路由；
  - 按键带 `assertFocus` + 焦点 TTL；面板关闭的同一帧把焦点还给输入框。
- **验收**：单测（窗口判定矩阵、保留键不被拦、IME 宽限）+ 浏览器：面板打开时字母/方向键进插件、输入框聚焦时不进。
- **已落地**（issue #102，2026-09-26）：新增窗口 ③（插件界面显示中，除保留键与**已有 DOM 归属者**外都路由）。
  审查抓到原来的 DOM 归属判据是一张**过窄的标签白名单**，会在插件界面打开时抢走壳上已聚焦控件的按键（拖宽手柄、谱系树行、
  可聚焦的工具输出），改成通用规则「目标是当前焦点元素（且不是 body/documentElement）」。**有意不带 `assertFocus`**：
  窗口 ③ 成立时输入框并没有聚焦，带上等于把 `tui.focusedComponent` 谎报成主编辑器。

### B3. widget 鼠标（`handleMouse`）

- **TUI 语义（核实）**：事件是**局部坐标** + `wheelDelta`/`clickCount` 等，返回值是 `handled`/`capture`。
- **实现（先只做 click）**：widget 卡片**正文区**的 click 换算成字符单元格后，随命令发给对应 widget 组件；
  响应可带新的渲染行（复用重渲管线）。
- **特殊处理**：
  - **卡片头归我们的槽位外壳**（折叠按钮/`aria-expanded` 不能被抢），插件只拿正文；
  - **不做「插件声明后才拦滚动」**（oracle 指出：往返回来再 `preventDefault` 已经来不及），滚动默认不拦；
  - 触摸：tap → left click；长按 → right click；
  - 坐标换算必须与 `render(width)` 同源（同一测量函数），否则点不准。
- **验收**：单测（换算/头与正文分区/触摸映射）+ 浏览器点 fleet widget 看整块切换。
- **已落地**（issue #103，2026-09-26）：只转 click、卡片头归外壳、坐标与渲染同源（量不出不转发）；
  审查抓到手机上**滑动超过 10px 仍会被当左键**（并有一条把错误行为锁死的测试）与 `touchcancel` 清掉「已派发右键」标记，都已修。
  真浏览器验证：点击 widget 正文区把 `{type:click,button:left,x:0,y:0,width:122,height:1}` 送到了组件的 `handleMouse`。

### B4. `Image` / Kitty 内联图片

- **v1 的错误（oracle 指出、我核实）**：`kittyProtocolActive` 是**键盘**协议（`pi-tui/dist/terminal.js:77-102,193-296`），
  图片能力看的是 `getCapabilities().images`。序列本身：`a=T`、**固定 `f=100`（PNG，不是 mime）**、
  `q=2`、`i=`、`C=1`，分块是**首包全参数 + `m=1`**、中包只有 `m=1`、末包 `m=0`；
  另有 `a=d,d=I|A|a` 删除与 `a=p` 无载荷（`terminal-image.js:136-205`）；mime 不在序列里。
- **实现**：
  1. 渲染前**同步** `setCapabilities({ images: "kitty" })`，渲染后立刻还原（进程全局，见 0.2）；
  2. 渲染桥**先摘出**图片序列（含分块拼接与参数解析）→ 结构化 `RenderedImage`（0.1），文本侧只剩占位行；
  3. **再做**长度/体积校验（否则 200KB 上限会把整段渲染作废）；
  4. 客户端渲染真 `<img>`（data URL），按 `rows` 留行高，与文本行高对齐；
  5. 解析失败/超上限 → 退回插件给的 alt 文本（`imageFallback`），不显示半张图。
- **特殊处理**：图片字节上限；base64 **不进 SSE 重复推送**（随渲染结果一次性下发，或走专用取图端点）；
  mime 由我们按 `f=100` 判 PNG（其他格式码→不支持时走 alt）；无障碍 alt。
- **验收**：单测（单块/分块/损坏/参数/上限/alt 回退）+ 浏览器看真图与行高。

### B5. `registerShortcut(shortcut, options)`

- **TUI 语义（核实）**：SDK 侧 `getShortcuts(resolvedKeybindings)` 解析后交给编辑器的
  `onExtensionShortcut`；**handler 是异步的且拿到完整扩展 ctx**；注册是有顺序语义的
  （oracle 说「后注册者胜」——**我没有在代码里确证**，实现时先写一个探针确认，再决定冲突提示的措辞）。
- **实现**：宿主读扩展注册的 shortcuts（`extension.shortcuts` 已在加载结果里），绑定到我们的全局快捷键层；
  设置里列一份「插件快捷键」清单。
- **特殊处理**：
  - 浏览器保留组合（含现有全表）**永不覆盖**；不可绑的组合在清单里标「Web 上不可用」，
    **不自动改键**（oracle 明确反对自动替代）；
  - 与输入框/浏览器默认行为冲突的（Ctrl+A/C/V/X/Z…）不覆盖；
  - 冲突时按上面探针确认的语义处理，并在清单里标注；
  - handler 需要完整 ctx（cwd/model/abort…）→ 复用既有命令通道下发（不能只发一个 key）。
- **验收**：单测（映射/保留键/冲突）+ 浏览器按一个可绑组合触发动作。

### B6. `registerMarkdownTransformer(transformer)`

- **v1 的错误（oracle 指出、我核实）**：签名是**同步** `(markdown, ctx) => string`，
  `ctx = { messageType: "user"|"assistant"|"assistant-thinking", isStreaming, availableWidth }`
  （`types.d.ts:948-957`）；**每个扩展只留最后一个**（`loader.js:265` 是赋值）；
  SDK 自己还带一个 **mermaid** 转换器排在链首（`getMarkdownTransformers()` 的实现：
  `[mermaidMarkdownTransformer, ...extensionRunner.getMarkdownTransformers()]`）；
  **代码块也参与转换**（mermaid 就是改 code block）。所以 v1 的「异步 + 800ms 超时 + 按 messageId+hash 缓存」是错的。
- **实现**：在**渲染边界**应用，不放进 `buildSessionContext`（reader 必须保持同步纯函数）：
  - 把同步转换器（从已加载扩展解析，缓存在 `lib/loaded-extensions.ts` 同款缓存里）注入**分页后的投影**与
    **流式消息**两条路径；
  - 上下文我们能给真的：`availableWidth` 取客户端上报的渲染宽度（宿主已有这条通道，见 `set_render_size`）、
    `isStreaming` 取该会话/该条消息的实时标记、`messageType` 按角色与是否思考块判定；
  - 缓存键 = `(messageId, 内容 hash, availableWidth, isStreaming, messageType)`，宽度或流式状态变化即失效；
  - 抛错 → 该条**原文显示**（对齐 SDK 的「抛错跳过」）。
- **特殊处理**：只在分页窗口内做（不扫整条 leaf）；安装/卸载插件时失效缓存；
  链首的 mermaid 转换器要一并跑（否则与 TUI 不一致）。
- **验收**：单测（同步应用/宽度变化失效/流式/抛错原文/链式含 mermaid）+ 浏览器看 mermaid 与自定义转换生效。

### B8. `setEditorComponent(factory)`（编辑器接管）

- **v1 的错误（oracle 指出、我核实）**：工厂返回的是 `EditorComponent`：`{ render, handleInput(data), onSubmit?(text), dispose? }`
  （`pi-tui/dist/editor-component.d.ts:16-18`）；TUI 把 `onSubmit` 接到发送；**正文不走 `setEditorText`**。
- **实现**（分步，默认关闭）：
  1. 已有：工厂值存下并被 `getEditorComponent()` 读回；
  2. 新增：**接管面板**——在输入框位置 headless 渲染该组件，按键进 `handleInput`（复用面板 keytrap + B2 的窗口机制）；
     `onSubmit(text)` → 走**现有发送管线**（队列/所有权不绕过）；壳外单独一个「返回输入框」按钮退出（**不用 Esc**，避免打断 Vim 之类的插件内部状态）。
- **特殊处理**：接管时禁用我们的输入框（避免两处收键）；设置里可禁用接管；**手机不做接管**（保持真输入框）；
  接管期间仍必须有可见退出路径。
- **验收**：单测（接管/恢复/onSubmit 走管线/退出按钮/手机不接管）+ 浏览器走一遍：接管 → 输入 → 发送 → 退出。

---

## C. 明确不做（有理由，且**不再**靠「不支持」提示掩盖的部分要写进文档）

| 项 | 理由 |
|---|---|
| **B7 `tui.stop()`/`start()` 让出终端** | **oracle 判定不可行，我核实为真**：`stop()` **不带命令**，插件是先 `stop()` 再自己 `spawn({stdio:"inherit"})`
（rpiv `external-editor.ts:46`），我们的面板 PTY 看不到那个子进程；要接上只能劫持 spawn —— 那是新的信任面。
**保持现状**（一次可见失败），并在文档写明理由。 |
| 真 stdio 让出 / 终端能力协商 / `getCellDimensions()` 之类 | 浏览器里不存在（B4 只把 Kitty 序列当**传输格式**解析） |

---

## D. 实施顺序（批内：实现 → 独立审查 → 修复 → 合并 → 部署 31416 → 真实验证）

0. **批 0**：0.1 渲染结果带图片 + 0.2 进程级开关的「同步包住并还原」约定；顺手修
   `useRenderSize.ts` 隐藏标签上报（0.2 的污染源）
1. **批 1**：A1 思考标签、A2 主题（含**换用 SDK 的 Theme、删我们那份**）、A5 倒计时
2. **批 2**：A3 页头/页脚、A4 overlay 焦点与几何、B2 按键窗口、B3 鼠标（先只 click）
3. **批 3**：B1 补全、B5 快捷键、B6 markdown 转换器
4. **批 4**：B4 Kitty 图片
5. **批 5**：B8 编辑器接管（最高风险，默认关闭）

## E. 跨端（每批单独评估）

手机 390px（页头/页脚上限、接管面板不做、图片尺寸）；Electron 壳（同代码路径，但要发版才生效）；
多标签（按键/接管/鼠标按 clientId 隔离）；隐藏标签（不上报几何、不轮询）。

## F. 不变量

1. `SessionManager` 是 JSONL/tree 唯一 writer；live writer 全程持租约；**不为 UI 去 `ensureLive`**。
2. 分层单向 Route → SessionService → registry → host → SDK；client 禁止 import Pi SDK；
   SDK import 只在 allowlist 的宿主模块（`lib/sdk-import-allowlist.test.mjs`）。
3. 只读投影失败 → 200 安全空态；缺参 400 / 越权 403 / 冲突 409。
4. 新增 `globalThis` 键必须登记并写失效入口。
5. 新 TS/TSX 用 CRLF；面向用户文案 i18n 双语；颜色只用 `app/globals.css` 变量。
6. 验证脚本不得写进真实 `~/.pi/agent`（用独立 `PI_CODING_AGENT_DIR`）。

## G. 探针结果

- **`getShortcuts` 冲突语义：已确证**（原先只是 oracle 的说法）。规则：键名小写后入表；命中
  `RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`（18 项，如 `app.interrupt`/`app.message.copy`/`tui.input.submit`）
  → 插件注册被**跳过**并记诊断；命中非保留内置键 → **插件胜**并记诊断；两插件同键 → **后注册者胜**；
  诊断收在 `getShortcutDiagnostics()`。依据 `dist/core/extensions/runner.js`，细节见 issue #105 的评论。
- **`light.json` 字段完整性**：待 A2 落地时逐键核对（并入既有主题一致性测试）。
- **Kitty 序列在真实插件输出里的形态**：待 B4 落地时探针（是否只有 `a=T`，iTerm2 分支是否出现）。
