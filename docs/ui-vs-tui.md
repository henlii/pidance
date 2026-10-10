# 界面分区：Pidance Web 与 Pi TUI 对照

这份文档回答一个问题：**同一个 Pi 会话，在终端（TUI）和 Pidance（Web / 手机 / Electron 壳）里分别长什么样、哪些部件一一对应、哪些是刻意分叉。**

判断“该不该改”的总原则（见 `AGENTS.md` 的产品原则）：**兼容优先，优化必须通用**。原生 TUI 有的内容都要有；显示层的改进要所有插件共用，不为个别插件写特例。本文里标为「刻意分叉」的条目是产品决定，不要“对齐”掉；“仍存在的差异”才是待补的缺口。

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
模态：dialog（select/confirm/input/editor）、custom 面板（替换编辑区）
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
| thinking 块 | assistant 块内的折叠段，默认收起 | `components/MessageView.tsx`、`lib/thinking-content.ts` | 同 |
| 工具调用块 | 过程分组（process group，**默认收起**） | `components/ChatWindow.tsx`（`ProcessDetailsGroup`）、`lib/message-display.ts` | Web 按“一轮”分组，TUI 按事件平铺 |
| 图片预览（消息媒体） | 全屏预览层：缩放/拖动 + **下载原图 → 另存为** | `components/MessageImage.tsx`、`lib/image-preview-store.ts`、`components/SaveAsDialog.tsx`、`app/api/files/save-as/route.ts` | 下载走浏览器自己的下载目录（web 缓存）；点过之后按钮变「另存为」，由**服务端**把原文件复制到所选目录（同名自动加 ` (n)`，原文件保留）。只有拿得到服务端路径的媒体才有「另存为」（纯 base64 图没有可复制的源文件） |
| 压缩/分支摘要 | 独立系统块；压缩块与分支摘要**都默认收起**（标题行整行可点，`aria-expanded`） | `components/MessageView.tsx`（`CompactionMessageView` / `BranchSummaryMessageView`） | 同；Web 上一段压缩摘要可达上千像素，默认收成一行 |
| editor（输入框） | 输入区 | `components/ChatInput.tsx` | TUI 键位；Web 按钮 + slash/@ 菜单 + 附件 |
| aboveEditor widget | 输入框**上方**卡片 | `components/ChatWindow.tsx`（`ExtensionWidgets`，placement ≠ belowEditor） | 见 §5（含 pi-subagents 案例） |
| belowEditor widget | 输入框**下方**卡片 | 同上（placement === belowEditor） | 同 |
| footer 状态条（`setStatus`） | 输入框下方状态条 | `lib/extension-ui-bridge.ts`（statuses）、`components/ChatWindow.tsx` | 同 |
| footer（快捷键提示） | footer 右侧读数（模型/思考/上下文/速率） | `components/AppShell.tsx`、`components/ChatWindow.tsx` | Web 显示实时读数，不显示键位 |
| 队列消息 | 输入框上方队列块 | `lib/queue-state.ts`、`components/ChatWindow.tsx` | 同；Web 有 flush/steer 按钮 |
| dialog select / confirm | 面板插槽里的**终端选择器**（SDK 的 `ExtensionSelectorComponent` 自己画的行） | `lib/web-extension-ui.ts`（`runTuiSelector`）、`components/ExtensionCustomPanel.tsx` | 方向键改选中项要一次往返；选项行不可点；「取消」只关这次选择，不补发 `abort`（见 §5.12） |
| dialog input / editor | `ExtensionDialog` 模态 | `components/ExtensionDialog.tsx`、`lib/extension-ui-bridge.ts` | 同 |
| custom 面板（替换 editor 区域） | 会话区下方的面板插槽 | `components/ExtensionCustomPanel.tsx`、`components/ExtensionPanelChrome.tsx`、`components/ChatWindow.tsx` | 与 dialog 同一个插槽（会话区不隐藏）；标题栏取插件画的标题行，识别不到退回「扩展面板」；高度由内容决定、上限是整个会话列，可拖标题行改（见 §5.3） |
| notify | notice shelf | `components/ChatWindow.tsx`（同文件内 `NoticeShelf`）、`lib/notice-reducer.ts` | Web 支持钉住/堆叠/错误分类 |
| `setTitle` | 浏览器标签标题 | `lib/window-title.ts` ↔ `components/AppShell.tsx` | 覆盖顶在项目名之上，**直到下一次标题写入**（切项目 / 切会话 / 插件再 `setTitle`）—— 与 Pi 的 TUI 一致（它直接写终端标题，没有到期这回事）。此前是 30s TTL 自动回落，已按 #76 改掉 |
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

## 5. 扩展 UI 槽位

见 [扩展 UI 槽位：现状与已知缺口](ui-vs-tui-extension-slots.md)——这一节最长（约 1300 词），单独成篇；改扩展 UI 时看它。

## 6. 刻意分叉（不要“对齐”掉）

| 分叉 | 原因 |
|---|---|
| 侧栏项目树 / 未分组会话区 | Web 专属导航面；项目 = 目录，一对一；项目区只列项目列表，其余会话（从未加入过项目的目录、关闭项目后留下的）归底部未分组区，最近/置顶/全文/归档不再按目录过滤（#53） |
| 顶栏谱系下拉（子会话导航） | 侧栏刻意隐藏子代理会话，页头下拉是它们唯一的入口 |
| 文件 / Git / 终端 / 设置面板 | 终端里由命令与其输出承担，Web 做成了面板 |
| 手机抽屉与安全区适配 | 窄视口下三栏并排不可用 |
| Electron 壳的托盘/通知/更新 | 壳专属；页面只通过 preload bridge 消费（当前接线见 #51） |
| 不显示 TUI 键位提示 | 键位在浏览器里无意义（例如 widget 里的 `↓/← to inspect`） |
| widget 组件级鼠标只转 click | `move` / `drag` / `wheel` 不转发（与 custom 面板同一口径）；插件拿不到「悬停/拖拽」这类只有在常驻终端里才有意义的交互。见 §5 第 7 条 |
| overlay `focus()` / `unfocus()` / `getBounds()` | Web 只有一层面板，键始终路由给它；没有终端单元格几何，且已装插件 0 处使用 `getBounds()` |

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
