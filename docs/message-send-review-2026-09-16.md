# 用户消息发送链路审查（2026-09-16）

[文档导航](README.md) · [当前架构](architecture.md) · [隔离复现探针](message-send-review-2026-09-16.repro.mjs)

## 1. 结论与交付状态

本次仅审查、记录和建 Issue，**没有修改业务实现，也没有修复以下缺陷**。

现有单向分层可以保留；主要问题不是缺少更多层，而是**发送意图、队列事务、执行确认没有统一契约**：普通发送由 browser runtime 管理，其他发送绕过它由 hook 管理；文本进入 Pidance 持久队列，图片进入 SDK 内存队列；队列整包替换、SDK 投递和失败补偿分别执行，没有稳定条目身份和原子消费边界。

优先处理：

1. **版本与内容必须一起结算**：当前成功回执不推进版本，冲突回执只推进版本、不采纳内容。这既会使队列转引导失败，也会重新引入跨标签消息覆盖。
2. **队列转引导是服务端用例，不应是浏览器两次请求拼接**：清队成功不意味着正在提交的 prompt 已取消；失败后的补偿还可能写入另一会话。
3. **已接受、已入队、已投递、结果未知必须分开**：HTTP 成功、SDK preflight、user 消息事件不能互相替代。
4. **引导不等于所有 busy 状态都可调用 SDK steer**：手动压缩、bash、启动预检不是同一执行状态。
5. **入口必须保留用户选择与原始载荷**：回车、按钮、图片、slash 分支目前行为不一致，失败后部分路径只打印 console，输入却已清空。

GitHub Issue：[#42：统一消息发送与队列消费语义，修复转引导失败、消息丢失和重复投递风险](https://github.com/henlii/pidance/issues/42)。关联历史：[#32](https://github.com/henlii/pidance/issues/32)（已关闭的队列格式/CAS 修复）、[#23](https://github.com/henlii/pidance/issues/23)（普通提交生命周期）、[#28](https://github.com/henlii/pidance/issues/28)（综合跟踪）。本报告不是重报“没有 CAS”：Host 已有 CAS，新增发现是浏览器使用方式与队列消费事务仍然不成立。

## 2. 基线与方法

- 分支：`main`；HEAD：`49fdb542b64de76169ac4740e81437857e4e2e4d`；包版本 `0.2.29`；本地安装 SDK `@earendil-works/pi-coding-agent@0.85.1`。
- 日期：2026-09-16，时区 UTC+08:00。**读取当前工作区，而非只读 HEAD**；下述行号均对应审查时工作区。
- 审查时原有未提交变更为 18 个文件、420 行增加/121 行删除。`git diff --binary -- app components hooks lib` 的 SHA256：`0a76d2c06e35b78bae002fbd6d39ca7af2c1d716c6519cf808febabbb31a072a`。
- 原有变更：`app/globals.css`；`components/SessionLineage.tsx`、`components/SessionLineage.test.mjs`、`components/SessionSidebar.tsx`；`lib/initial-navigation.ts`、`lib/initial-navigation.test.mjs`；`lib/locales/en.ts`、`lib/locales/zh-CN.ts`；`lib/session-catalog-store.ts`、`lib/session-catalog-store.test.mjs`；`lib/session-lineage.ts`、`lib/session-lineage.test.mjs`；`lib/session-metadata-cache.ts`；`lib/session-navigation-store.ts`、`lib/session-navigation-store.test.mjs`；`lib/session-reader.ts`；`lib/subagent-sessions.ts`、`lib/subagent-sessions.test.mjs`。
- 这些变更涉及深链恢复、目录缓存预览、子会话发现与谱系显示。navigation/catalog 变更会影响最终发送目标，因此检查了其 diff 并运行相关测试；没有发现它们更改 steer/follow-up 协议或修复本文发送问题。谱系/CSS 修改按入口影响抽查，不宣称完成其独立全量审查。
- 方法：跨层静态追踪、本地 SDK 源码核对、已有隔离测试、从实际 TS/TSX 提取 callback 的可控时序探针。没有向真实模型、真实会话发送消息，没有写真实 `~/.pi/agent`，没有操作 31415/31416 或上游服务。
- 证据等级：**D** = 隔离执行当前函数/方法复现；**S** = 静态调用链证据；**H** = 尚待端到端验证的条件性风险。D 不是实机事故录像，也不是 React/HTTP/SDK 全链路集成。
- 严重度：P1 = 消息丢失/重复执行/跨会话写入风险；P2 = 发送失败、隐式改变发送行为、投影错误或条件性悬挂。

核心文件 SHA256（固定报告引用的内容，后续修改请重新审查）：

| 文件 | SHA256 |
|---|---|
| `components/ChatInput.tsx` | `df69b090c89f8a5ae93b4946a897608dc4873b3146fd5f31bfa6d5fcd5832afc` |
| `components/ChatWindow.tsx` | `3d3db80883d88622c7024240897e3b6a8d6d5f6ee4705eb583589e48a15befc6` |
| `hooks/useAgentSession.ts` | `ebc4ef41c595d1307d033cf2d86ad0aeb26ab604c8fb7096eab8c408d6872922` |
| `lib/agent-commands.ts` | `3cb32e732710f01b602db5df4809a2edfbc8522eb465127dfe6ef40e6804c4e3` |
| `lib/agent-client.ts` | `1df8638ee0a2623c52d839097fc0609d2a22115cf9db2320dbca874c3a56a94d` |
| `lib/browser-session-runtime-registry.ts` | `32e533bad4ea73e929fbc28e72b360f8809db2efc48fd71e7f63a37b0c25d37c` |
| `lib/session-service.ts` | `d8140cbfb743609eba761099356c3f4b1bba0ba9eb6a08d8791371675ad5e6ce` |
| `lib/sdk-session-host.ts` | `ee74e7f6ce962023232ea1805fb219ee9b32479fd4f9ae3d96d13463bad786cc` |
| `lib/queue-state.ts` | `4b8344319808f4754db8dfd687dda130c343e6452e99bc02eec176473b308461` |

## 3. 当前架构与四条路径

```text
ChatInput（回车/按钮/slash/附件分类）
  → ChatWindow（按 agentRunning 是否挂回调；sessionBusy 作 isStreaming）
  → useAgentSession
      ├─ 正常 handleSend → BrowserSessionRuntimeRegistry.submitPrompt
      │    → submitAgentPrompt → POST → SessionService.submitPrompt
      └─ steer / follow-up / 清队+steer → sendAgentCommand 直接 POST
           → SessionService.send（prompt 仍走 submitPrompt）
  → LiveSessionRegistry.ensureLive → SdkSessionHost.send
      ├─ prompt → AgentSession.prompt
      ├─ steer → idle 时 prompt；其余 busy 时 AgentSession.steer
      ├─ 文字队列 → prefs + Host batch → 多次 prompt
      └─ 带图 follow_up → AgentSession.followUp（SDK 内存队列）

回流：SDK/Host events → SSE → BrowserSessionRuntimeRegistry → hook/timeline
队列另有：Host state + follow_up_flushed + preferences/focus → hook queueBook
```

| 用户操作 | 实际路径与判定 | 主要契约断点 |
|---|---|---|
| 正常发送 | `ChatInput.handleSend` → hook `handleSend` → runtime `submitPrompt`，new 走创建+发送，persisted 走 wake+POST | 普通提交有 submissionId、乐观记录、取消与草稿恢复；但 accepted 无法表达压缩期间实际排队 |
| 引导发送 | 桌面快捷键 `sendQueued("steer")` → `handleSteer` → 直接 steer POST；slash 另走 `handlePromptWithStreamingBehavior` | 绕过提交事务；没有 submissionId；普通 steer 失败不恢复草稿；busy 判断不等价于 SDK 可消费 |
| 加入队列 | `handleFollowUp` 按浏览器 running/compacting、是否有图再分流 | 运行中文字整包写 Host；运行中图片写 SDK；浏览器认为 idle 时先 prompt，任意 rejected 又把文字转队列 |
| 队列发送 | 自动：Host settled/completed 或 idle late-enqueue/compaction_end → batch prompt；手动：清队 POST → 合并 steer POST | 自动与手动共享可变批次，但没有原子 claim/取消/投递确认；清队不取消已在途 SDK 调用 |

位置：`components/ChatInput.tsx:802–851,1047–1095,1218–1248,2085–2095`；`components/ChatWindow.tsx:322,576–602`；`hooks/useAgentSession.ts:1918–2105,2451–2681`；`lib/browser-session-runtime-registry.ts:979–1123`；`app/api/agent/[id]/route.ts:17–35`；`lib/session-service.ts:793–810`；`lib/sdk-session-host.ts:427–550,1418–1664`。

### “引导变队列”的证据边界

不能将所有现象归为一个缺陷：

- 正常主路径 `agentRunning=true` 且明确调用 `handleSteer` 时，当前 Host **没有直接将 steer 改为 Pidance follow-up**。可见队列重新出现，也可能是 R1/R2/R3 的旧投影/补偿，而不是 SDK 改了投递类型。
- 压缩/bash 的 busy UI 可以通过 R9 实际走 followUp；按钮又固定 followup，与桌面 Enter 的默认设置不同。
- `handleFollowUp` 的 idle 分支明确会在 rejected 后转队列（R8）。
- 队列清除失败会在发 steer 之前退出（R1）；clear 成功但后续失败又可能补回队列（R3）。

## 4. 详细发现

### R1 · P2 · D：成功写队列不推进服务端版本，自己的下一次清队被 CAS 拒绝

**位置**：`hooks/useAgentSession.ts:510–548`，`lib/sdk-session-host.ts:1625–1658`。

`updateLocalFollowUp()` 发送 `expectedRevision`，成功后只用请求的 `next` 调用 `settleSyncSuccess()`，完全忽略回执中的 `revision`。Host 每次成功更新都会增加版本。

**确定时序**：浏览器已见 v0 → 写 `[A]` 成功、Host v1 → 浏览器仍 v0 → 立即“整队引导”的清队请求 `expectedRevision:0` → Host 返回 conflict → steer 请求根本不发。连续入队、取回队列也受影响。若 state/preferences 刚好先刷新，症状暂时消失；这不是必须多标签才能触发。后台 reconcile 间隔是 15 秒（`hooks/useAgentSession.ts:257,1650`），不应依赖它补写事务的版本。

**实测**：探针 R1 执行实际 callback 和 Host CAS；确认第一次成功后客户端 0、Host 1，第二次清队抛 `input_queueConflict`。

**最小方向**：成功回执返回并原子采纳 `{items, revision}`；不能仅记请求 items，因为 idle Host 可立即自动消费。版本取自与提案配套的基线，不在延迟执行时临时读取最新版本。

### R2 · P1 · D/S：冲突只采纳版本而丢弃内容，后续有效 CAS 仍覆盖其他标签消息

**位置**：`hooks/useAgentSession.ts:474–486,528–548`；`lib/queue-state.ts:95–136`。

冲突时先调用 `observeRemoteQueue()`，它先保存远端 revision，再调用 `observeQueue()`。此时该写入 `syncs>0`、pending 非空，`observeQueue()` 拒绝采纳内容。随后 `settleSyncFailure()` 只恢复旧 confirmed。最终变成**新版本配旧内容**。

**确定时序**：浏览器基线 `[x]@v0`，另一标签已写 `[x,other]@v1` → 当前追加 mine 冲突 → 本地仍 `[x]`，但已见版本 v1 → 再追加 next 发 `[x,next]@v1` → CAS 合法通过 → `other` 被删除。

**实测**：探针 R2 复现完整上述两次写，最终 Host 为 `[x,next]`，不是 `[x,other,next]`。

**相关静态旁路**：`hooks/useAgentSession.ts:2750–2751,2773–2774` 在 revision 判新旧之前先 `observeQueue()` 写内容，旧 preferences 即使后续被拒也可能已污染账本；挂载请求还可能被紧接的 `observeRemoteQueue()` 以“当前代次”绕过捕获的请求代次。`hooks/useAgentSession.ts:2768` 调用纯函数 `acceptRemoteQueue()` 却不保存返回值，不能实现注释声称的版本推进。这些旁路尚未做真实 focus/reconnect 集成复现。

**方向**：把版本、内容、请求代次、pending 结算统一为一次 reducer 状态转移；冲突先结束对应 sync，再采纳权威基线并保留用户尚未接受的操作。优先操作式 append/remove，避免提交整份陈旧数组。

### R3 · P1 · D/S：队列转引导非原子；失败回滚可跨会话，未知结果会被当作未发送

**位置**：`hooks/useAgentSession.ts:2633–2681`，`hooks/useAgentSession.ts:511–512`；`components/ChatInput.tsx:1073–1095,1535–1569`。

`handleSendQueueAsSteer()` 捕获 A 的 sid 与 originalQueue，先 `updateLocalFollowUp([])`，再向 A 发 steer。失败后却调用没有 sid 参数的 `updateLocalFollowUp(originalQueue)`，此函数重新读取当前会话 ref。

**实测**：探针 R3 在清 A 成功、steer 在途时切 B，再使请求失败，记录到第二次队列写目标 B、内容是 A 的 originalQueue。探针注入回调环境，不是跨页浏览器录像；如果界面完全卸载旧 hook，具体可见时序不同，但 callback 的目标身份缺陷成立。

**其他风险**：
- 清队落地后页面关闭/进程断开，尚未发 steer 的原消息已不在持久队列。
- steer 已被接受但响应丢失时，catch 盲目恢复原队列；以后会重复执行（H，未做断网真实提交复现）。
- 回滚本身失败被空 catch 吞掉，原消息既已清队又未回填输入；只有 extraMessage 被显式恢复。
- 清队/取回按钮无事务中禁用状态；串行的是每次队列写，不是“清队+发送”整个操作。

**方向**：服务端提供以 sessionId、操作 ID、queue item IDs 为输入的原子 dispatch/promote 用例；浏览器不执行反向整包补偿。unknown 必须查询原操作，不自动重发；所有草稿与恢复按捕获的会话/draftKey 定位。

### R4 · P1 · D：清队只能复位批次，不能取消已经发出的 prompt

**位置**：`lib/sdk-session-host.ts:453–490,541–554,1643–1651`。

`set_follow_up_queue` 遇到 flushing 时调用 `abortFollowUpFlush()`，只清理批次字段；`sendNextFollowUp()` 已经调用的 `this.send({type:"prompt"})` 并未取消，也没有 generation/claim 检查。

**实测**：探针 R4 把 prompt 接受点挂起 → 清队成功并使 flushing=false → 放行旧 prompt → 原消息仍被接受。随后再发送合并 steer 可造成同一业务消息执行两次（后半段组合风险未做真实 SDK 双请求录像）。

**方向**：清除 waiting 条目与取消 claimed/dispatching 条目必须区分。已 claim 的条目不能被当作“清掉即可转引导”；与自动 flush 使用同一个 Host 状态迁移边界，并让客户端收到明确 consumed/in-flight 冲突结果。

### R5 · P1 · D/S：投递身份由可变 cursor/正文决定，确认会删除错误条目

**位置**：`lib/sdk-session-host.ts:473–481,499–539,891–898`。

两个独立缺陷：

1. `sendNextFollowUp()` 在 await send 后调用 `removeDeliveredFollowUp()`；后者读取**当前** cursor，而不是本次提交捕获的条目。若 user message_end 已调用 `confirmFollowUpFlush()` 把 cursor 从 A 推到 B，A 的 await continuation 会删除 B。探针 R5 复现：确认 A 后队列仍 `[B]`；放行 A 回执后队列变 `[]`，即使尚未提交 B。真实 SDK 的 preflight/user-event 相对时序需补集成测试；错误方法组合已经可执行复现。
2. `followUpFlushAsOne` 以 `new Set(followUpFlushOriginal)` 过滤队列。快照里有一个 same，期间又新增一个 same，会把两个都删除。探针 R5 第二项直接执行原方法复现。

此外，`message_end` 只判断 `role === "user"` 就确认当前 flush，未检查这是当前队列条目还是额外 steer/扩展注入消息（S）。

**方向**：条目用稳定 ID；每次发送捕获 itemId/submissionId 与 batch generation，所有确认按此匹配。原消息、SDK 转换后的正文、UI key 不得互相充当身份。是否合并仅影响 prompt 载荷，不改变待消费条目的集合身份。

### R6 · P2 · D/S：Host 把压缩/bash 等 busy 当作可消费引导的 agent run

**位置**：`lib/sdk-session-host.ts:284–293,1606–1622`；SDK `dist/core/agent-session.js:616–621,1016–1025,1046–1058`。

Host `isRunning()` 为 promptRunning / bashRunning / SDK isStreaming / isCompacting 的并集；steer 在这个并集内直接调用 SDK steer。SDK steer 只入内存队列，不负责启动一个 agent run。

**实测**：探针 R6 设置 `isStreaming=false,isCompacting=true`，Host 返回成功 null、只调用 SDK steer，没有建立普通 prompt 或产品文字队列。手动压缩结束时 Host 仅检查产品 follow-up 队列，不负责启动该 steering 项。因此存在“接口已接受，引导却没有当前执行轮次消费”的悬挂风险；Host 若销毁，SDK 内存项还可能消失，不能保证再发一条就能恢复。bash-only 的同类分派由静态条件可见，未单独实测。

**限定**：SDK 0.85.1 的 `isStreaming` 实际返回 `_isAgentRunActive`，不能把它误解为“当前有 token”；运行中工具阶段已属于 active run，不应再创造第二套工具执行判断。

**方向**：区分 agent-active / manual-compaction / bash-only / starting / idle；明确每种状态对 steer 的允许、拒绝或显式延迟策略。不要无回执地隐式降级。

### R7 · P1 · D/S：引导失败时输入已经清空，处理函数只删除乐观记录

**位置**：`components/ChatInput.tsx:1047–1069`；`hooks/useAgentSession.ts:2451–2488,2500–2527`。

UI 不 await onSteer/onPromptWithStreamingBehavior，立即 `clearInput()`。普通引导失败 catch 只 `dropLocal` 和 `console.error`，没有错误通知，也不恢复文本/图片。slash 引导失败也有仅 console 的出口；fallback prompt 的 receipt 未验证 status。

**实测**：探针 R7 执行实际 handleSteer 的失败分支，只发生乐观记录删除。结合 UI 同步清空语句，足以解释“按了引导后消息没了”。尚未跑真实浏览器断网/图片恢复测试。

**方向**：所有发送回调统一返回可辨结果，输入清理与恢复按提交事务处理；保存完整载荷与原始 draftKey。错误不应只在开发者 console 可见。

### R8 · P2（运行态污染部分 P1）· D/S：prompt rejected 缺少原因，被无条件解释为“应该排队”

**位置**：`lib/session-service.ts:798–810`；`lib/agent-commands.ts:41–47`；`hooks/useAgentSession.ts:2552–2581`；`lib/sdk-session-host.ts:1450–1550`。

Service 除跨进程 locked 外把 submitPrompt 异常都压成 `{status:"rejected"}`；receipt 无 reason。hook idle follow-up 路径把任意 rejected 的文字写队列，无法区分 busy、无模型、鉴权、输入扩展错误等。

**实测**：探针 R8 返回无有效模型也可能得到的通用 rejected，callback 仍写产品队列。这证明客户端分类缺失，并不声称测试实际调用了鉴权失败 API。

**额外静态风险**：两个标签/过期浏览器向正在运行的 Host 发普通 prompt 时，Host 没有在调用 SDK 前完成同会话忙碌门禁。SDK 拒绝未带 streamingBehavior 的并发 prompt，Host catch 却写全局 `lastStopReason="error"`、hold=true、发 `prompt_error/prompt_done`；被拒的新提交可能污染本来仍在执行的 run 的状态和后续队列投递。未执行这一完整真实 SDK/双标签时序，不列为已观察事故。

**方向**：拒绝原因结构化；只允许在明确的原始 intent 政策下处理 busy，不把任意失败转队列。单次提交失败不能完成/停止另一个 run；normal/steer/enqueue 的准入由服务端同会话执行入口集中判断。

### R9 · P2 · D/S：快捷键、发送按钮与 busy 回调挂载不一致

**位置**：`components/ChatWindow.tsx:322,576–579`；`components/ChatInput.tsx:802–815,1218–1248,2085–2095`。

- `isStreaming` 实际传 `sessionBusy = agentRunning || bashRunning || isCompacting`；但 onSteer/onFollowUp 仅在 agentRunning 时挂载。
- 手动压缩/bash-only 时快捷键的 steer/followUp 分支进不去，转 `handleSend()`；该函数在 busy 下对纯文本固定调用 `onPromptWithStreamingBehavior(base,"followUp")`。
- 桌面 Enter 尊重 streamingEnterDefault，主发送按钮在 streamingSend 时固定 followup。手机 Enter 仅换行，按钮也因此固定走队列；“默认引导”设置实际限定桌面 Enter，并非所有发送入口。
- 有队列时 Ctrl/Cmd+Enter 总是先整队转引导，优先于“与默认相反”的快捷键规则；这在注释中属于既有行为，报告建议明确文案，不把已有产品规则本身当作未经授权可更改的 bug。

**实测**：探针 R9 执行 busy 下 handleSend fallback，实参是 followUp。触发快捷键的前置路由为静态证据，尚未跑键盘 DOM 集成。

**方向**：复用一个 UI 意图解析函数，并显式声明按钮/移动端/快捷键差异。不要将“没有回调”当作运行态分类器；状态竞争时保留 intent，由服务端回执说明最终处理方式。

### R10 · P1/P2 · D/S：图片绕过产品队列，图片单独排队被直接丢弃

**位置**：`hooks/useAgentSession.ts:2535–2551,2568–2572,1872–1878`；`lib/sdk-session-host.ts:1319–1323,1661–1664`；`components/ChatInput.tsx:1047–1069`。

- 文字排队调用 `set_follow_up_queue`，图片+文字调用原生 `follow_up` → SDK `session.followUp()`。
- Host state 的 followUp 只投影产品队列；hook 对 SDK queue_update.followUp 不用于面板。带图等待项不能通过现有队列块统一取回/转引导，也不受产品 prefs hold/恢复机制管理。SDK 内存队列不等于持久产品队列。
- **图片无文字**：UI 允许 attachedImages 非空而 base 为空进入 sendQueued，但 handleFollowUp 的 `if (!text) return` 发生在处理 images 前；UI 随即清空图片。探针 R10 执行实际 callback 确认提前返回、未发请求。
- 图片+文字失败仅 prependText，图片不恢复。运行中路径也没有携带普通发送的 binaryBlocks 原始附件信息。

**方向**：一个产品队列载荷支持 text+images/附件引用；避免把 Base64 永久堆到 prefs，可复用已有上传存储和受控引用。若暂时不支持图片排队，必须在清理输入前明确拒绝且保留附件，不能用第二个不可见队列假装支持。SDK 仍拥有执行与原生消息写入，不向 JSONL 塞业务队列字段。

### R11 · P2 / 架构风险 · S：提交身份与错误契约只覆盖正常发送，不能支撑 unknown 对账

**位置**：`lib/agent-commands.ts:18–47`；`lib/agent-client.ts:12–30,33–68`；`lib/browser-session-runtime-registry.ts:979–1123`；`lib/session-service.ts:469–499,1076–1116`；`lib/sdk-session-host.ts:228–231,1419–1425`。

普通 prompt 带 submissionId；steer/follow_up 和整包队列写没有。Host 去重 map 仅活在该 Host 中，重建后不保留。Service 已有新建会话提交记录与取消设施，因此不能再声称“所有提交完全没有注册表”；但普通已有会话 send/steer/队列消费并没有共享完整同一事务语义。

同一 UI 操作横跨两次请求时既不能查询“是否已接受”，也不能据此安全决定恢复队列。R3、R4、R7 的补丁若不解决此项，会继续依赖猜测。

**方向**：复用现有 runtime/Service 提交设施扩展到所有意图，明确幂等有效范围、unknown 恢复和新建/已有会话的区别。不要承诺仅靠内存 map 实现跨崩溃 exactly-once。

### R12 · P1 · S：持久化失败被吞掉，接口仍把内存队列当作已确认队列

**位置**：`lib/sdk-session-host.ts:413–424,1649–1658`。

`persistFollowUpQueue()` 捕获 `updatePidancePref()` 的异常后只打印 console；调用方已更新内存/revision，随后仍返回 `{ok:true,queued,revision}`。磁盘不可写、空间耗尽等条件下，浏览器会按成功清理草稿，但新队列没有可靠落盘，Host 重建后会丢失该条目或恢复旧队列。

这是静态确认的错误传播缺陷，未在真实磁盘上制造故障；不声称用户当前环境已经发生磁盘错误。`setFollowUpHeld()` 也采用吞错模式，重建后 hold 策略可能与内存期意图不一致，需同步纳入故障注入测试。

**方向**：持久化成功是 durable queued 回执的前置条件；失败保留可恢复载荷并返回结构化错误，不能先确认再靠 console 补救。对 queue/hold 写入注入异常，断言没有虚假的成功确认，重建后不会自动重复执行旧队列。

## 5. 建议的最小架构收敛（待实施，不是既成决定）

### 5.1 保留层次，收回分散的职责

| Owner | 应负责 | 不应继续负责 |
|---|---|---|
| ChatInput | 解析用户动作、收集完整载荷、展示结果 | 根据回调缺失改变 intent；失败后无条件清输入 |
| useAgentSession | 订阅视图、绑定事件与草稿 UI | 队列事务、清队后发消息的补偿 saga |
| BrowserSessionRuntimeRegistry | 每会话提交 ID、请求生命周期、乐观/未知状态、原会话草稿恢复 | 独立决定服务端当前是否应 steer/queue |
| SessionService | 可写门禁、统一提交用例、结构化 receipt/查询 | 吞掉所有 rejected 原因 |
| Registry | host 启动/单写者租约/lifecycle | 重新实现消息执行规则 |
| SdkSessionHost | 同会话准入、产品队列 claim/dispatch/ack、SDK 映射 | 以正文或全局 cursor 推断哪条已投递 |
| Pi SDK/SessionManager | prompt/steer 执行与 JSONL/tree 唯一 writer | 被旁路添加产品队列元数据 |

**注意**：“串行化”是对准入、claim、版本更新等短状态转移串行，不是持锁等待整轮模型完成，否则会阻止 steer/abort 并制造自等待。

### 5.2 一个提交信封，一套明确结果

建议在已有命令类型上收敛，示意而非要求新造框架：

```text
Submission:
  submissionId + session target + intent(send|steer|enqueue|dispatchQueued)
  payload(text + media) 或 selected queue item IDs
  对队列操作携带与提案配套的 expectedRevision

Receipt:
  submissionId + sessionId + effective action
  accepted / queued / rejected / unknown
  reason（busy/compacting/locked/invalid/auth/...）
  需要时带权威 queue snapshot（items + revision）

Queue item:
  stable ID + payload + waiting/claimed/accepted（状态设计按实现需要收敛）
```

SDK 接受不必等于已经写出 user 消息；扩展 input handler 也可消费输入而不生成正常 user 消息。业务需要定义各 receipt 的含义，不能只对字符串 `status` 做真值判断。崩溃跨越 SDK side effect 与 sidecar 持久化时，如果不能证明已投递，保留 unknown 待对账，不盲目重试。

### 5.3 状态/意图矩阵

下面是建议边界；标“需明确”的策略应在实施前决定，不代表本次擅改产品行为。

| 服务端状态 | send | steer | enqueue | dispatchQueued |
|---|---|---|---|---|
| idle | 新 prompt | 新 prompt，回执说明 effective action | 现产品立即投递；与“仅存队列”含义需明确 | claim 所选条目后新 prompt |
| agent-active（含工具执行） | 明确 busy；不能污染原 run | SDK steer | 产品持久队列 | 与自动 flush 互斥 claim，再 steer |
| starting/preflight | 保持首提交单飞/明确 busy | 明确等待归属或拒绝，不能无 owner 悬挂 | 可入持久队列 | 等待可判定的执行状态 |
| manual compaction / bash-only | 明确拒绝或带 queued 结果 | 明确拒绝或显式延迟；不能无声 SDK 入队 | 若允许，保留载荷并显示等待原因 | 同左，不能先删待发送数据 |
| settling / flush claim 在途 | 不再用旧 UI running 推断 | 依据当前 claim/run 决定 | 操作式追加不覆盖批次 | 已 claim 返回明确冲突/处理中，不重复发送 |
| held（abort/error） | 预检成功后解除 hold | 按 active/idle 与解除策略明确处理 | 不自动执行，显示 hold | 显式恢复/发送，不由失败补偿触发执行 |

### 5.4 实施顺序与可观察验收

- **D1：修复队列基线结算与请求归属（R1/R2/R3）**。
  - A1：无中间 GET 时连续入队→转引导成功；回执版本立即更新。
  - A2：两标签冲突后，版本和内容一起更新；再次追加不覆盖其他条目。
  - A3：旧 preferences/state 到达不得修改较新基线；A 发起的失败恢复只能修改 A，不能污染 B。
- **D2：Host 原子队列消费与稳定条目 ID（R3/R4/R5/R12）**。
  - A4：用可控 Promise 在 flush 预检前后插入清队/转引导；每条业务消息最多被接受一次，已在途时返回明确状态。
  - A5：重复正文仍是不同条目；batch 期间追加同文项不能被误删；A 的回执/无关 steer user event 不得确认 B。
  - A6：页面关闭、HTTP 响应丢失、持久化失败都不把唯一副本删掉；unknown 不自动重复执行。
- **D3：统一发送准入、回执、错误与运行状态（R6/R8/R11）**。
  - A7：idle/active/preflight/compacting/bash/settling/held 各状态覆盖四种 intent；拒绝新请求不改变既有 run/hold。
  - A8：无模型/鉴权失败不会被误排队；明确 queued 与 accepted；同一 submission 的查询/重试不另发一次。
- **D4：统一 UI 输入与媒体路径（R7/R9/R10）**。
  - A9：桌面默认配置、Enter/Ctrl+Enter、队列非空、按钮、手机 Enter/按钮的行为有明确且一致的可测规则。
  - A10：纯图、图文、上传文件、slash 在正常/引导/队列/队列转引导中不静默丢载荷；失败恢复原会话完整草稿。
  - A11：等待队列可在切换/刷新/重连后重建，文字与带图项可统一取回和转引导；hold 原因可见。

## 6. 多端与跨层影响

| 产品面 | 本次评估 | 后续验收 |
|---|---|---|
| 桌面浏览器 | 共享 hooks/Host 路径；另有桌面 Enter 默认与 Ctrl/Cmd 分叉 | 无头浏览器键盘、连续点击、网络失败、切 A/B |
| 手机浏览器 | Enter 不发送、按钮固定 followup；同一后端缺陷；后台恢复走 preferences/state | 390px 视口、触摸按钮、visibility/focus、SSE 断连后恢复 |
| Electron/Windows 壳 | 发送逻辑复用网页与同一服务端，本次未发现专属 bridge 发送分叉；未做 Windows 真机验证 | 自动化共享页逻辑；壳焦点/恢复差异按需补壳测试，真机只作附注 |
| 多标签 | R2 直接影响共同队列；Host 与 UI 之间有不同版本、不同 pending 状态 | 两独立浏览器 runtime、并发入队/转引导/自动 flush |
| 31415/31416 跨进程 | 单写者租约仍需保留；本次不改、不重启两实例 | 后续隔离进程/临时 agentDir 验证，不混用真实会话 |

本次仅新增审查文档和复现探针，未修改任何产品面；免部署。后续实际修复须同步共享路径与命中的 UI 分叉，并按项目规则部署 31416。

## 7. 验证结果、边界与复跑

### 已有定向测试

使用 `/home/moss/.nvm/versions/node/v24.18.0/bin/node`（默认 shell 的 Node 18.19.1 不符合项目要求），在临时 `PI_CODING_AGENT_DIR` 下运行：

```bash
node --test \
  lib/sdk-session-host.test.mjs \
  lib/queue-state.test.mjs lib/queue-merge.test.mjs \
  lib/agent-commands.test.mjs lib/agent-client.test.mjs \
  lib/browser-session-runtime-registry.test.mjs \
  hooks/useAgentSession.lazy-create.test.mjs \
  lib/initial-navigation.test.mjs \
  lib/session-navigation-store.test.mjs lib/session-catalog-store.test.mjs
```

**138/138 通过**。Host 测试使用临时目录及本地假 provider，不调用真实模型。日志中的 `sdk host destroy listener error: Error: boom` 来自既有“订阅者抛错不阻断其他订阅者”用例，是预期注入，不是失败。临时运行目录和日志已删除。

这些测试覆盖正常入队、自动 flush、运行中/idle steer、Host CAS 拒绝等，但没有覆盖本文列出的浏览器成功回执+冲突结算+后续写入，以及清队与在途批次的组合；部分 receipt 检查还是源码字符串断言。通过不意味着消息发送链路无缺陷。

### 新增审查探针

```bash
node --test docs/message-send-review-2026-09-16.repro.mjs
```

**11/11 通过，即全部复现了所检查的缺陷特征**：R1、R2、R3、R4、R5 两项、R6、R7、R8、R9、R10。脚本使用 TypeScript AST 提取实际 callback 并擦除类型，注入 refs/HTTP stub；Host 使用实际原型方法，替换存储、计时器与 SDK 网络副作用。不是复制一份算法作为假实现。

**重要：这些断言故意检查当前错误行为，绿色表示缺陷被复现；修复后应转换为正确行为回归断言，而不是保留错误期望让 CI 永久“通过”。**

未执行真实 React DOM/浏览器/Windows 壳端到端，没有模拟真实服务崩溃、SDK side effect 与磁盘提交之间的断电窗口；R3 响应丢失双发、R5 SDK 特定事件顺序、R8 并发请求污染原 run 等端到端风险已分别注明。未跑全仓 lint/typecheck/build：本次不改业务代码，结论不冒充全仓发布验收。

## 8. 与现有规则/文档的差异

runtime Skill 写“产品队列不复用 Pi followUp”，实际图片分支明确使用原生 follow_up；“引导运行中 steer、空闲 prompt”又没有区分压缩/bash。架构文档写 `useAgentSession` 不拥有提交生命周期，但当前非普通 prompt 的主要事务仍在 hook。应以实现证据为准；本次记录差异，不把既有规则默认为已经实现，也不未经实施同步改规则宣称问题解决。

后续完成标准是 D/A 对应的自动化证据与修复，而不是单纯缩短 hook、增加接口层或只重跑现有绿色测试。
