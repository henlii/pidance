# #42 第三轮复核：40ba79b

## 结论与基线

**仍不建议验收/关闭 #42。** 上轮多数具体复现已修，但本轮发现三条可以重复的丢消息路径。不能把补丁标题“F1–F11 已修”理解为对应用户用例全部通过。

- 当前 HEAD `40ba79b`；审查增量 `2badb50..40ba79b`，并包含本地原有 18 个未提交文件。
- 业务工作区 diff SHA256（`git diff --binary -- app components hooks lib`）：`42f6edc084f97b731ddeabe8d4eff9d5fd157beb06ec414568d57bf6c72f64b6`。
- Node v24.18.0；SDK 0.85.1。只新增本报告和 `docs/message-send-third-review.repro.mjs`，未修改业务代码/原有变更，未部署、未调用真实模型、未写真实用户会话。
- 已阅读 #42 最新实现说明（issuecomment-5711387050）；该评论所报全量 1485 项和浏览器抽验是其他会话证据，本轮没有冒充自己重新执行。
- 下述行号均为本轮本地代码；本报告/新探针尚未提交。

## G1 · P1：队列转引导冲突的 rollback 再次制造“新版本＋旧内容”

**位置**：`hooks/useAgentSession.ts:2899–2911,2928–2934`。

冲突处理先记住旧 `items`，再采纳服务端回执；紧接着 `rollback(remembered)` 用已经更新的 `serverRevision` 重新采纳旧 items。`adoptServerSnapshot` 允许同版本快照，因此内容回到旧值，版本却是新的。

复现：

1. 标签 A 本地 `[x]@0`，Host 已因其他标签入队成为 `[x,other-tab]@1`。
2. A 请求整队转引导，服务端正确返回 conflict 及 `[x,other-tab]@1`。
3. rollback 后 A 变成 `[x]@1`。
4. A 再追加 mine，以合法 revision 1 提交 `[x,mine]`，Host 接受，other-tab 被删。

**证据**：G1 执行从当前 hook 提取的真实 `handleSendQueueAsSteer` 和 `updateLocalFollowUp`，使用真实临时 Host/CAS/落盘，最终 Host 队列确为 `[x,mine]`。未运行 React DOM/真实 HTTP。

**与上轮关系**：F11 的连续 set 队列冲突已修；新补丁在 dispatch 冲突补偿中重建了同一种错误。不能只验证 `updateLocalFollowUp`。

**修复/验收**：冲突后保留服务端内容与版本的整体快照，不把旧整包当成“回滚权威内容”。未提交的 extra 单独归还原会话草稿。回归必须走 dispatch conflict → append/recall 两条路径，其他标签条目不能消失。

## G2 · P1：乐观入队在途时召回，清掉新消息却不归还草稿

**位置**：`hooks/useAgentSession.ts:2841–2849,2857–2859`；提交链 `hooks/useAgentSession.ts:578–619`。

召回只读取 `entry.items`（已确认条目），忽略 pending 提交链；随后把“清空整个队列”排进同一串行链。等待中的入队先成功，清队再成功，但草稿只恢复请求开始时的旧 items。

复现：

1. Host 与浏览器权威队列是 `[x]`。
2. 用户追加 new-message，乐观队列变成 `[x,new-message]`，提交尚未结算。
3. 立即召回，捕获到的权威 items 仍只有 x；clear 被排到 enqueue 后。
4. enqueue 成功 → clear 成功 → Host 队列空；草稿只有 x。new-message 的入队返回成功，没有失败恢复路径，却已丢失。

**证据**：G2 执行真实 hook callbacks + 临时 Host；两个 Promise 均成功，最终队列空、草稿只含 x。无需注入错误响应或真实网络故障。

**修复/验收**：召回要与尚未提交的本地操作形成一致事务边界。可先等待/明确拒绝 pending，再捕获同版本可召回项；或按确切条目 ID 原子取回。不能把一个旧快照复制到草稿，却清掉更晚的整个队列。覆盖纯文本、多图、连续入队→召回，不应只测无 pending 时切会话。

## G3 · P1：入队失败时若已切会话，原正文与图片仍不恢复

**位置**：`hooks/useAgentSession.ts:2724–2728,2810–2814`；相邻 dispatch extra 回滚 `:2913–2915` 也仍依赖当前 sid。

本轮新增 `restoreDraft(..., ownerKey)`，并在 `handlePromptWithStreamingBehavior` 的 restore 中传了原 sid；但普通 `handleSteer` 的拒绝/异常分支（`:2609–2630`）仍按当前 sid 放弃恢复，`handleFollowUp` 也仍先判断 `sessionIdRef.current !== sid` 就 return，而且没有传 ownerKey，也没有直接写原 sid 的草稿。

复现：A 发起入队→用户切 B→A 收到 CAS/persist/网络错误→writeQueue 失败→restoreDraft 直接退出。UI 原发送已清空输入，A 没有恢复副本。F11 新增的后继取消也会触发此类失败。

**证据**：G3 执行真实 handleFollowUp，用受控 Promise 构造在途切换和失败，草稿恢复调用为零。模拟的是 callback 交错，不是浏览器实机切换。

**修复/验收**：与召回一样，由不依赖当前组件的会话级 owner 保存原 sid 的完整载荷。检查普通/引导/排队/dispatch extra 全部恢复路径，不只新增一个接口。A 失败时查看 B 不受影响，回到 A 正文和图片仍在；组件卸载也不能失去保存能力。unknown 与确定拒绝应分开处理，避免恢复后盲重发。

## 上轮 F1–F11 状态

| 项 | 本轮判断 |
|---|---|
| F1 引用型图片普通发送 | 已修对应序列化；已有会话 probe 通过，新建路径已复用 serializer（静态核对） |
| F2 model/original 配对 | 当前写入顺序的单图、多图 round-trip 已修；仍是顺序配对，不是稳定图片身份关联 |
| F3 纯图派发 | 已修；入口和 Host 的隔离回归均通过 |
| F4 召回切会话 | 原复现已修；新增 pending 召回 G2，其他失败恢复仍有 G3，不能把整个草稿生命周期判为完成 |
| F5 上传取消 | 原移除后晚到成功已修；切草稿策略是取消并删除新上传文件，不是保留原草稿中的上传 |
| F6 GC 空格路径 | 原复现已修，完整原文/JSON 转义路径子串匹配已覆盖；并非最新 issue 评论声称的“解析 JSONL” |
| F7 preflight steer | 已修为持久 queued；不是原生 steer。回执 action/界面提示应保持这种区别 |
| F8 active run 普通 prompt | 原复现已修，busy 前置拒绝不再污染原 run |
| F9 同 ID 并发 steer | Host single-flight 已修；浏览器 steer/dispatch 仍未提供稳定 submissionId，不能宣称丢响应后的用户重试已具备去重/对账 |
| F10 超限合并 claim | 已改逐条 claimed，原 17 图恢复 round-trip 已修 |
| F11 后继 set 冲突 | 原复现已修；dispatch 回滚 G1 又引入内容/版本不一致 |

## 验证

本轮实际执行：

```bash
node --test lib/sdk-session-queue-consumption.test.mjs lib/sdk-session-host.test.mjs lib/queue-state.test.mjs lib/queue-merge.test.mjs lib/agent-client.test.mjs lib/agent-commands.test.mjs lib/chat-attachments.test.mjs lib/attachment-gc.test.mjs lib/browser-session-runtime-registry.test.mjs docs/message-send-rereview-2026-09-17.repro.mjs
node_modules/.bin/tsc --noEmit
node --test docs/message-send-third-review.repro.mjs
```

- 第一组 **158/158 通过**，包含已转换为正确行为断言的 **12 条**上轮回归；已检查测试源码，确实不再期待旧缺陷。
- Typecheck 通过。
- 本轮新增 **3/3 缺陷特征探针通过**，表示 G1/G2/G3 被复现，不是修复验收通过。修复时应转换为正确行为断言。
- Host 使用临时 agentDir 和受控 streaming 标志；callback 使用真实 AST 提取表达式、注入外部依赖；没有真实模型、生产服务和真实用户 JSONL 写入。
- 本轮未重跑全量测试、浏览器/Electron/Windows 冒烟。上轮其他静态风险未逐项重新验收，不能因未在这轮重列就视为已解决。

## 架构与多端

当前关键缺口仍是同一份队列存在“权威快照、pending 提交链、dispatch 回滚快照、草稿恢复”四个分散决策点。本轮不建议再加一套补偿账本：统一版本与内容的采纳入口、统一召回的串行化边界、统一按原 sid 保存失败载荷即可。

三个问题都位于共享 hook/Host 路径，影响桌面浏览器、手机浏览器、Electron 网页与多标签；G1 特别依赖跨标签，G2 不需要多标签，G3 在移动端后台/切会话的迟到响应中同样适用。没有 Electron bridge 专有代码改动。静态核对 `components/ChatInput.tsx:1737–1760`：召回按钮直接绑定回调，没有 pending 禁用；`components/ChatWindow.tsx:601` 直接传入 handleRecallQueue。本轮未执行真实 DOM 交互；完整验收仍应补浏览器交错测试，不能把偶然的交互时序当服务层保证。

优先处理 G1/G2/G3，并把三条交错纳入回归，#42 继续保持 OPEN。不修改业务代码、不另建重复 Issue。
