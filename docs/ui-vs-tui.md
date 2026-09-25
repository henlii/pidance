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
| dialog（select/confirm/input/editor） | `ExtensionDialog` 模态 | `components/ExtensionDialog.tsx`、`lib/extension-ui-bridge.ts` | 同 |
| custom 面板（整屏替换） | `ExtensionCustomPanel` | `components/ExtensionCustomPanel.tsx` | 同；Web 面板可滚动、可关闭 |
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

## 5. 扩展 UI 槽位：现状与已知缺口

Pidance 的适配器（`lib/web-extension-ui.ts`）把 Pi 的 `ExtensionUIContext` 投影成 SSE 上的 `extension_ui_request`，再由 `lib/extension-ui-bridge.ts` 落到 UI。几个已知事实：

1. **widget 的 placement**：缺省按 `aboveEditor` 处理（与 Pi 默认一致），所以扩展不写 placement 时，Web 就会把它渲染在**输入框上方**。
2. **组件工厂形式**（`setWidget(key, (tui, theme) => Component)`）：工厂只调用一次，组件实例常驻在适配器里，`tui.requestRender()` 触发重新渲染并按 microtask 合并，产出走与字符串数组相同的 `setWidget` 通道（`lib/web-extension-ui.ts` 的 `mountWidgetFactory` + `lib/tui-render-bridge.ts` 的 `renderWidgetComponentLines`）。渲染失败保留上一次的行（不推空帧）；卸载、替换成字符串数组或适配器 dispose 时调组件的 `dispose?.()`。工厂收到的 `tui` 是有 `requestRender` + `terminal` 的真对象（此前传 `undefined`）。
3. **`custom()` 的 overlay 与 keybindings**：`ctx.ui.custom(factory, options)` 接收第二参，把 `overlayOptions` 的 `anchor` / `width` / `minWidth` / `maxHeight` / `margin` 归一化成 `ExtensionUiCustomLayout` 随事件下发（`lib/web-extension-ui.ts` 的 `normalizeCustomOverlayLayout`），前端由 `lib/extension-overlay-layout.ts` 映射成浮层的对齐与尺寸。**没有 layout 的 custom 仍是全屏模态**——那对齐的是 `overlay: false` 的语义（替换 editor 区域，如 pi-subagents 的 SelectorComponent）。回调第 3 参注入真的 `KeybindingsManager`（键名定义取 pi-tui 的 `TUI_KEYBINDINGS`）；pi 的应用级键位（如 `app.editor.external`）不在这份定义里，对应的 `matches()` 恒为 false。`tui.stop()` / `tui.start()` 是 no-op 占位（Web 没有可让出的终端），插件的外部编辑器路径会因 spawn 不到 tty 自行失败；`stop()` 会经 `notifyUnsupported` **报一次可见失败**（#76），免得用户只看到面板静静地卡住。
4. **`mode` 是 `"tui"`**（`lib/sdk-session-host.ts` 的 `bindExtensions`）：宿主声明能渲染扩展自绘组件，插件因此走富路径而不是降级——pi-subagents 的 async widget 走组件工厂、pi-mcp-adapter 启用 `/mcp` 的 overlay、pi-advisor-flow 才进 `custom()`。`lib/subagent-async-widget.ts` 仍保留 rpc 快照载荷的解析（`PI_SUBAGENT_ASYNC_JSON:`），作为旧会话与兼容路径。
5. **`mode === "rpc"` 快照已解码**：pi-subagents 在检测到宿主是 rpc 模式时，发的是同一份数据的一行快照
   `PI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot",…}`（见其 `src/tui/render.ts` 与 `src/runs/background/async-status-snapshot.ts`）。
   Pidance 现在在 `lib/subagent-async-widget.ts` 里解析它，并**按 TUI 的行结构**渲染成 `components/SubagentAsyncWidget.tsx`：
   标题 `异步子代理 <agent> · 后台`（多个 run 时是 `异步子代理`），每行 = 状态字形（●/◦/✓/■/✗，颜色同 TUI 的 accent/success/warning/error）＋ label ＋ 状态 ＋ 已用时长 ＋ `⎿ 当前工具 工具时长 · N 轮 · N 次工具`；位置仍是输入框上方（TUI 的 aboveEditor 语义）。
   有意不搬的：终端键位提示（`↓/← to inspect`）——Web 里换成面板自身折叠，子会话导航在顶栏谱系下拉。
   解析失败时**不显示原始载荷**（宁可空着，也不把 JSON 糊到界面上）。
   子代理全部结束后 pi-subagents 会 `setWidget(key, undefined)`，面板消失。
6. **`onTerminalInput`（插件全局按键）有三条窄道**：pi-tui 的 `addInputListener` 是全局同步的，Web 没有等价层，**也不做「每个键都往返」**。现在有三种情形会把按键 POST 给 `terminal_input`（服务端按 pi-tui 语义逐个调监听器：先 `consume` 再 `data` 改写，见 `dispatchTerminalInput`）：
   - **面板收起**（`hidden` 且注册了监听器）：前端把白名单键（Escape / F1–F12 / Ctrl·Alt + 非保留字符，见 `lib/extension-panel-keys.ts` 的 `shouldRouteKeyToExtensionListener`）拿去问插件。rpiv-ask-user 的折叠键靠它把面板重新展开。
   - **插件界面显示中**（`hooks/useExtensionTerminalInput.ts` 的窗口 ③，issue #102）：可见的 custom 面板（含 overlay）或扩展对话框在屏幕上时，按键归插件的全局监听器 —— 此前这种情形下只有面板自己的 keytrap 能收到按键，焦点一旦不在面板里（用户点了别处，或对话框这种没有 keytrap 的界面）插件就完全收不到。排除项：Cmd(Meta) 组合、浏览器保留的 Ctrl 组合（含 Ctrl+Space）、壳自己的 Ctrl+K（命令面板，依据 TUI 的 app 保留键位规则）、**Tab**（无障碍焦点遍历，键盘用户只能靠它走到面板里的按钮）、输入法合成中与 `compositionend` 后的 80ms 宽限，以及**事件目标已经有 DOM 归属者**的按键（输入框本身、面板 keytrap、按钮/链接/菜单项等）——最后这条同时保证了「输入框聚焦时维持现状」。面板/对话框关掉后由 `ChatWindow` 在同一提交里把焦点还给输入框。
   - **插件 widget 的选择态**（`hooks/useExtensionWidgetKeys.ts`）：没有 custom 面板、该会话存在 widget、且有监听器时，输入框**为空且聚焦**的前提下——未入选择态只送 `↓`/`←`（插件的激活键，且**不拦截**，空输入框里这两个键本来没可见行为）；插件消费了就进入选择态，此后只路由导航键（方向键 / `j` / `k` / `Enter` / `Esc`，这些会 `preventDefault`）；任何其它键立刻退出选择态并把按键原样留给输入框。普通打字一次请求都不发。选择态是**本地推断**（看插件有没有消费上一次按键），所以有三道复位：`Esc`/`Enter` 被消费也**无条件清零**（它们是插件的离开/提交键，继续记着会把之后的 `j`/`k`/回车吞掉）、任何非导航键清零、超过 10 秒没有路由过按键即视为已离开。切后台、失焦、换会话同样复位。输入法合成中（含 `keyCode === 229` 与 `compositionend` 之后的 80ms 宽限）一律不参与，避免合成提交那一下被当成导航键拦截。

   代价与限制：选择态下 `j`/`k` 是导航而非字母，所以只能在「空输入框 + 已激活」时拦；插件在 Web 端的 `Esc` 取消长任务仍然没接（只接了 widget 选择态里的 `Esc`）。
   **注册时会告知覆盖范围**（issue #74）：`onTerminalInput` 落地时发一条只发一次的 warning（`lib/web-extension-ui.ts` 的 `notifyLimitedSupport`），逐字写明三个窗口——① widget 存在且输入框**聚焦且为空**时，`↓`/`←` 开局、之后方向键/`j`/`k`/`Enter`/`Esc` 才会路由；② 存在**已收起**的扩展面板时 `Esc`、`F1`–`F12`、`Alt+<字符>`、`Ctrl+<字符>`（浏览器保留组合与 `Ctrl+Space` 除外）会路由；③ 插件面板 / overlay / 扩展对话框**显示中**时，除 Meta 组合、浏览器保留的 Ctrl 组合、壳自己的 `Ctrl+K`、`Tab`（焦点遍历）以及**已有 DOM 归属者**（焦点所在的那个控件）的按键之外，都路由给插件——以及「普通打字到不了」。否则插件无从区分「用户没按」和「Web 端收不到」，这块交互会静默消失 —— 但也不能写成「不支持」：按键确实会送达，只是覆盖面窄。**这条提示本身也要能水合**（issue #93）：它走一次性 SSE 事件，而扩展加载发生在浏览器订阅之前，那一刻没有订阅者就永久丢掉（实测：服务端日志 5 次、页面 DOM 0 次），所以宿主把它留成只读快照、`extensionCapabilityNotices` 随状态下发，客户端按 id 去重补进通知队列。
7. **面板内鼠标事件**：`ExtensionCustomPanel` 把点击换算成字符行列后发 `extension_ui_mouse`，服务端调**面板组件**的 `handleMouse`。只转 click，不转 move / drag / wheel。**`setWidget` 的组件同样收得到**（2026-09-26，issue #103）：卡片**正文区**的点击按同一套换算（`lib/extension-widget-mouse.ts`；字符宽/行高量的是正文区自己 —— 与服务端渲染这些行用的是同一套字体上下文，所以列宽一致。事件里的 `width`/`height` 是**可见正文盒**的格数，**不是** `render(width)` 的列数：pi-tui 的 `Container.handleMouse` 正是用 `y >= event.height` 丢掉可见区以下的点击，所以给的必须是「用户能点到的那块区域」）发 `extension_ui_widget_mouse`，服务端按 **widget key** 调该组件的 `handleMouse`（局部字符坐标）；量不出尺寸（未布局）时这一次点击不转发，不给插件送错坐标。仍然只转 click（不转 move / drag / wheel），**滚动不拦**（往返回来再 preventDefault 已经来不及）。**卡片头（折叠按钮）始终归我们的槽位外壳**，插件只拿正文区；坐标原点也在正文区。触摸：tap → 左键、长按 → 右键；**滑动（超过 10px）与被系统取消的手势都不转发 click**（浏览器滑动后通常不补发，但这不是保证 —— 补发的那次若被当成 tap，插件会看成「点了第 0 行」而误切换整块），长按与滑动之后补发的 click 一律吃掉并复位（标记不跨手势存活，不会永久吞点击）。只有组件真的实现了 `handleMouse` 才在状态投影与 `setWidget` 帧里带 `interactive: true`，前端据它决定要不要为点击付一次往返（字符串数组 widget 永远不可交互）。已装插件里只有 pi-subagents 的 fleet widget 用到它（「第 0 行左键」把**整块**在「一行摘要」与「全列表」之间切，`src/tui/render.ts:2837-2845,2887`）—— 与我们的卡片级折叠并存（两个粒度都能用），方向键驱动的 roster 已在 #83 打通。custom 面板的 overlay 句柄也已实现（2026-09-26，issue #99）：`focus()` 把键盘交给面板（面板隐藏或已摘除时是 no-op，对齐 pi-tui —— 不去唤醒不在屏幕上的面板）、`unfocus({target})` 三态（`target: null` = 谁都不聚焦；不给 options = 交回输入框；给具体组件时因 Web 只能程序化聚焦输入框而按同一落点降级，理由写在实现里）、`getBounds()` 返回**客户端上报**的字符单元格矩形（原点取会话滚动区，与面板鼠标坐标同一元素同源；未挂载或量不出时返回 `undefined`，后台标签不上报）；`nonCapturing` 的 overlay 初始焦点留在编辑器。`hide()` 仍按 pi-tui 契约做成**永久移除**（#76）。
8. **`getToolsExpanded` / `setToolsExpanded` 自洽**：服务端维护布尔并下发事件，插件 set 之后自己 get 得到的是一致的值；界面上的工具块仍按各自的折叠规则（`setToolsExpanded(true)` 不会展开所有块）。
9. **没有等价语义的能力改成可见失败**：`setEditorComponent` / `addAutocompleteProvider` 会发一条 warning 通知（每种能力只发一次），不再静默 no-op —— 静默会让插件作者以为生效了（例如 `getEditorComponent()` 永远返回 undefined，插件以为包裹链装上了）。`getAllThemes` / `getTheme` / `setTheme`（#97）与 `setFooter` / `setHeader`（#98）**已经实现**，不再走告警。`setEditorComponent` 仍然告警（Web 输入区是自己的 React 组件，**不会**用插件的工厂去渲染），但工厂值会存下来并被 `getEditorComponent()` 如实回传（SDK 契约是「当前**配置的**工厂」，未配置才是 undefined），「拿旧的包一层再设回去」的写法不再断链（issue #74）。传 `undefined` / 无参的「恢复默认」不算降级，不提示。`setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` **已经实现**（不再走告警）。
**`setFooter` / `setHeader` 也已实现**（2026-09-26，issue #98）：插件工厂拿到的组件走与 widget 同一条渲染桥
（headless `render(width)` → ANSI 行），页头常驻在转写区之上、页脚在我们自己的状态条之上；替换时先 `dispose()` 旧组件
（对齐 TUI 的 `setExtensionFooter`），`setFooter(undefined)` / `setHeader(undefined)` 恢复内置（页脚回到我们自己的状态条）。
槽位限高内滚（移动端约 4 行 / 桌面约 6 行），组件抛错或渲染不出行就隐藏槽位并**每种槽位只提示一次**，异常文本不进界面。
两处**有意分叉**：① TUI 是「替换」整个内置页脚，我们保留状态 chip —— 状态是独立机制，而页脚数据（git 分支等）我们没有等价物，
真替换会把 `setStatus` 的信息整块吞掉；② 页脚工厂的第三个参数（`ReadonlyFooterDataProvider`）**不传**（宁可不传也不塞缺成员的假对象，
插件真依赖它会走到「可见失败」而不是静默假数据）。
**`setHiddenThinkingLabel` 也已实现**（2026-09-25，issue #96）：折叠态思考块的那一行改用插件给的标签
（TUI 语义就是「收起时只画这个标签，展开才画正文」，依据 `assistant-message.js` 的
`hidden ? new Text(...hiddenThinkingLabel...) : new Markdown(正文)`），未设置 / 空串 / 纯空白恢复既有的 i18n 摘要；
标签**原样显示**（插件文案，不走 i18n），超过 60 个码点从中间截断、全文进 `title`（仅在真的截断时挂）。
随状态下发（`state.hiddenThinkingLabel`）以便后开的页面补上，切会话与插件 `reload()` 都会重置。

10. **仍存在的差异**：
   - `subagent-fleet-status`（placement `belowEditor`）是 TUI 组件，经渲染桥转成文本，里面的 `↓/← to inspect` 是终端键位。Web 侧现在改写这行：去掉键位提示段，保留 agent 数与 token 读数（`rewriteFleetStatusLines`）；整行只剩提示时不渲染该 widget。
   - **`tui.focusedComponent` 已注入**（2026-09-24）：客户端在输入框聚焦/失焦/切后台时上报 `editor_focus`，服务端把它投影成 `tui.focusedComponent`——有焦点时给一个**鸭子类型探针**（只有 `render`/`invalidate`/`handleInput`/`getText`/`setText` 五个 no-op 成员，见 `lib/custom-ui-terminal.ts` 的 `createEditorFocusProbe`），无焦点时 `undefined`。pi-subagents 的 fleet widget 靠它决定方向键能不能进选择态（`fleet-status.ts` 的 `editorHasFocus()`），配合第 6 条的 widget 选择态窄道即可用。焦点按**标签**（clientId）聚合：任一标签的输入框聚焦即视为聚焦，后台标签失焦不会清掉前台标签的焦点（旧实现是单槽 last-write）；每项带 60 秒 TTL，标签被直接关掉后焦点自己过期。客户端不为补报单独发请求——**窗口 ②**（widget 选择态）那条 `terminal_input` 命令带 `assertFocus`，服务端把按键交给插件**之前**先刷新焦点（拆成两条 HTTP 会乱序，表现为冷启动或过期后第一次 `↓` 不激活）。**窗口 ①/③ 故意不带**：它们成立时输入框并没有聚焦（① 是面板已被收起、③ 是用户正在跟插件界面交互），带上等于把 `tui.focusedComponent` 谎报成「主编辑器聚焦」，会骗过 pi-subagents 那类拿它当激活门槛的界面（`lib/extension-panel-keys.ts` 的模块注释里写了这条取舍）。
   - **`getEditorText()` 回传的是「已同步到服务端的输入框草稿」**（2026-09-25，issue #74）：宿主把 `lib/composer-draft-text.ts` 的读取器注入适配器，读的是客户端**本来就会**镜像到 `/api/preferences` 的那份草稿（`lib/draft-store.ts`，键是**已存在会话**的会话 id）—— **零新增往返**，代价是一次小文件读（本机 42KB / 148 条草稿时 `readFileSync` + `JSON.parse` 实测约 0.5ms，复现命令见 `lib/composer-draft-text.test.mjs` 末尾；超过 4MB 直接降级为空串）。语义边界：比输入框**滞后**（客户端 400ms 防抖 + 落盘），多标签共用同一个草稿键（最后写入者胜出），所以是「这个会话的草稿」而不是「某个标签页的编辑器」；没有草稿 / 读失败一律空串。
     **已知副作用**（审查 P1，不要写成「不影响」）：pi-subagents 的激活门槛也是 `ctx.ui.getEditorText() === ""`，而这里读的是**盘上镜像** —— 用户清空输入框后立刻按 `↓`（清空走立即 flush，但仍要等一次 PUT 到达），或另一个标签往同一会话写了草稿时，插件会认为「框里还有字」而**不激活**，那一下按键看起来没反应。客户端那条门槛（只在输入框为空时才路由按键）只看本地状态、不受影响，所以两条判据**不是**独立的：客户端管「键要不要送」，插件管「送了之后认不认」。
     另：会话创建之前客户端把草稿存在 `new:${cwd}` / `new:${intentId}` / `"new"` 键下（`hooks/useAgentSession.ts` 的 `draftKey`），宿主传的是已落盘会话 id，所以那一段文本这里读不到（那时也还没有会话宿主会调这个 API）。
   - ~~新开页面拿不到已存在的 widget~~ **已核实不是问题**：widget 会随状态水合（`/api/sessions/<id>/state` 的 `state.extensionWidgets`）在打开会话时出现。此前判定「拿不到」是探针口径造成的误判。
   - **左侧用户消息导航条铺满整列**（2026-09-22 决定）：短横线首尾贴住列内缩位置、中间按条数均分，**一条横线的纵向位置就对应它在会话里的先后** —— 贴底时「当前」那条落在轨道最下面（此前整条限高 320px、垂直居中，当前项落在屏幕中部，看不出与会话位置的关系）。条数多到每格矮于 8px（点不中）时退回旧的「限高 + 居中 + 内部滚动」，此时才显示上下小三角。
   - **侧栏里的 fork 子会话平铺显示**（2026-09-22 决定）：Pi 原生 fork 出来的会话是**独立会话**，与父平级各占一行，侧栏不再有「展开/折叠子会话」；父行下也不再嵌 fork 子行。此前把它嵌在父下，而 fork 会连标题一起复制，于是看起来像「同一个会话显示了好几行」。subagent 子会话仍然整体隐藏（只在顶栏「子会话谱系」里）。
   - **折叠属于槽位外壳，不属于内容**：所有 `setWidget` 部件（含 `subagent-async` 这种机器载荷）都由 `ExtensionWidgets` 的**同一个卡片模板**渲染标题行 —— 折叠按钮、`aria-expanded`、展开/折叠文案、按 widget key 持久化的折叠状态只有一处。所以**任何插件用这个槽位都自动能折叠**，不需要各自实现。标题也是外壳给的，走**通用规则**：机器载荷用它能解析出的友好名（`异步子代理 <agent>`，副标题带「后台 / N queued / 另有 N 个 / 截断」），其余部件统一把 key 的美化形式当标题（`subagent-async` → `Subagent Async`）—— 不为个别插件写特例（`mode=tui` 下 pi-subagents 不再发 JSON 快照，它也就走这条通用路径）。面板组件只负责正文（状态行）。
   - **子代理通知消息块**（`subagent-notify` 这类扩展自定义消息）：标题走通用美化（`Subagent Notify`），不露出内部 customType 原名；折叠开关在卡片头部（默认收起），展开后才显示通知正文。
   - **会话内容区宽度可拖拽、按比例记忆**（2026-09-22 决定）：宽度 = 内容区**可用宽度** × 比例，再夹到 [1000, 1600]，可用宽度不够时由 `100%` 兜住 —— 于是宽屏到 1600 封顶后只长两侧空白，窄到下限后只缩空白，空白归零后内容才跟着缩。比例存 `localStorage`（本机 UI 状态，随 #65 口径），窗口/侧栏尺寸变化自动重算。把手贴在内容列左右缘（`role="separator"`，拖任一侧对称改宽、被拖那条边跟手；双击回默认）。宽度用 CSS 变量 `--pidance-chat-column-width` **一处设置**（AppShell），消息列/输入栏/扩展面板/widget/底栏共用同一变量，保证同宽同中心线。
   - **折叠总规则（2026-09-22 决定）**：会话时间线里**只有智能体直接输出的正文默认展开**；除此之外的块（thinking、工具调用、过程分组、压缩、分支摘要、扩展自定义消息、子代理通知）一律可折叠且**默认收起**。过程分组只包中间过程（thinking / 工具 / 子代理回复），每轮末尾的正式回答由 compositor 渲染在组外，所以收起不会藏掉智能体输出。
11. **状态条与 widget 不区分“谁提供”**：Web 侧只按 key 渲染与折叠（折叠状态存 `localStorage` 的 `pidance.collapsedWidgetKeys.v1`）。
12. **阻塞弹窗（`ExtensionDialog`）的按钮与可读性由 Web 侧定**：协议只传 `title` / `options` / `placeholder` 这类纯文本字段，插件无法定制样式与按钮。现状：
   - 按钮按 `method` 固定：`select` 只有底部「取消」；`input`/`editor` 是「取消 + 提交」；`confirm` 是「取消 + 确认」。**`select` 不再渲染右上「关闭」**——它与「取消」发的是同一个 `cancelled` 响应（并且会中止这次执行），并排两个等价按钮只会让人以为「关闭」是温和的那个。
   - 「取消」的语义不止关窗：`hooks/useAgentSession.ts` 在 cancelled 之后若 agent 仍在跑会补发 `abort`（对齐 OpenChamber）。
   - **长提问可滚**：扩展经常把 preview / 说明折进 `title`，所以标题本身就是内容区（`.extension-panel-title`，`max-height: min(30vh, 240px); overflow-y: auto`）；正文（选项等）在 `.extension-panel-body` 里滚动。
   - **展开/收回，默认展开**：header 有「收回 / 展开」开关（`ExtensionPanelChrome` 的本地 state，不跨请求记忆，默认展开）。展开同时抬高面板与提问区的上限（`.extension-panel-shell--expanded`，桌面 `min(78vh, 900px)` / 窄屏 `calc(100dvh - 96px - 安全区)`，提问区 60vh / 窄屏 56vh）——**只抬面板不抬提问区等于没解决「问题显示不全」**，这条改动两侧必须成对。默认展开是安全的：`max-height` 只是上限，面板高度仍由内容决定，短提问不会因此占满屏。
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
