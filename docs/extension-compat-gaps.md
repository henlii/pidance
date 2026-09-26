# 扩展兼容缺口清单

判定规则见 `AGENTS.md`「产品原则」：**兼容优先，优化必须通用**。
（公开仓版本见 README 中英两版的「设计原则」。）

本清单来自一次全量排查 + 一轮独立复核（复核推翻了初判的三处，见每条备注）。
对照的是 SDK 的 `ExtensionUIContext` 全量成员、pi-tui 的显示面与 `docs/tui.md`，
再对着已装插件（`~/.pi/agent/npm/node_modules/` 下的 pi-subagents、pi-mcp-adapter、
rpiv-*、pi-advisor-flow、pi-cache-optimizer 等）的实际调用确认可达性。

状态：`待修` / `已修` / `刻意分叉`（产品决定，不再改）。**优先级按「已装插件真的在用 × 影响面」。**

> **2026-09-25 收口**：规则 1 与规则 4 的缺口已按 issue #69–#93 批量修完，逐行状态见下。
> 剩下的都是**暂缓**（已装插件 0 命中或本机未配置）与**刻意分叉**，记在本文件末尾的「已定的取舍」。

---

## 一、违反规则 1：原生 TUI 有的内容，Pidance 没有且静默

| # | 缺口 | 位置 | 谁在用 | 修法 | 状态 |
|---|------|------|--------|------|------|
| 1 | `registerEntryRenderer` **零消费方**：插件自定义 entry（不是消息）在 Web 里整段消失 | 投影在 `lib/session-reader.ts`（`entryLines` 注入点）、渲染在 `lib/extension-entry-renderers.ts` + `lib/tui-render-bridge.ts` | pi-subagents（supervisor reply、watchdog warning）、pi-advisor-flow（`advisor-scout-result`） | 取 `getEntryRenderer(customType)` → headless 渲染成行 → 投影成时间线项；失败才不显示（**不硬编码 customType**） | **已修**（#71）：`lib/loaded-extensions.ts` 共享加载缓存 + 首注册者胜；渲染器缺失/抛错/形状非法一律隐藏，不把插件私有载荷当文本贴出 |
| 2 | **`invalidate()` 只重渲缓存组件，不重跑渲染器** ★ | `lib/sdk-session-host.ts` + `lib/tool-render-scheduler.ts` | SDK 内置 edit（diff 画在 `renderCall`）、bash（耗时画在 `renderResult`）、pi-advisor-flow（spinner） | 保存渲染入参、重跑 `renderCall`/`renderResult` 再推 `rendered_lines_update`；同栈重入补跑不丢弃；行没变不推（限频） | **已修**（#69）：根因是监听了永不进入会话事件的 `tool_call`/`tool_result`（那是扩展 runner 的 hook 事件），改为 `tool_execution_start/update/end`；另加同键不并发、100ms 限频、未变帧抑制；结果渲染后必须**重读 call 槽**（edit 把 diff 写在 call 组件上） |
| 3 | **`tui.focusedComponent` 恒 `undefined`**（复核判定：这不是合规分叉） | `lib/custom-ui-terminal.ts` `createEditorFocusProbe` | pi-subagents `fleet-status.ts`（`editorHasFocus()`），为假直接不渲染 roster/token | 注入「输入区是否聚焦」（前端 focus/blur 上报） | **已修**（#83）：客户端上报 `editor_focus`（按标签聚合 + 60s TTL），探针是 **getter**；配按键路由窄口子（输入框聚焦且为空时 `↓`/`←` 开局，之后才路由导航键），其他键立即退出 |
| 4 | **`terminal.rows` 曾是常量 40**（`columns` 早已是前端上报，行数没跟上） | `lib/render-width.ts` + `hooks/useRenderSize.ts` + `lib/sdk-session-host.ts` | pi-subagents `fleet.ts` 用它裁详情视口（**裁掉的行不在输出里**）；rpiv-ask-user `dialog-builder.ts` 布局 | 两个维度都改成 getter，前端按可用宽高上报（`set_render_size`） | **已修**（#70）：`measureRenderRows` 按实测行高算；按会话上报（切会话也报，否则新 host 仍是 40）；行数抖动带宽 ±1 |
| 5 | **历史重放不重跑渲染器**：刷新/重开会话后，自定义内容退回原文 | 磁盘投影在 `lib/session-reader.ts`；消息渲染器在 `lib/extension-entry-renderers.ts` | 所有注册了 message/entry renderer 的插件 | 历史投影路径也过一遍 renderer（磁盘不存 ANSI 是设计，但渲染器可重跑） | **部分已修**：entry（#71）与**自定义消息**（#76）已覆盖，且喂给渲染器的是与实时路径同一形状（`{role:"custom", timestamp:number}`，逐键对照 SDK `createCustomMessage`）。**仍缺**：工具块在历史路径不重跑渲染器，刷新后 edit 的 diff 预览退回原始输出（内容不丢，形态退化） |
| 6 | **`ToolRenderContext` 三个布尔写死** | `lib/sdk-session-host.ts` `buildToolRenderContext` | edit 的预览门闩就是 `context.argsComplete` | 按真实状态传（至少 `expanded` 跟工具块折叠态） | **已修（记档）**（#69）：`expanded` 已改成真实投影值；另两个恒 `true` 是**语义正确**并已注释——我们只在 start/update/end 渲染，三者都发生在「参数完整 + 已开始执行」之后 |
| 7 | `setToolsExpanded` 存了值、界面不跟着变 | `lib/web-extension-ui.ts` `setToolsExpanded` | pi-subagents 三处**都是 `set(false)`**（`extension/index.ts:737,754`、`slash/slash-commands.ts:766`） | 让工具块读这个全局态（默认仍是收起，与现状一致） | **已修**（#75）：落状态 + 序号驱动；切会话清零；默认仍收起 |
| 8 | `registerCommand` 的 `getArgumentCompletions` **零消费方**：TUI 里 `/mcp <Tab>` 会列参数 | `components/ChatInput.tsx` 参数菜单 | pi-subagents、pi-mcp-adapter（`/mcp` 的参数） | 斜杠菜单带上参数补全，或命令需要参数时给可见提示 | **已修**（#75）：服务端转发 `get_command_argument_completions`；客户端 120ms 防抖 + 请求序号 + 只替换参数区间；多行输入不参与（可见降级） |
| 9 | `ToolDefinition.label`（工具显示名）没读 | `components/MessageView.tsx` + `lib/tool-display-meta.ts` | pi-mcp-adapter（`label: "MCP: <server>"`） | 投影带上 label，标题优先用它 | **已修**（#75）：活路径与历史路径**同一来源**（扩展表，首注册者胜）；**与工具名精确相同则忽略**（内置工具的自称写法），只差大小写保留（`MCP` 是真名字） |
| 10 | `theme` 不是真 Theme：缺 `sourcePath`/`sourceInfo`，且 Proxy 把数据字段变成函数 | `lib/web-extension-ui.ts` `get theme` | 把 `ui.theme` 交给渲染器的插件 | 直接返回 `loadPiTheme()`；加载失败再退回存根，不用 Proxy 包数据字段 | **已修**（#72）：真 Theme 直接给；`theme.fg` 抛「未知颜色」与 SDK 一致；插件上色输出真 ANSI，状态条/widget 会解析 |
| 11 | `getEditorText()` 恒返回 `""` —— 宿主对扩展撒谎 | `lib/web-extension-ui.ts` `getEditorText` | pi-subagents `fleet-status.ts`（fleet 激活守卫） | 真实回传或明确提示 | **已修**（#74）：宿主注入的读取器回传**服务端草稿镜像**（`lib/composer-draft-text.ts`，零新增往返）。边界：滞后一次 PUT、按会话键共享（多标签最后写入者胜）、超 4MB 降级空串 —— 「刚清空而 PUT 未到」或别的标签写了草稿时，插件那条 `=== ""` 门槛会**不激活**（客户端那条不看盘、不受影响） |
| 12 | `onTerminalInput` 只在两个窄窗口生效，插件无从得知 | `lib/web-extension-ui.ts` `onTerminalInput`、`lib/extension-panel-keys.ts` | pi-subagents（fleet 方向键、Esc 取消）、rpiv-ask-user（折叠键） | 注册时给一次**可见**提示说明覆盖范围 | **已修**（#74）：注册时发一次 warning，逐字写明两个窗口（① widget 存在、输入框聚焦且为空时 `↓`/`←` 开局；② 已收起的面板存在时 `Esc`/`F1`–`F12`/`Alt+<字符>`/`Ctrl+<字符>`，浏览器保留组合除外）；**提示本身可水合**（#93）——否则扩展加载发生在浏览器订阅之前，这条提示永远看不到 |
| 13 | `renderShell: "self"` 未读，一律套 Pidance 卡片外壳 | `components/MessageView.tsx` `bareShell` | pi-advisor-flow `register-ask-advisor.ts`、pi-mcp-adapter | 读该字段决定是否套外壳 | **已修**（#75）：`self` 不套我们的卡片外壳（按其语义），但**只有真的渲染出行时才去壳**（否则只剩没有边框/状态色/底的空白块）；表头保留（折叠入口与耗时是我们自己的交互面） |
| 14 | overlay 句柄：`hide()` 只等于 `setHidden(true)`（TUI 是永久移除）、`focus`/`unfocus` 空实现、`getBounds()` 恒 `undefined` | `lib/web-extension-ui.ts` `overlayHandle` | `hide()` 0 处；`focus()` 仅 pi-mcp-adapter 一处；`unfocus`/`getBounds` 0 处 | 补齐或记为刻意分叉 | **已修 + 刻意分叉**（#76）：`hide()` 按 pi-tui 契约做成**永久移除**（发 `closed`、丢弃后续渲染、`isFocused()` 转假）；`focus`/`unfocus`/`getBounds` 记为分叉（Web 只有这一层面板、没有终端单元格几何） |
| 15 | `getEditorComponent()` 恒 `undefined`（即使刚 `setEditorComponent` 成功），「包裹上一个编辑器」模式断链 | `lib/web-extension-ui.ts` | 「包裹上一个编辑器」模式 | 存下工厂并回传 | **已修**（#74）：工厂值存下来并如实回传（SDK 契约 = 当前**配置的**工厂，未配置才是 undefined）；Web 仍不用它渲染输入区，`setEditorComponent` 照旧给一次降级提示 |
| 16 | `getAllThemes()`/`getTheme()` 静默返回空（与 `setTheme` 的明确错误不一致） | `lib/web-extension-ui.ts` | 无插件用 | 已改成一次性 warning | **已修** |
| 17 | widget 组件的 `handleMouse` 永不调用、`move/drag/wheel` 不转发 | `lib/web-extension-ui.ts`（`setWidget` 的组件工厂）+ `lib/extension-widget-mouse.ts` | pi-subagents（第 0 行左键把**整块**在「一行摘要/全列表」间切换） | 按 widget key 调该组件的 `handleMouse`（局部字符坐标） | **已修**（#103）：卡片**正文区**的点击按与 custom 面板同一套换算转发（`extension_ui_widget_mouse`，坐标原点在正文区）；**卡片头（折叠按钮）始终归我们的外壳**；只有组件真的实现 `handleMouse` 时才带 `interactive: true`（字符串数组 widget 永远不可交互），前端据它决定是否为点击付一次往返；量不出字符宽/行高时这一次不转发。触摸：tap → 左键、长按 → 右键、滑动与被系统取消的手势都不转发（补发的 click 一律吃掉）。**仍保留的分叉**：`move`/`drag`/`wheel` 不转发 |
| 18 | `tui.stop()/start()` 是 no-op（无 warning） | `lib/custom-ui-terminal.ts` `onUnsupported` | rpiv-ask-user `state/external-editor.ts`（Ctrl+G 外部编辑器） | 不做真「让出终端」，但要给一次可见失败 | **已修**（#76）：每个实例报一次（不刷屏），调用方能看到「Web 端不支持让出终端」 |
| 19 | `setTitle` 30s 后静默回落项目名 | `lib/window-title.ts` + `components/AppShell.tsx` | 无插件用 | 保持到切会话或下次 `setTitle` | **已修**（#76）：删掉 TTL（TUI 没有到期）；覆盖按**会话键**作废（只比 base 不够——同项目两个会话 base 相同会串）。已知差异：同会话**改名**不会清掉插件标题，只记录不实现 |
| 20 | `registerShortcut` 无落点 | `lib/extension-shortcuts.ts` + `hooks/useExtensionShortcuts.ts` + `lib/sdk-session-host.ts` | pi-subagents 仅当用户配置了 `foregroundDetachShortcut` | 绑定并给出不可用原因 | **已修**（#105）：宿主把**有效键位**（pi-tui 默认键位 + 用户 `keybindings.json`，含保留键位的旧名）交给 SDK 的 `getShortcuts`，于是 TUI 那四条冲突语义真的生效 —— 保留键位的注册被跳过、非保留内置键位被插件覆盖、同键后者胜，诊断原文进设置清单；被跳过的注册仍然列出来（标 `sdk-conflict`），`run_extension_shortcut` 拒绝执行不可用与未命中的键。客户端只绑可用键（冒泡阶段，且壳已 `defaultPrevented` 的键直接跳过），命中后把**键名**发回服务端执行（handler 要的是完整扩展 ctx）。**三处如实记录的取舍**：① 不可绑的键**不改键**，只在清单里写原因（浏览器保留 / 壳占用 / 与打字冲突 / 与保留快捷键冲突）；② SDK 的 `app.*` 默认键位没从包入口导出，本项目不复制那张表（平台条件值必然漂移），它们的默认键由我们自己的表拒掉、并有用例对着 SDK 源码守住；③ 插件把面板**收起**时，面板自己的按键窗口优先于插件快捷键 —— 与 TUI 一致（pi-tui 先把输入给扩展的全局监听、消费掉才轮到编辑器上的快捷键），清单里有一句提示 |
| 21 | `registerMarkdownTransformer` 无消费方 | — | 已装插件 0 注册 | **已修**（issue #106） | 两条渲染边界（投影 + 流式）都跑转换器；链只取磁盘来源、失效通知活宿主；mermaid 链首与**分块粒度**两处有意分叉（见 `docs/ui-vs-tui.md`） |
| 22 | `Image` 组件 / 终端图片协议无落点 | `lib/custom-ui-terminal.ts` 恒 `kittyProtocolActive: false` | 已装插件 0 使用 | 待评估 | **暂缓**（#76 核实：0 命中） |
| 23 | 对话框没有 countdown（`timeout` 只在服务端自结算） | `components/ExtensionDialog.tsx` | 已装插件无带 `timeout` 的调用 | 低 | **暂缓**（#76 核实：0 处传 `timeout`；到期已能正常关闭，缺的只是倒计时显示） |

---

## 二、违反规则 3：为个别插件写的显示优化

| # | 位置 | 问题 | 修法 | 状态 |
|---|------|------|------|------|
| 1 | `components/ChatWindow.tsx` | `widget.key === "subagent-fleet-status"` 才做行改写 —— 按插件 key 闸门 | 已去掉闸门（`rewriteFleetStatusLines` 本身按形状自检） | 已修 |
| 2 | `components/ChatWindow.tsx` | `/todo/i.test(widget.key)` 按 key 猜语义以抑制内置 Todo 镜像 | 存疑：是命名约定启发式、无更通用信号。**暂时保留**，记录为未公开契约 | 刻意分叉 |

已合规：widget 标题 / 自定义消息标题统一走 `lib/extension-labels.ts`；折叠与卡片壳只有一处实现（`ExtensionWidgets` 的槽位外壳，折叠状态存 `pidance.collapsedWidgetKeys.v1`）。

---

## 三、违反规则 4：复制了 Pi 语义（会漂移）

### P0

| # | 位置 | 问题 | 修法 | 状态 |
|---|------|------|------|------|
| 1 | `lib/pi-themes/dark.json` | vendored 主题副本落后于 0.87.0（缺 `scrollbarTrack`/`scrollbarThumb`/`searchMatchBg`/`searchMatchText`）。**不会抛错**（构造器有回退），漂的是颜色值 | 与 SDK 版本同批更新副本 + 加「副本与安装版一致」的校验测试 | **已修**（#73）：补齐四个键 + `lib/pi-themes.test.mjs` 断言键集/逐键值/vars/导出 |
| 2 | `lib/session-metadata-cache.ts` | `session_info` 空名不视为清除（SDK 明确「Empty names explicitly clear」）→ 侧栏与 SDK 给出两个会话名 | 对齐 SDK 语义 | **已修**（#73）：最新 `session_info` 恒胜，空名视为显式清除 |

### P1

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| 3 | `lib/thinking-levels.ts` | 改写 SDK model 的 `thinkingLevelMap`：省略的 `xhigh`/`max` 在 Pidance 算可用并补成恒等映射，与 Pi 的钳档相反（**多显示**，不是少显示） | 刻意分叉（记在规则 4 这节） |
| 4 | `lib/session-reader.ts` 的压缩可见集 | 压缩可见集不截断（有意分叉：多显示历史）。**张力**：必须继续写成显示分叉，不能写成「跟 SDK 一致」——同文件注释曾声称「activity 跟随 SDK 可见集」，是假的 | **已修（注释）**（#73）：注释按实情改写 |
| 5 | `lib/session-reader.ts` | `context_edit` 未应用（0.87 起 SDK 会写，TUI 显示替换后内容） | **已修**（#73）：`collectContextEdits`/`applyContextEdit`（同 targetId 最后写者胜、`replacement === null` 省略该条目、字符串替换折叠成一段文本）；并修掉「`context_edit` 自身成为 leaf 后被上溯跳过」的可见性 bug |
| 6 | `lib/session-reader.ts` 的 `getSessionContextSettingsLocal` | 当前模型/供应商：`model_change` 压过 assistant 上报，SDK 是「最后写者胜」 | **已修**（#73）：改为最后写者胜 |
| 7 | 树导航（`select_leaf_exact`/`branch_from_assistant`） | 绕过 SDK 的 `session_before_tree`/`session_tree` 扩展事件 | **已修**（#90）：live writer 落地 + 保序派发（before 可取消、取消即零改动；tree 在改动后、runner 未失效时派发）。受 SDK 约束：`dispose()` 会 `invalidate` 扩展 ctx，所以顺序必须是 before → 用本会话 writer 写 → tree → 再交接。另修：导航期间挂上 Pi 的并发闸门（`isCompacting`），事件目标用**落地后的 leaf** 而不是 assistant id |
| 8 | `lib/session-metadata-cache.ts` | `modified` 只认 user 消息（产品决策，SDK 认 user+assistant） | 刻意分叉 |
| 9 | `lib/session-metadata-cache.ts` | 全量会话扫描曾接受项目目录里的符号链接 `.jsonl`，而有界定位（`resolveSessionPath`）是 realpath 有界的——两者口径不一致 | **已修**（#85）：扫描跳过 realpath 逃出会话根之外/无法解析的链接；常规文件零额外成本 |

---

## 四、文档

`docs/ui-vs-tui.md` 逐条按现行代码维护（含 #69–#93 的语义变化：工具块折叠行规则、`theme` 与 ANSI、`focusedComponent` 注入、`getEditorText` 草稿镜像及其**已知副作用**、`onTerminalInput` 的两个窗口、overlay `hide()`、`setTitle` 会话键、能力提示可水合）。本节此前列的四处过期描述已更正。

---

## 已定的取舍

- **`terminal.rows` 报前端真实视口行数**（不是给一个大值把裁切留给面板滚动）：
  与 TUI 语义一致（终端的 `rows` 就是真实高度，插件按它布局/裁切是它的正常行为），
  且 `columns` 已是真实值，两个维度不该一真一假。
- **`showImages: false`**：合规分叉。SDK 里它的含义是「TUI 是否内联图片」，headless 终端没有
  Kitty/iTerm2；工具结果里的图片仍由 `MessageMediaGallery` 画出，不靠这个标志。
- **压缩可见集不截断**：合规分叉（多显示历史），注释已如实。
- **插件渲染器失败一律「不显示」而不是贴异常文本**（#71）：把 `[customType] renderer failed`
  这类诊断贴进时间线，等于把插件私有载荷当正文，违反本清单的出发点。**例外**：宿主自身配置
  错误（例如 SDK 全局 theme 未初始化导致内置渲染器抛错）给**一次**可见警告——那是我们的 bug，
  不是插件的问题。
- **扩展能力提示不重放插件自己的 `notify`**（#93）：只重放宿主自己发的能力提示（否则插件通知
  每次开页面都会重弹）。客户端按 id 认领，**关掉就不再回来**；整页刷新后允许再显示一次。
