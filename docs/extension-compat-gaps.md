# 扩展兼容缺口清单

判定规则见 `AGENTS.md`「产品原则」：**兼容优先，优化必须通用**。
（公开仓版本见 README 中英两版的「设计原则」。）

本清单来自一次全量排查：对照 SDK 的 `ExtensionUIContext` 全量成员、pi-tui 的显示面
与 `docs/tui.md`/`docs/extensions.md`，再对着已装插件（`~/.pi/agent/npm/node_modules/`
下的 pi-subagents、pi-mcp-adapter、rpiv-*、pi-advisor-flow 等）的实际调用确认可达性。
**只列缺口与违规**，已实现的不列。

状态：`待修` / `已修` / `刻意分叉`（产品决定，不再改）。

---

## 一、违反规则 1：原生 TUI 有的内容，Pidance 没有且静默

按「已装插件真的在用」× 影响面排序。

| # | 缺口 | 位置 | 谁在用 | 修法方向 | 状态 |
|---|------|------|--------|---------|------|
| 1 | `registerEntryRenderer` **完全没有支持**（`getEntryRenderer` 零消费方），插件自定义 entry 静默消失 | `lib/session-reader.ts:1032-1041` 丢弃未知 customType | pi-subagents（supervisor reply、watchdog 警告）、pi-advisor-flow（scout 结果） | 像 `getMessageRenderer` 一样取 renderer → headless 渲染成行 → 新投影字段；失败再回退「不显示」。**不要为 customType 硬编码** | 待修 |
| 2 | 工具渲染上下文的 `invalidate()` 是空实现，插件渲染器的异步刷新路径永不触发 | `lib/sdk-session-host.ts` `buildToolRenderContext` | SDK 内置 edit 工具、pi-subagents widget | 已接上「重渲该 toolCallId 并推 `rendered_lines_update`」（与宽度变化同一条通路） | 已修 |
| 3 | `theme` Proxy 对未知属性一律返回透传函数 → `theme.name` 得到函数、`theme.getThinkingBorderColor("high")` 得到字符串、`theme.getColorMode()` 得到 `""`，调用即 TypeError（被渲染桥 try/catch 吞成回退原文） | `lib/web-extension-ui.ts` 的 `get theme` | 任何把 `ui.theme` 交给渲染器的插件 | 已按真 `Theme` 接口逐成员给出：`name`/`getColorMode`/`getFgAnsi`/`getBgAnsi`/`getThinkingBorderColor`/`getBashModeBorderColor` + 全部样式方法 | 已修 |
| 4 | `ToolDefinition.label`（工具显示名）完全没读，工具块标题用工具名首字母大写 | `components/MessageView.tsx:955-958` | pi-mcp-adapter（`label: "MCP: <server>"`） | 投影里带上 label，标题优先用它 | 待修 |
| 5 | `tui.terminal.columns/rows` 尺寸是旧值或常量，与 `render(width)` 的参数自相矛盾 | `lib/custom-ui-terminal.ts` + `lib/web-extension-ui.ts` + `lib/sdk-session-host.ts` | rpiv-ask-user（`build-questionnaire.ts`、`dialog-builder.ts` 在渲染时读它）；pi-subagents（`fleet.ts` 按 `rows` 裁详情视口，**裁掉的行不在输出里**） | 两个维度都是 getter：前端按可用宽高上报（`set_render_size`，行数此前是常量 40），`setRenderSize` 后插件在同一次 `render` 里读到的就是新值 | 已修 |
| 6 | `setToolsExpanded` 存了值、界面不跟着变 | `lib/web-extension-ui.ts:686` | pi-subagents（三处：跑子代理前收起工具块） | 让工具块读这个全局态（默认值仍是收起，与现状一致） | 待修 |
| 7 | `getEditorText()` 恒返回 `""` —— 宿主对扩展撒谎 | `lib/web-extension-ui.ts` 的 `getEditorText` | pi-subagents（fleet 激活键的守卫） | **已修**（issue #74）：回传宿主注入的读取器读到的**服务端草稿镜像**（`lib/composer-draft-text.ts`，零新增往返）。语义边界：滞后（400ms 防抖）、按会话键共享（多标签最后写入者胜出）、超 4MB 降级空串 —— 所以「用户刚清空而 PUT 未到」或别的标签写了草稿时，插件那条 `=== ""` 门槛会**不激活**（客户端那条门槛不看盘、不受影响） | 已修 |
| 8 | `onTerminalInput` 只在两个窄窗口生效，插件无从得知 | `lib/web-extension-ui.ts` 的 `onTerminalInput`、`lib/extension-panel-keys.ts:32-48` | pi-subagents（fleet 方向键激活、Esc 取消）、rpiv-ask-user（折叠键，已覆盖） | **已修**（issue #74）：注册时发一次可见 warning（`notifyLimitedSupport`），逐字写明窗口——① widget 存在且输入框聚焦且为空时 `↓`/`←` 开局、之后导航键才路由；② 已收起的面板存在时 `Esc`/`F1`–`F12`/`Alt+<字符>`/`Ctrl+<字符>`（浏览器保留组合与 `Ctrl+Space` 除外）路由；普通打字到不了 | 已修 |
| 9 | `showImages` 恒 `false` | `lib/sdk-session-host.ts` `buildToolRenderContext` | 渲染器里判断终端支持图片的插件 | **刻意分叉**：headless 终端确实不支持 Kitty/iTerm2 协议，`false` 是如实声明宿主能力，插件据此走文字降级是正确行为 | 刻意分叉 |
| 10 | `ToolDefinition.renderShell: "self"` 未读，一律套 Pidance 卡片外壳 | 全仓库无命中 | pi-advisor-flow、pi-mcp-adapter | 读该字段决定是否套外壳 | 待修 |
| 11 | overlay 句柄：`hide()` 只等于 `setHidden(true)`（TUI 是永久移除）、`focus`/`unfocus` 空实现、`getBounds()` 恒 `undefined` | `lib/web-extension-ui.ts:566-575` | 已装插件只用 `setHidden` | 补齐语义或注记为刻意分叉 | 待修 |
| 12 | `getEditorComponent()` 恒 `undefined`（即使刚 `setEditorComponent` 成功） | `lib/web-extension-ui.ts` 的 `setEditorComponent`/`getEditorComponent` | 「包裹上一个编辑器」模式 | **已修**（issue #74）：工厂值存下来并如实回传（SDK 契约是「当前**配置的**工厂」，未配置才是 undefined）；Web 仍不用它渲染输入区，所以 `setEditorComponent` 照旧给一次降级提示、`undefined` 恢复默认且不提示 | 已修 |
| 13 | `getAllThemes()` 恒 `[]`、`getTheme()` 恒 `undefined`（`setTheme` 却有明确返回值，半个能力静默） | `lib/web-extension-ui.ts` | 已装插件 0 命中 | 已改成与 `setTheme` 一致的可见降级（一次性 warning，仍返回空/undefined） | 已修 |
| 14 | `tui.focusedComponent` 恒 `undefined` | `lib/custom-ui-terminal.ts` | pi-subagents（`fleet-status.ts:968`） | **刻意分叉**：消费者是方向键激活，而方向键刻意不路由（保输入框） | 刻意分叉 |
| 15 | `tui.stop()/start()` 是 no-op，插件的外部编辑器会在服务端 spawn（stdio inherit 非 tty） | `lib/custom-ui-terminal.ts:40-41` | rpiv-ask-user（Ctrl+G） | **刻意分叉**：Web 没有「让出终端」的等价语义；补一次可见提示即可 | 刻意分叉 |
| 16 | `tui.focusedComponent`/`handleMouse`：widget 组件的鼠标事件永不调用（`inputCustomMouse` 只查 custom 面板）、move/drag/wheel 不转发 | `lib/web-extension-ui.ts:718-722` | pi-subagents（widget 点标题行折叠） | Web 侧已用共用卡片头做同义交互 → 体验不丢；组件级鼠标仍是缺口 | 待修（低） |
| 17 | `setTitle` 30s 后静默回落项目名 | `lib/window-title.ts:15` | 无插件用 | 注记为刻意分叉（避免插件名永久占标题） | 刻意分叉 |
| 18 | `registerShortcut` 无落点 | — | pi-subagents（仅当用户配置了 `foregroundDetachShortcut`） | 待评估（Web 键位体系是自有的） | 待修（低） |
| 21 | `registerCommand` 的 `getArgumentCompletions` **零消费方**：插件的命令参数补全（TUI 里 `/mcp <Tab>` 会列参数）在 Web 里没有 | 全仓库无命中（slash 菜单只列命令名） | 任何带参数的命令（pi-mcp-adapter 的 `/mcp setup` 等） | 命令列表里带上参数补全，或至少在命令需要参数时给可见提示 | 待修 |
| 19 | `registerMarkdownTransformer` 无消费方 | — | 已装插件 0 注册 | 待评估 | 待修（低） |
| 20 | `Image` 组件 / 终端图片协议无落点（headless 终端恒 `kittyProtocolActive: false`） | `lib/custom-ui-terminal.ts:7,34` | 已装插件 0 使用 | 待评估 | 待修（低） |

---

## 二、违反规则 3：为个别插件写的显示优化

| # | 位置 | 问题 | 修法 | 状态 |
|---|------|------|------|------|
| 1 | `components/ChatWindow.tsx` | `widget.key === "subagent-fleet-status"` 才做行改写 —— 按插件 key 闸门 | 已去掉闸门：`rewriteFleetStatusLines` 本身按形状自检（认不出返回 `null`），对所有 widget 都调用 | 已修 |
| 2 | `components/ChatWindow.tsx:546` | `/todo/i.test(widget.key)` 按 key 猜语义以抑制内置 Todo 镜像 | 存疑：是命名约定启发式而非插件名硬编码，且没有更通用的信号。**暂时保留**，记录为未公开契约 | 刻意分叉 |

已合规（不再有特例）：widget 标题 / 自定义消息标题统一走 `lib/extension-labels.ts` 的
`humanizeExtensionIdentifier`；折叠与卡片壳是槽位外壳唯一的实现。

---

## 三、违反规则 4：复制了 Pi 语义（会漂移）

### P0 —— 已经在漂移

| # | 位置 | 问题 | 修法 | 状态 |
|---|------|------|------|------|
| 1 | `lib/pi-themes/dark.json` | vendored 主题副本与 0.87.0 安装版的 `theme/dark.json` 不一致（新版多 `scrollbarTrack`/`scrollbarThumb`/`searchMatchBg`/`searchMatchText`）→ 插件 `theme.fg("...")` 取新键失败 | 与 SDK 版本同批更新副本，并加一条「副本与安装版一致」的校验测试 | 待修 |
| 2 | `lib/session-metadata-cache.ts:279-283` | `session_info` 空名不视为清除（SDK 明确「Empty names explicitly clear」）→ 侧栏与 SDK 给出两个会话名 | 对齐 SDK 语义 | 待修 |

### P1 —— 结构上必然漂移

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| 3 | `lib/session-reader.ts:778-780` | 压缩可见集不截断（有意分叉）；SDK 改压缩语义时 Web 与 TUI 历史会不同 | 刻意分叉（记得跟 SDK） |
| 4 | `lib/session-reader.ts:576-580` | `context_edit` 未应用（0.87 起 SDK 会写，TUI 显示替换后内容） | 待修 |
| 5 | `lib/session-reader.ts:782-806` | 当前模型/供应商：`model_change` 压过 assistant 上报，SDK 是「最后写者胜」 | 待修 |
| 6 | `lib/session-service.ts:1293-1380` | 离线分支（`select_leaf_exact`/`branch_from_assistant`）绕过 SDK 的 `session_before_tree`/`session_tree` 扩展事件 | 待修（要评估） |
| 7 | `lib/session-metadata-cache.ts:240-252` | `modified` 只认 user 消息（产品决策，SDK 认 user+assistant） | 刻意分叉 |

---

## 四、文档过期（会误导后来人）

| 位置 | 现状 | 状态 |
|------|------|------|
| `docs/ui-vs-tui.md` §5.9 | 说 `setWorkingMessage`/`Visible`/`Indicator` 是「发 warning」，实际已实现 | 已修 |
| `docs/ui-vs-tui.md` §5.7 | 说「服务端调组件 `handleMouse`（pi-subagents 的 widget 用 `y===0` 折叠）」—— 该 widget 走 `setWidget` 工厂，收不到鼠标 | 已修 |
| `docs/ui-vs-tui.md` §3 `setTitle` 行 | 仍写「AppShell 的 MutationObserver 冲突（#50）」，实际已改为 30s 覆盖 | 已修 |
| `docs/ui-vs-tui.md:172` | 说自定义消息「不露出内部 customType」，实际已改为通用美化 | 已修 |
