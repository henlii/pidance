# 界面分区：Pidance Web 与 Pi TUI 对照

这份文档回答一个问题：**同一个 Pi 会话，在终端（TUI）和 Pidance（Web / 手机 / Electron 壳）里分别长什么样、哪些部件一一对应、哪些是刻意分叉。**

用途有两个：

1. 改界面时先看这里，避免“同一处语义只改了一个面”。
2. 改完回来更新对应小节（见文末《维护清单》）。

> 事实来源：`components/`（Web 实现）、`lib/extension-ui-bridge.ts` 与 `lib/web-extension-ui.ts`（扩展 UI 槽位投影）、`lib/tui-render-bridge.ts`（TUI 组件无头渲染）、Pi SDK 文档 `docs/extensions.md`（`ExtensionUIContext` 槽位定义）。文档里的行号会漂，以文件与函数名为准。

---

## 1. 三个产品面

| 面 | 加载方式 | 与服务端关系 |
|---|---|---|
| 桌面浏览器 | 直接开 Pidance 页面 | 同一份 Web 代码，宽视口布局 |
| 手机浏览器 | 同一页面，≤640px 走抽屉布局 | 同一份代码，`useIsMobile()` 分叉 |
| 桌面壳（Electron，Windows） | 壳内 `BrowserWindow` 加载本机 Pidance（只连 31415） | 不重写渲染，只加托盘/通知/更新 |

会话、SSE、队列、压缩、工具执行这些**语义全在服务端与 Pi SDK**，三面共享；差异只在“怎么显示、怎么点”。因此本对照表按**显示部件**列，不按面列。

---

## 2. 布局对比图

### 2.1 Pi TUI（终端）

```text
┌────────────────────────────────────────────────────────────┐
│ header：会话/模型/工作目录/状态摘要（扩展可 setHeader）      │
├────────────────────────────────────────────────────────────┤
│ 会话内容（从上到下按时间）                                  │
│   user 输入                                                 │
│   assistant 正文 / thinking 块                              │
│   工具调用块（含子代理、bash、读写文件…，可展开）             │
│   压缩摘要 / 分支摘要                                       │
├────────────────────────────────────────────────────────────┤
│ aboveEditor widget（扩展，默认放这里）← pi-subagents 异步面板 │
│ 队列消息（queued / follow-up）                              │
│ ┌─ editor：输入框（多行，slash/@ 补全）───────────────────┐ │
│ └────────────────────────────────────────────────────────┘ │
│ belowEditor widget（扩展）                                  │
│ footer：状态条（扩展 setStatus）+ 快捷键提示                 │
└────────────────────────────────────────────────────────────┘
模态：dialog（select/confirm/input/editor）、custom 面板（整屏替换）
```

### 2.2 Pidance Web（桌面，≥641px）

```text
┌──────────┬───────────────────────────────────┬─────────────────────────┐
│ 侧栏      │ 聊天主区                           │ 右栏工作区（可关）        │
│          │ ┌───────────────────────────────┐ │ 导航轨道（44px 常驻）     │
│ 最近会话  │ │ 顶栏：谱系面包屑 + 统计/模型    │ │  文件 / Git / 分支 /     │
│ 置顶会话  │ ├───────────────────────────────┤ │  会话信息 / 终端         │
│ 项目区    │ │ 消息区（同 TUI 时间序）        │ ├─────────────────────────┤
│  ├ 项目A  │ │  · user / assistant / thinking │ │ 一级面板内容             │
│  │  ├会话 │ │  · 工具块（可折叠 process）    │ │ （文件树 / Git 变更 /     │
│  │  └子会话│ │  · 压缩 / 分支摘要             │ │  分支树 / 会话信息 / PTY）│
│  ├ 项目B  │ │                                │ │                         │
│  └ 未分组 │ ├───────────────────────────────┤ ├─────────────────────────┤
│          │ │ notice shelf（通知/活动）      │ │ 二级面板：文件详情 / diff │
│          │ │ todo 面板（rpiv-todo 镜像）    │ │ （打开文件时出现）        │
│          │ │ aboveEditor widget（扩展）     │ │                         │
│          │ │ 队列消息                       │ │                         │
│          │ │ ┌─ 输入区 ───────────────────┐ │ │                         │
│          │ │ └────────────────────────────┘ │ │                         │
│          │ │ belowEditor widget + 状态条    │ │                         │
│          │ │ footer（模型/思考/上下文/速率）│ │                         │
│          │ └───────────────────────────────┘ │                         │
└──────────┴───────────────────────────────────┴─────────────────────────┘
模态：ExtensionDialog（扩展 dialog/select/confirm/input/editor）、
      ExtensionCustomPanel（扩展 custom 面板）、ViewportDialog（自研弹窗）
```

### 2.3 Pidance Web（手机，≤640px）

```text
┌──────────────────────────────┐   抽屉（全屏覆盖，同一份组件）：
│ 顶栏：项目名 + 会话信息 + 面板开关 │   侧栏 drawer   ← 左滑
├──────────────────────────────┤   右栏 workspace ← 面板开关
│ 消息区（同上）                 │   二级面板（文件详情/diff）固定全屏，盖在右栏之上
│ notice / todo / widget        │
│ 队列                          │
│ ┌─ 输入区 ──────────────────┐ │
│ └───────────────────────────┘ │
│ belowEditor widget + footer   │
└──────────────────────────────┘
```

手机端不是另一套客户端：侧栏与右栏变成 `position: fixed` 抽屉（`app/globals.css` 的 ≤640px 段），二级面板成为全屏层（`z-index: 300`，盖在右栏之上）。

---

## 3. 区域对照表

| TUI 分区 / 概念 | Pidance 落点 | 实现位置 | 差异 |
|---|---|---|---|
| header（会话/模型/目录） | 顶栏谱系面包屑 + 统计按钮 | `components/SessionLineage.tsx`、`components/AppShell.tsx` | Web 把“当前会话在树里的位置”做成可点的下拉（子会话导航），TUI 无等价物 |
| 会话内容时间序 | 消息区 | `components/ChatWindow.tsx`、`components/MessageView.tsx` | 同序；Web 增加了滚动锚定/自动跟随 |
| thinking 块 | assistant 块内的折叠段 | `components/MessageView.tsx`、`lib/thinking-content.ts` | 同 |
| 工具调用块 | 过程分组（process group，可折叠） | `components/ChatWindow.tsx`（`ProcessDetailsGroup`）、`lib/message-display.ts` | Web 按“一轮”分组，TUI 按事件平铺 |
| 压缩/分支摘要 | 独立系统块 | `lib/chat-compositor.ts`、`lib/session-activity.ts` | 同 |
| editor（输入框） | 输入区 | `components/ChatInput.tsx` | TUI 键位；Web 按钮 + slash/@ 菜单 + 附件 |
| aboveEditor widget | 输入框**上方**卡片 | `components/ChatWindow.tsx`（`ExtensionWidgets`，placement ≠ belowEditor） | 见 §5（含 pi-subagents 案例） |
| belowEditor widget | 输入框**下方**卡片 | 同上（placement === belowEditor） | 同 |
| footer 状态条（`setStatus`） | 输入框下方状态条 | `lib/extension-ui-bridge.ts`（statuses）、`components/ChatWindow.tsx` | 同 |
| footer（快捷键提示） | footer 右侧读数（模型/思考/上下文/速率） | `components/AppShell.tsx`、`components/ChatWindow.tsx` | Web 显示实时读数，不显示键位 |
| 队列消息 | 输入框上方队列块 | `lib/queue-state.ts`、`components/ChatWindow.tsx` | 同；Web 有 flush/steer 按钮 |
| dialog（select/confirm/input/editor） | `ExtensionDialog` 模态 | `components/ExtensionDialog.tsx`、`lib/extension-ui-bridge.ts` | 同 |
| custom 面板（整屏替换） | `ExtensionCustomPanel` | `components/ExtensionCustomPanel.tsx` | 同；Web 面板可滚动、可关闭 |
| notify | notice shelf | `components/ChatWindow.tsx`（同文件内 `NoticeShelf`）、`lib/notice-reducer.ts` | Web 支持钉住/堆叠/错误分类 |
| `setTitle` | 浏览器标签标题 | `hooks/useAgentSession.ts` ↔ `components/AppShell.tsx` | **冲突**：AppShell 的 MutationObserver 会把标题拉回项目名（见 #50） |
| `setEditorText` | 光标处插入文本 | `hooks/useAgentSession.ts` | 同 |
| todo（rpiv-todo 面板） | todo 面板 | `components/ChatWindow.tsx`、`lib/todo-parser.ts` | 扩展已提供 todo widget 时隐藏内置镜像，避免双份 |
| 子代理（pi-subagents） | 侧栏运行中徽标 + 顶栏谱系下拉 + 消息区工具块 | `components/SessionSidebar.tsx`、`components/SessionLineage.tsx`、`lib/subagent-*` | Web 侧栏**隐藏**子代理会话，导航靠谱系下拉（TUI 里它们是普通会话） |
| 分支（库内）+ fork | 同一套谱系/工具块 | `lib/session-navigation-store.ts`、`components/session-tree.ts` | 同 |
| Git 变更 | 右栏「Git 更改」面板 + 文件 diff | `components/RightPanel.tsx`、`components/ChangesPanel.tsx`、`components/FileViewer.tsx` | Web 专属（TUI 只有 bash/git 命令输出） |
| 文件浏览/编辑 | 右栏「文件」面板 + 二级面板编辑 | 同上 | Web 专属 |
| 用户 PTY 终端 | 右栏「终端」（xterm + WS） | `components/TerminalPanel.tsx`、`app/api/pty/` | Web 专属 |
| 设置 / 关于 / 更新 | `SettingsView`、`AboutDialog`、`UpdateBanner` | `components/SettingsView.tsx` 等 | Web 专属入口 |

---

## 4. 状态呈现对照

| 状态 | TUI | Pidance Web | 权威来源 |
|---|---|---|---|
| 正在运行 | footer/状态条 + 工具块动效 | 侧栏会话行运行圆点 + 实时计时、顶栏统计 | `/api/agent/running` + SSE（本进程 starting ∪ isRunning） |
| 有子代理在跑 | 子代理 widget | 父会话行运行中 + 谱系下拉里子会话行运行中与计时 | `/api/subagent-runs`（`runningChildIds` → 父会话 id） |
| 未读 | —（终端无此概念） | 会话行未读点（`completedAt > readAt`） | 服务端 running 集合的真实移除 |
| 队列 | 队列块 | 队列块（可 flush / steer） | `lib/queue-state.ts` |
| 压缩 | 压缩事件行 + 状态 | 压缩块 + 顶栏状态 | SDK `compaction_*` 事件 |
| 上下文用量/速率/成本 | footer 读数 | 顶栏 + footer + 会话信息面板 | host 状态投影 |
| 扩展状态条 | footer `setStatus` | 输入框下方状态条 | `extension_ui_request: setStatus` |
| 扩展 widget | editor 上/下方 | 输入框上/下方 | `setWidget(key, content, {placement})` |

---

## 5. 扩展 UI 槽位：现状与已知缺口

Pidance 的适配器（`lib/web-extension-ui.ts`）把 Pi 的 `ExtensionUIContext` 投影成 SSE 上的 `extension_ui_request`，再由 `lib/extension-ui-bridge.ts` 落到 UI。几个已知事实：

1. **widget 的 placement**：缺省按 `aboveEditor` 处理（与 Pi 默认一致），所以扩展不写 placement 时，Web 就会把它渲染在**输入框上方**。
2. **组件工厂形式**（`setWidget(key, (tui, theme) => Component)`）：Pidance 走 `lib/tui-render-bridge.ts` 无头渲染成 ANSI 行，再当文本渲染。这是**快照式**的：工厂自身的 state/invalidate 驱动的实时重绘不支持；渲染失败会静默跳过（不设置、不 emit）。
3. **`mode === "rpc"` 快照已解码**：pi-subagents 在检测到宿主是 rpc 模式时，发的是同一份数据的一行快照
   `PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot",…}`（见其 `src/tui/render.ts` 与 `src/runs/background/async-status-snapshot.ts`）。
   Pidance 现在在 `lib/subagent-async-widget.ts` 里解析它，并**按 TUI 的行结构**渲染成 `components/SubagentAsyncWidget.tsx`：
   标题 `异步子代理 <agent> · 后台`（多个 run 时是 `异步子代理`），每行 = 状态字形（●/◦/✓/■/✗，颜色同 TUI 的 accent/success/warning/error）＋ label ＋ 状态 ＋ 已用时长 ＋ `⎿ 当前工具 工具时长 · N 轮 · N 次工具`；位置仍是输入框上方（TUI 的 aboveEditor 语义）。
   有意不搬的：终端键位提示（`↓/← to inspect`）——Web 里换成面板自身折叠，子会话导航在顶栏谱系下拉。
   解析失败时**不显示原始载荷**（宁可空着，也不把 JSON 糊到界面上）。
   子代理全部结束后 pi-subagents 会 `setWidget(key, undefined)`，面板消失。
4. **仍存在的差异**：
   - `subagent-fleet-status`（placement `belowEditor`）是 TUI 组件，经渲染桥转成文本，里面的 `↓/← to inspect` 是终端键位。Web 侧现在改写这行：去掉键位提示段，保留 agent 数与 token 读数（`rewriteFleetStatusLines`）；整行只剩提示时不渲染该 widget。
   - ~~新开页面拿不到已存在的 widget~~ **已核实不是问题**：widget 会随状态水合（`/api/sessions/<id>/state` 的 `state.extensionWidgets`）在打开会话时出现。此前判定「拿不到」是探针口径造成的误判——探针找的是 widget 卡片的折叠按钮，而 `subagent-async` 在 01a1086 之后改由专用面板渲染，已经没有折叠按钮了。
4. **状态条与 widget 不区分“谁提供”**：Web 侧只按 key 渲染与折叠（折叠状态存 `localStorage` 的 `pidance.collapsedWidgetKeys.v1`）。
5. **阻塞弹窗（`ExtensionDialog`）的按钮与可读性由 Web 侧定**：协议只传 `title` / `options` / `placeholder` 这类纯文本字段，插件无法定制样式与按钮。现状：
   - 按钮按 `method` 固定：`select` 只有底部「取消」；`input`/`editor` 是「取消 + 提交」；`confirm` 是「取消 + 确认」。**`select` 不再渲染右上「关闭」**——它与「取消」发的是同一个 `cancelled` 响应（并且会中止这次执行），并排两个等价按钮只会让人以为「关闭」是温和的那个。
   - 「取消」的语义不止关窗：`hooks/useAgentSession.ts` 在 cancelled 之后若 agent 仍在跑会补发 `abort`（对齐 OpenChamber）。
   - **长提问可滚**：扩展经常把 preview / 说明折进 `title`，所以标题本身就是内容区（`.extension-panel-title`，`max-height: min(30vh, 240px); overflow-y: auto`）；正文（选项等）在 `.extension-panel-body` 里滚动。
   - **展开/收回**：header 有「展开 / 收回」开关（`ExtensionPanelChrome` 的本地 state，不跨请求记忆）。展开同时抬高面板与提问区的上限（`.extension-panel-shell--expanded`，桌面 `min(78vh, 900px)` / 窄屏 `calc(100dvh - 96px - 安全区)`，提问区 60vh / 窄屏 56vh）——**只抬面板不抬提问区等于没解决「问题显示不全」**，这条改动两侧必须成对。
   - 验收：`/tmp` 下的临时脚本 `extension-panel-readability.mjs`（CDP 拦截 `/state` 注入 `pendingExtensionRequests`，桌面 1280x900 + 窄屏 390x844 各 10 项）与单测 `components/ExtensionDialog.test.mjs` 的 CSS 契约。

---

## 6. 刻意分叉（不要“对齐”掉）

| 分叉 | 原因 |
|---|---|
| 侧栏项目树 / 未分组会话区 | Web 专属导航面；项目 = 目录，一对一；项目区只列项目列表，其余会话（从未加入过项目的目录、关闭项目后留下的）归底部未分组区，最近/置顶/全文/归档不再按目录过滤（#53） |
| 顶栏谱系下拉（子会话导航） | 侧栏刻意隐藏子代理会话，页头下拉是它们唯一的入口 |
| 文件 / Git / 终端 / 设置面板 | 终端里由命令与其输出承担，Web 做成了面板 |
| 手机抽屉与安全区适配 | 窄视口下三栏并排不可用 |
| Electron 壳的托盘/通知/更新 | 壳专属；页面只通过 preload bridge 消费（当前接线见 #51） |
| 不显示 TUI 键位提示 | 键位在浏览器里无意义（例如 widget 里的 `↓/← to inspect`） |

---

## 7. 维护清单

改界面时按这张表回来更新对应小节（**同一变更里改齐多面**）：

| 你改了什么 | 必须更新本文 | 相关文件 |
|---|---|---|
| 聊天区分区顺序（消息/notice/todo/widget/输入/状态条） | §2.2、§2.3、§3 | `components/ChatWindow.tsx` |
| 侧栏结构（项目/未分组/最近/置顶） | §2.2、§3、§6 | `components/SessionSidebar.tsx`、`components/session-sidebar-model.ts` |
| 右栏与二级面板（新增/移除 Tab、层级、z-index） | §2.2、§2.3、§3 | `components/RightPanel.tsx`、`components/ChangesPanel.tsx`、`app/globals.css` |
| 手机断点与抽屉行为 | §2.3、§6 | `hooks/useIsMobile.ts`、`app/globals.css`（≤640px 段） |
| 扩展 UI 槽位（新增/映射变化/新解码前缀） | §5、§3 | `lib/web-extension-ui.ts`、`lib/extension-ui-bridge.ts`、`lib/tui-render-bridge.ts`、`lib/subagent-async-widget.ts`、`components/SubagentAsyncWidget.tsx` |
| 状态呈现（运行中/未读/子代理/队列） | §4 | `lib/session-catalog-store.ts`、`components/session-sidebar/display.tsx` |
| 新增 Web 专属面或新的刻意分叉 | §6、§3 | 对应组件 + `docs/architecture.md` 的源码地图 |
| Electron 壳新增 bridge 能力 | §6、§3 | `desktop/src/preload.js`、页面侧接线 |

约定：本文件只写“面与分区、映射与分叉”，不复制像素级样式；视觉规范放 `docs/ui-redesign/`，架构与状态所有权放 `docs/architecture.md`。
