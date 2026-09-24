# 系统与会话架构

[文档导航](README.md) · [开发验证](development.md) · [已知风险](architecture-review-2026-09-15.md)

本文描述当前源码结构，不将目标约束等同于已经验证的不变量。主包当前精确依赖 Pi SDK `0.87.0`；更新依赖时以 [package.json](../package.json) 为准。

## 1. 分层与所有权

```text
桌面浏览器 / 手机浏览器 / Electron Web 窗口
  AppShell / SessionSidebar / ChatWindow / ChatInput
    useAgentSession + sidebar adapters
      ├─ SessionNavigationStore：当前目标、new intent、promote、URL
      ├─ SessionCatalogStore：列表、pending、归档、running、未读
      └─ BrowserSessionRuntimeRegistry：每会话提交、run token、timeline
           EventStreamManager / HTTP client
                         │
              Middleware / RequestGuard
                         │
                       Routes
                         │
                   SessionService
                  ┌──────┴────────┐
          LiveSessionRegistry   session-reader / read models
          启动锁、注册表、租约     列表、历史、上下文、导出
                  │                 │
            SdkSessionHost     pi-session-io
                  ├─ WebExtensionUIAdapter
                  └─ Pi AgentSessionRuntime / AgentSession / SessionManager
                                                    │
                                               JSONL / tree
```

| Owner | 负责 | 不应承担 |
|---|---|---|
| Routes | 输入解析、HTTP 状态和传输 | 直接绕过 Service 操作主运行时 |
| SessionService | live/disk 选择、只读门禁、删除、命名、产品分支语义 | 复制模型执行逻辑 |
| LiveSessionRegistry | 多会话注册、启动合并、running 广播、租约联动 | Agent 命令实现 |
| SdkSessionHost | SDK 组合、命令映射、事件/状态投影、产品队列 | 自建 Pi 会话格式 |
| Pi SDK | prompt、steer、工具、压缩、session replacement、JSONL/tree | 浏览器导航和展示偏好 |
| 浏览器三个 store/registry | 目标、目录、每会话运行数据 | 写 JSONL |

当前 `useAgentSession` 仍拥有队列同步、Stop 编排、恢复轮询和附属状态投影，尚不是纯视图适配器。现有消息提交与 timeline 已迁入 browser registry，不代表全部交互生命周期都已迁入。

## 2. 核心交互链路

### 打开历史

- `/api/sessions/[id]`、context、outline 等通过 Service 读取 live manager 或磁盘投影。
- `/api/agent/[id]`、默认 `/api/sessions/[id]/state` 只观察，不启动 Host。
- 单会话 SSE 仅订阅本进程现有 live Host；没有 Host 返回 404，不以观察动作抢占 writer。
- 显式 `state?wake=1` 可以启动可写 Host。它具有副作用，不应作为普通历史浏览请求。

### 首发与后续发送

- 新会话：browser registry 使用 `POST /api/agent/new {type:"prompt", submissionId, ...}`，服务端创建 Host 并提交，响应携带真实 session ID。
- 旧会话：显式 wake → 尝试连接 SSE → POST prompt。SSE 握手不是 POST 的硬性前置条件。
- Host receipt 表示预检受理或拒绝，不等于整个模型回合已完成。
- 浏览器乐观消息按 submission key 归并；生产事件并非总有 entry ID，最终需要磁盘 hydrate 对账。
- Host 的 submission 去重仅存于该 Host 内存，不提供跨重启/重建的 exactly-once 保证。

### 流式与结束

- `EventStreamManager` 每动画帧只交付最新 `message_update` 完整快照，边界事件前先 flush。
- browser registry 按 session slot 管理本地 run token；旧异步收尾不得清除新 run。
- Host 在 `agent_end` 清本轮 prompt 标记并发送 `prompt_done`；浏览器据此收尾。
- `agent_settled` 用于 SDK 内部 continuation 结束后的产品队列推进与正常 run 的 Host 销毁。
- 无未 hold 产品队列时，正常 settled run 请求立即销毁；startup hold、无模型回合命令、手动压缩等仍有独立 idle 路径。不能笼统描述为“所有空闲 Host 都立即销毁”。
- 当前销毁等待/回调仍有缺口，见审查 R1、R2。

### 队列、引导与停止

- 产品文本队列由 Host 持有，偏好键为 `sessionQueue.<id>`，当前值为 `{items: string[], revision: number}`；水合兼容旧数组。
- `sessionQueueHold.<id>` 控制失败/中止后的暂停；成功 prompt 预检解除 hold。
- 自动投递以 completed 的 settled 为主要触发；手动压缩完成、空闲 late-enqueue 也有投递路径。
- 运行中引导走 `steer`；Host 空闲时将其转为 prompt，避免原生 steering queue 悬挂。
- 代码仍保留原生 `follow_up` 命令，客户端媒体路径也会使用它；不要把产品文本队列等同于 SDK 全部队列。
- Stop 当前先取消在途 fetch，再对已知真实 ID 发送 abort。新会话 ID 未返回时并无完整服务端取消事务，见 R4。

### 后台恢复与多标签

- 每个浏览器页面有自己的 runtime registry，不是跨标签共享内存。
- 恢复通过 SSE、HTTP reconcile、磁盘 tail hydrate 配合完成；SSE 不提供可依赖的持久事件重放日志。
- 前台恢复会尝试重连并刷新当前会话；正在运行时还有轮询对账。
- `live=false` 本身不是“已结束”：当前 reconcile 结合 `activeRun=false` 且未被另一进程锁定，才可将无 live 状态视为已知空闲。
- 多标签的队列写冲突、迟到投影和 custom UI 恢复仍有已知限制，见 R6–R8。

## 3. 状态字段口径

| 字段/集合 | 含义 |
|---|---|
| `live` | 本进程存在可用 SDK Host |
| `activeRun` | Host 正在 prompt / stream / compact / bash |
| `lockedByOther` | 另一 Pidance 进程持有会话 writer 租约，不等于本进程正在运行 |
| 全局 running 集合 | 本进程 starting 锁与 `isRunning()` 的并集 |
| `runningStartedAt` | 当前执行轮起点，不使用 writer 存活时间计算 |
| 浏览器 `promptRunId` | 本页面 slot 的代次，不是跨进程持久事务 ID |

部分浏览器适配仍兼容旧 `running` 字段；新接口说明应使用 `live/activeRun`，不要把空闲 live 写成 running。

`lockedByOther` 的**发现路径**：这个事实只能由客户端轮询 —— 租约文件由**另一个进程**持有，本进程没有事件可订阅（全局 running 集合只反映本进程）。未上锁时每 3s 打一次只读探针 `GET /api/sessions/[id]/lock`（一次租约文件读，不做状态投影；标签页隐藏时不发请求），上锁后用既有的 1s `/state` 轮询感知释放。**不要**拿空闲期的状态刷新当发现路径：那是 2 分钟一档（`RECONCILE_IDLE_MS`）。展示优先级：`isReadOnly` 优先于 `lockedByOther` —— 只读是会话自身属性，锁定条给的是「等下就能写」的预期，对只读会话是错的。

## 4. 数据与写入边界

- Pi JSONL 是带 `id/parentId` 的会话树，不是普通追加日志。Fork 创建独立文件；navigate 改同文件活动路径。
- `SessionManager` 是 JSONL writer；Pidance 活动/命令/二进制展示记录使用原生 custom entry，不发明 JSONL entry 类型。
- 非末尾 leaf 选择使用 `.jsonl.leaf.json` sidecar，打开 manager 后恢复；它不是新的 Pi schema 字段。
- 列表缓存、偏好、归档是独立投影/sidecar，不能替代会话树事实来源。
- 31415 与 31416 可共享 agentDir，必须遵循单写者约束；禁止外部 Pi CLI 同时写同一个 JSONL。
- 当前租约与离线写互斥并非无缺口，不能据此宣称任意并发写都安全。
- `pi-session-io` 为提前落盘/重挂 parent 使用 `_rewriteFile` 与 `flushed` 私有实现，SDK 升级需要专门兼容检查。

### 状态作用域与冲突规则

偏好落在 `~/.pi/agent/pidance-preferences.json`（temp+rename 原子写，0600，跨进程 `wx` 锁串行化；服务端 `GET /api/preferences` 每次实时读文件、无缓存）。**没有文件 watcher**：手工编辑文件或另一进程写入不会即时生效，下一次读取才看到。

**不变量**：客户端**永不**用整份内存快照或整对象回写共享键——写入只发「本次真正改动过的点路径」组成的 patch（`lib/server-preferences.ts` 的脏键集合），形状是服务端 `mergePidancePrefs` 支持的一层子对象（`{"sidebarUi":{"showRecentSessions":false}}`）；`null` 是墓碑（服务端删键）；`sessionQueue*` 是宿主独占键、永不由客户端回写。整包/整对象写入会用「本地这份可能过期或尚未水合的副本」覆盖别的客户端刚写的值——实测清空过用户的项目列表、把 `locale` 写歪（issue #62/#63）。

| 键 | 作用域 | 权威方 | 冲突规则 |
|---|---|---|---|
| `sessionQueue`、`sessionQueueHold.*` | 会话运行态 | Host | revision CAS；客户端不整包写回 |
| `unreadSessionState`（`completedAt`／`readAt`） | 跨端 | 服务端写 `completedAt`（run 结束时），各端写自己的 `readAt` | 单调时间戳取并集，无 CAS；未读 ⟺ `completedAt > readAt` |
| `sidebarUi` 集合字段（`projectRoots`/`pinnedSessionIds`/`ungroupedSessionIds`/`collapsedProjectRoots`） | 跨端 | 服务端（锁内施命令） | **命令语义**：客户端发 `add`/`remove`（`op`），服务端在当前内容上施加 → 并发加项不会互相覆盖；`projectOrder` 用 `set`（顺序是位置语义） |
| `sidebarUi` 标量字段（`displayMode`/`showRecentSessions`/`projectSort`/`projectAliases`…） | 跨端 | 客户端按字段写 | 字段级 patch（LWW）；服务端只做「顶层键 + 一层子键」合并，**不要用 patch 写集合**（数组整体替换会丢并发加项） |
| `pluginLocks.*`、`skillLocks.*` | 跨端 | 客户端按子键写 | 逐插件/技能子键，避免整 map 互相覆盖 |
| `drafts.*` | 跨端 | 客户端按草稿键写 | 按 key + `updatedAt` LWW，附 30 天/30 条 GC |
| `thinkingLevel.<provider:model>` | 跨端（账号级默认） | 客户端按子键写 | LWW；**会话内实际思考档以 JSONL 为准** |
| `theme`、`locale`、`streamingEnter`、`autoUpdateCheck`、`queueFlushAsOne` | 跨端 | 客户端 | 标量 LWW |
| `footerCollapsed`、`draftTargetCwd` | **本机** | 本机 localStorage | 不进跨端偏好（窗口/「我这次要在哪建会话」都是设备局部） |
| `fileTree.<cwd>`（`expanded`／`scrollTop`） | **本机** | 本机 localStorage | 不进跨端偏好（像素位置与展开态因设备而异） |
| 侧栏/右栏宽度、面板开关、终端键盘垫、widget 折叠、更新条 | **本机** | 本机 localStorage | 不进跨端偏好 |
| `trust.json`、`pidance-ui-sessions.json`、`pidance-running-leases/` | 服务端 sidecar | 服务端 | 见下文；设备注册表读-改-写在文件锁内 |

**优先级链**：Host 运行态 > 字段级 patch / 集合命令 > 账号级标量 LWW > 本机 UI。不要为一致性引入 CRDT；键级补丁 + 集合命令 + 可合并值（时间戳并集）已足够。

### 偏好变更的实时同步（同后端内）

- 写入成功后服务端**广播变更键**（`GET /api/preferences/events`，SSE；载荷只带本次变更的键与值），
  同后端下的其它客户端亚秒级应用，不必等切回前台。
- 广播带 `(bootId, revision)` 供对账：只应用更新的版本；`bootId` 变化（后端重启，revision 从头开始）
  时先全量拉一次。**未 flush 的本地改动优先**，广播不得盖掉它。
- 范围**只在同一后端进程内**：不做跨进程广播、不装 `fs.watch`（写文件的就是本进程）。手工编辑
  文件或另一进程写入仍靠下一次 GET（加载 / 切回前台）。
- **一个页面只有一条应用级 SSE**（`/api/agent/running/events`，见 `lib/app-events-stream.ts`）：
  运行集与偏好变更都从它分发。浏览器对同一源（HTTP/1.1）只有 6 条并发连接，而重载页面时旧连接
  尚未关闭、新连接就要建立 —— 再各开一条（偏好、文件监听…）会把 `/api/sessions/<id>/state`
  这类普通请求挤在队里，于是「刷新后导入在跑的 run」失败（实测踩过：单独加偏好广播后 A2 稳定失败，
  改回共用一条即恢复）。新增推送需求**沿用这条流**，不要新开端点。

安全策略及不提供文件沙箱的限制见 [安全说明](security.md)。

## 5. 源码导航

| 范围 | 主要入口 |
|---|---|
| 产品布局/交互 | `components/AppShell.tsx`、`ChatWindow.tsx`、`ChatInput.tsx`、`MessageView.tsx` |
| 会话与侧栏适配 | `hooks/useAgentSession.ts`、`components/SessionSidebar.tsx` |
| 浏览器 owner | `lib/session-navigation-store.ts`、`session-catalog-store.ts`、`browser-session-runtime-registry.ts` |
| HTTP / SSE 契约 | `lib/agent-client.ts`、`agent-commands.ts`、`api-types.ts`、`event-stream-manager.ts` |
| 会话业务/运行时 | `lib/session-service.ts`、`live-session-registry.ts`、`sdk-session-host.ts` |
| 扩展适配 | `lib/web-extension-ui.ts`、`extension-ui-bridge.ts`、`components/ExtensionDialog.tsx`、`ExtensionCustomPanel.tsx` |
| 磁盘与读模型 | `lib/pi-session-io.ts`、`session-reader.ts`、`session-metadata-cache.ts`、`session-leaf-sidecar.ts` |
| 项目/文件/Git | `lib/project-context.ts`、`lib/ui-preferences.ts`、`file-access.ts`、`app/api/files/`、`app/api/git/` |
| 管理面 | `app/api/auth/`、`models-config/`、`plugins/`、`skills/`；对应 `lib/` store/adapters |
| 启动/桌面/发布 | `bin/pidance.js`、`instrumentation.ts`、`desktop/src/`、`.github/workflows/` |

`lib/rpc-manager.ts` 当前仅为兼容再导出，不是外部 RPC runtime。旧 `pi-runtime/`、`session-file.ts` 的迁移描述不应用作当前源码导航。子代理 CLI 桥与主 Agent 同进程 SDK 是不同职责。
