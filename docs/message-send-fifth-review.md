# #42 第五轮复核：消息所有权与移交

## 结论

**H1–H3 的原始时序已经按新规则修好，可以认可这一段修复。** 仍不能关闭 #42：新引入的 `uncertain`（结果未知）状态没有收口，后续一次成功召回后，客户端仍投影已不在服务端的队列，随后入队会把这些条目重新写回去，形成「草稿 + 队列」双份。

基线：HEAD `5b3b6ca`，增量 `641caea..HEAD`（`7d06c7e`、`5b3b6ca`），含当前原有 dirty 工作区。`git diff --binary -- app components hooks lib` SHA256：`592be4a7f4d49ca494f270c38cb1e7ae68cc2567660a394665308fdc70a46a15`。保留既有未跟踪报告与 `public/attach-picker-test.html`。

本轮只新增本报告和 `docs/message-send-fifth-review.repro.mjs`；未修改业务代码、未部署。Node v24.18.0。行号对应当前本地代码。

## 已验证修复（H1–H3）

仓库内交错测试覆盖了第四轮要求的核心矩阵，本轮定向套件 **175/175 通过**，`tsc --noEmit` 通过。规则与实现一致：

| 规则 | 实现 | 证据 |
|---|---|---|
| 只有从未被队列受理的载荷才能变回可重发草稿 | `settleQueueWrite` + Host `admittedAttemptIds` 同一次落盘 | `hooks/useAgentSessionQueue.test.mjs` H1-a/b/d |
| 召回只归还服务端 `recalled` 条目；claimed 跳过 | `recall_follow_up_queue` 经 Route `parseTypedMessageCommand`；回执 `recalled`/`skipped` | H2-a/b/c；本轮 I5 |
| 冲突采纳权威快照，不把旧整包配新版本 | `syncQueueWrite` 唯一通道 | H1-a |
| 切会话后确定拒绝仍回原 sid | `restorePayloadToSession(sid, …)` | G3 |
| 附件成功只结算发送时那份草稿 | `sentDraftRef` + `settleSentDraft` | `ChatInputSendOwnership.test.mjs` H3-a/b/c/d |

第四轮探针 `docs/message-send-fourth-review.repro.mjs` 已因抽取不到 `syncQueueWrite` 失效；等价场景以仓库测试为准，不把旧探针变红当成产品回退。

## 残留

### I7 · P1：unknown 写入后的成功召回，仍显示并可能重写已取回的内容

位置：`lib/queue-state.ts:183–185,429–437,446–447`；`hooks/useAgentSession.ts:2648–2669`。`hasUncertainWrite` 已定义但生产路径未使用。

时序：

1. 队列 `[keep]`。用户再入队 `uncertain`，请求在途网络失败 → 客户端将该次提案标 `uncertain`，服务端仍是 `[keep]`，草稿不恢复（符合「未知不复制」）。
2. 用户召回。发送时按权威 `items` 取 id，服务端清空 `keep` 并在回执 `recalled` 中交还。
3. `settleQueueWrite(accepted)` **只移除召回自己的 pending**，unknown 那次提案仍在。
4. 投影再次变成 `["keep","uncertain"]`，而 Host 队列已空。

之后用户再入队任何新消息时，`payloadsForWrite` 用最新 pending，会把 `keep`（已在草稿）和从未到达服务端的 `uncertain` 整包写回。

**证据**：本轮探针 I7，真实 hook + 临时 Host：召回后 `host.followUpQueue=[]`，`hasUncertainWrite===true`，`projection===["keep","uncertain"]`。无真实模型。I3 表明后续整包 set 不会被 unknown 挡住。

**修复/验收**：权威成功快照必须清掉所有不兼容的 pending（或禁止 unknown 未确认时的新写入，并提供重试同一 `submissionId` 的入口）。回归：unknown 入队 → 召回 → 投影与 Host 均为空（或仅待确认且不可再 set）→ 再入队不得复活已召回的 `keep`。

### I1 · P2：`set_follow_up_queue` 检查了 submission 缓存却不写入

位置：`lib/sdk-session-host.ts:2458–2474`。dispatch/recall/steer 会 `commandReceipts.set`，set 成功回执只 `return write`。

同一 `submissionId` 在 revision 已前进后再次提交，会作为新写入生效。当前浏览器每次 `proposeQueueWrite` 都新生成 id，主路径不一定碰到；Host 注释承诺的幂等对 set 不成立。

**证据**：I1 在 `promptRunning` 挡住自动 flush 后，同 id 第二次写入把队列从 `[once]` 变成 `[once,twice]`。

**修复/验收**：成功与冲突回执都要按 submissionId 缓存；同 id 必须返回第一次结果，不得应用新 items。

### I4 · P2：整包 set 仍按正文 first-fit 对齐，不发送服务端 item id

位置：`lib/session-queue.ts:308–341`。召回已改 itemIds；set 仍是正文（+ 附件路径）。同文无图的两条，省略其中一条会删掉**先匹配到的**那条，而不是指定身份。当前 UI 不能拖动排序，主路径风险低于 I7。

**证据**：I4 纯函数；`lib/session-queue.test.mjs` 已覆盖不同正文换序保 id，未覆盖「同文无图省略一条」。

### I6 · P2：附件发送成功用 `startsWith` 剥正文

位置：`components/ChatInput.tsx:957–958`。发送 `hello` 后用户改成 `hellohello`，结算后剩下第二个 `hello`，把后打的字当成「已发送前缀」。H3-b 只覆盖「后面另起一行」。

**证据**：I6 抽取真实 `settleSentDraft`。

### 不列为缺陷

- **I2**：召回与未完成入队串行后，会把刚受理的新条目一并取回。用户要的是空队列，内容回到草稿，不是 claimed 双发。
- **I5**：Route 能解析 `recall_follow_up_queue`，命令已进入正式信任边界。
- **unknown 的跨重启 exactly-once**：客户端 unknown 不恢复是对的；Host 内存 `commandReceipts` 仍不能跨进程。产品语义是待确认，不是跨崩溃 exactly-once。应在 UI 标明待确认，并允许用同一 submissionId 查询/重试（目前没有这条入口，与 I7 相关）。

## 验证

```bash
node --test lib/sdk-session-queue-consumption.test.mjs lib/sdk-session-host.test.mjs lib/queue-state.test.mjs lib/queue-merge.test.mjs lib/agent-client.test.mjs lib/agent-commands.test.mjs lib/chat-attachments.test.mjs lib/attachment-gc.test.mjs lib/agent-event-stream.test.mjs lib/browser-session-runtime-registry.test.mjs lib/session-queue.test.mjs hooks/useAgentSessionQueue.test.mjs components/ChatInputSendOwnership.test.mjs
node_modules/.bin/tsc --noEmit
node --test docs/message-send-fifth-review.repro.mjs
```

- 定向 **175/175 通过**；typecheck 通过。
- 本轮探针 **7 项**：I1/I2/I3/I4/I6/I7 为缺陷或行为刻画（绿=仍能复现）；I5 为正向接线检查。
- 临时 agentDir，无真实用户会话、无模型请求、无浏览器/Electron 冒烟。其他会话声称的 1498 全量与 31416 抽验本轮未重跑。

## 多端与下一步

I7 在共享 hook 账本上，桌面/手机/Electron 网页同样受影响；unknown 后切后台再召回更易碰到。无 Electron bridge 专属改动。

建议先修 I7（unknown pending 与后续 accepted 快照的关系），再补 set 的 submission 缓存和同文 id。H1–H3 回归应保留，不要再改回「冲突必须把仍在队列里的 x 恢复进草稿」。#42 保持 OPEN。本轮不修改业务代码。
