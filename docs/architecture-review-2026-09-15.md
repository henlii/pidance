# 会话架构静态审查（2026-09-15）

[文档导航](README.md) · [当前架构](architecture.md) · [安全边界](security.md)

## 基线、状态与范围

- 基线：`d55733d`，加当时未提交的 `components/MessageView.tsx`、`components/MessageView.test.mjs`、`hooks/useAgentSession.ts` 修改。
- 方法：只读追踪代码、调用方和测试；未运行测试、构建、服务或真实会话。
- 深入范围：Service → registry → Host、SSE、浏览器提交/恢复、队列、租约、Extension UI；管理面与 Electron 为边界抽查，不是全仓安全审计。
- 本文是审查记录，不是已修复清单。以下项目均为**待处理 / 待回归**；文档整理没有实施修复。
- 行号对应上述工作区基线，后续代码可能移动；同时使用文件和符号定位。
- P1 表示写入一致性、后台执行或生命周期高风险；P2 表示条件性交互异常/恢复问题。代码可确认机制不等于已观察到真实事故。

## 总体判断

主干分层可以保留。问题集中于跨模块契约：谁拥有 writer、何时真正完成 teardown、异步结果属于哪个会话、失败提交如何对账。优先修复这些契约，不先按文件大小做大重构。

## R1 · P1：销毁等待契约提前返回

**证据**：`lib/sdk-session-host.ts:1883–1896` 的 `destroyAsync()` 在 `activeCommandCount > 0` 时只排定时器便返回；`lib/session-service.ts:381–405` 的 `withOfflineWriter()` 把 await 返回当成 writer 已释放。

**触发/影响**：活跃命令与离线写交错时，旧 manager 仍存活，新 manager 已打开。同 PID 租约允许再次 acquire，不能承担进程内独占。可能破坏单写者约束；未证明已发生 JSONL 损坏。

**方向**：区分“请求回收”和“等待 teardown”，将启动/销毁/离线写纳入每会话互斥。Host 导航调回 Service 存在重入，不能简单等待命令计数归零造成自等待。

## R2 · P1：销毁回调被 SSE 覆盖

**证据**：`sdk-session-host.ts:267–269` 的 `onDestroy()` 为单槽赋值；`live-session-registry.ts:433` 注册清理后，被 `app/api/agent/[id]/events/route.ts:77` 覆盖，多条 SSE 又互相覆盖。

**触发/影响**：正常订阅即可丢失 registry 原始回调；多个订阅仅最后一个得到销毁通知，死 Host、流和心跳可能残留。

**限定**：`destroyAsync()` 最后的 running 通知仍可能释放租约，不应描述为“必然永久占锁”。

**方向**：多订阅、可退订的销毁通知；registry 清理独立于 HTTP 端点生命周期。

## R3 · P1：租约超时后旧 writer 没有失权停写

**证据**：`session-running-lease.ts:175–176,228,256`。活 PID 心跳超过 20 秒也判过期；旧 owner 发现新 owner 时，heartbeat 仅返回。

**触发/影响**：A 暂停/长阻塞 → B 接管 → A 恢复，旧 SDK writer 没有 fencing 或强制停写，可能跨进程并发写。

**方向**：不能只保护租约文件原子写；必须保护完整 writer 窗口。无法 fencing 底层写时，优先避免接管仍存活的 owner。

## R4 · P1：新会话首发 Stop 无法定位服务端运行

**证据**：`browser-session-runtime-registry.ts:968–990` 的 `createAndPrompt` 收到响应才取得真实 ID；`hooks/useAgentSession.ts:2099–2143` 的 Stop 在 `liveId` 为空时不发服务端 abort；新建 Route 未接入请求取消信号。

**触发/影响**：POST 已到服务端但响应未回，用户 Stop 只取消 fetch，后台可能继续调用模型/工具，浏览器失去立即定位真实运行的能力。

**相关限制**：Host `promptReceipts` 只在单个 Host 内去重；重建后相同 submission ID 不能保证不重复执行，新建也无 submission 级创建去重。

**方向**：服务端统一 submission 身份及状态查询/取消；unknown 不自动重发。客户端 Promise 取消不是后端停止证据。

## R5 · P2：当前队列格式不被启动恢复识别

**证据**：`sdk-session-host.ts:385–393` 写 `{items, revision}`；`live-session-registry.ts:332–350` 的 `hasQueuedText()` 只接受数组，`instrumentation.ts` 使用该扫描恢复。

**触发/影响**：重启漏掉当前格式的非空队列。磁盘数据仍在，后续显式启动 Host 可能水合；不是持久化队列被删除。

**方向**：共用版本化解码器，测试实际 writer 输出 → startup recovery。当前恢复测试 `sdk-session-host.test.mjs:142` 仍使用旧数组。

## R6 · P2：多标签整包队列更新丢失

**证据**：`hooks/useAgentSession.ts:500–512` 发整份 `items`；`sdk-session-host.ts:1584–1601` 直接替换，不校验 expectedRevision。

**触发/影响**：A/B 同见 `[x]`，分别提交 `[x,a]`、`[x,b]`，后到写覆盖前者。客户端读侧 revision 守卫不能阻止服务端接受旧基线写入。

**方向**：服务端 CAS/冲突响应，或使用稳定队列条目 ID 的操作式命令。

## R7 · P2：reconcile 附属状态写入当前而非原会话

**证据**：`hooks/useAgentSession.ts:1407–1415,1547–1573`，压缩态写入缺少 sid 守卫；metrics seed 使用当前 `sessionIdRef`。

**触发/影响**：同一 hook 生命周期内 A 请求发出后切 B，A 响应仍可覆盖 B 压缩态及吞吐读数。Registry stale 只判断 A 的 run，不判断当前视图是否仍为 A。

**方向**：投影统一传 session ID 与 run/请求代次。基线未提交修改已补部分 queue/state 入口，但未覆盖此路径。

## R8 · P2：custom UI 没有恢复快照

**证据**：`web-extension-ui.ts:227–297` 的 `custom()` 仅存输入/完成函数并发 SSE；Host `:241–242,1275–1277` 只回放 `pendingSnapshot`，custom 不在其中。

**触发/影响**：刷新/切换后，服务端活动面板可能仍等待输入，但浏览器无法恢复；没有新 render 时无法自行出现。

**限定/方向**：普通 select/confirm/input/editor 已有快照。为 custom 保存最后可重建投影并恢复，不扩大成所有扩展交互不可恢复。

## 其他发现

| ID | 等级/类别 | 证据、影响与方向 |
|---|---|---|
| R9 | P2 / 低频并发 | `session-service.ts:949` 用毫秒时间戳生成新建临时 key；同毫秒请求可错误合并到同一 Host。使用唯一 ID，并测试不同 cwd 并发新建。 |
| R10 | 长期资源风险 | browser registry 的 slots/submissions/timeline 无常规淘汰入口，rekey 删除不是空闲回收。增加有界回收，保留在途/未持久化状态；未测得具体内存增长量。 |
| R11 | SDK 兼容风险 | `pi-session-io.ts:23–31,150–152` 使用 `_rewriteFile`/`flushed` 私有实现及 optional call。仍经 manager 写入，不等于裸写 schema；升级需专门兼容测试。 |
| R12 | 条件性安全风险 | `request-guard.ts:248` 无密码回环依据 Host 而非 TCP 来源；仅在绕过 CLI 门禁、无密码且被网络暴露等条件下成立。正常 CLI 有非回环密码门禁，不能删掉这项限定。 |
| R13 | 错误契约异常 | `app/api/agent/new/route.ts` 用 `String(error)` 匹配无 `Error:` 前缀的消息，缺 cwd 等预期 400 可落为 500。统一类型化错误/消息提取。 |
| R14 | P2 / 深链不可达 | `?session=<id>` 只在目标会话已落在侧栏首页列表时才恢复：`components/SessionSidebar.tsx:653` 用 `allSessions.find(...)` 定位，命中不了就 `found: false`（且 `restoredRef.current = true`，后续分页加载到该会话也不会重试）。旧的/未在当前页的历史会话通过 URL 打开会静默回到空工作区（实测同一 URL 先成功后失败）。方向：id 不命中列表时改用服务端 `info` 按 id 解析，或对 not-found 保留可重试状态。 |
| R15 | P2 / 不可自愈 | 上游拒绝请求但不返回原因（无 body 的 400/413/422）时，Pi SDK 的溢出识别是**带 `^` 锚定**的文本正则，Responses 路径错误被包成 `OpenAI API error (400): 400 status code (no body)` 后不命中，遂不走「压缩后重试」；阈值判定又拿估算值比声明窗口（实测 `cpa/grok-4.6` 声明 500000，而 ≈381K 的会话已被上游拒），于是同一超限请求被反复重发，会话对该模型死锁，只能手动换回大窗口模型。已修：`lib/provider-error.ts` 分类 + 错误卡片提示与人工压缩入口 + 模型选择器占用对比（见 381f316）。上游 SDK 侧仍建议提 issue（用结构化状态码/错误体而非只去掉 `^`）。 |

文件访问全开放是当前显式信任策略，不另报为目录穿越漏洞，但 README 不应宣称项目目录沙箱。

## 建议回归矩阵

| 场景 | 应验证的不变量 |
|---|---|
| 活跃命令期间离线写/删除 | teardown 完成前不得打开另一 writer 或 unlink |
| 双 SSE 后销毁 Host | registry 清理与全部流关闭，不残留心跳 |
| writer 暂停超过 TTL 后恢复 | 不能出现两个有效 writer |
| 新建首发响应前 Stop | 服务端执行与取消可定位、可对账 |
| 实际格式队列重启 | 非 hold 恢复，hold 不投递，无重复 |
| 双标签队列更新 | 冲突可见，不静默覆盖 |
| A→B 迟到 reconcile | A 结果不修改 B 投影 |
| custom UI 重挂 | 面板可恢复，旧请求输入不作用于新请求 |
| 同毫秒两个新建请求 | 返回不同 Host/ID，cwd 不混用 |

已有测试不等于这些契约都已验证：Host 部分测试仅检查源码关键字，Service 销毁测试使用保证等待的 mock，浏览器 abort 测试主要覆盖本地结算。补真实模块接线的窄集成测试，不以源码包含某个变量名作为行为证据。

建议实施顺序：写入生命周期 → 销毁订阅 → 创建/停止事务 → 队列契约 → 投影与扩展恢复。修复时另行记录对应提交与可重复验证结果，不覆盖本次历史基线。
