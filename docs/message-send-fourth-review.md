# #42 第四轮复核

## 结论

**仍不能验收关闭。** G1 的“新版本配旧内容”和 G2 的“漏掉 pending”原时序已经修复，G3 多处失败恢复已归到原会话；但新补偿把消息的所有权判断替换成了“先放回草稿”，出现重复执行风险。另有附件成功回调跨会话清空输入的问题。

基线：HEAD `641caea`，增量 `40ba79b..641caea`（`b44401f`、`56436b3`、`641caea`），含当前原有 dirty 工作区。`git diff --binary -- app components hooks lib` SHA256 为 `97595c6eb6d6c4a8d572556f1e615868f66d6401028d7cd483ee564629b2ad29`。保留原有未跟踪文档及 `public/attach-picker-test.html`。

本轮只新增本报告及 `docs/message-send-fourth-review.repro.mjs`；未修改业务代码、未部署、未操作稳定版/上游服务。Node v24.18.0，SDK 0.85.1。下列行号对应当前本地代码；报告/新探针尚未提交。

## H1 · P1：确定冲突/拒绝仍恢复整批载荷，制造队列与草稿双份

位置：`hooks/useAgentSession.ts:2944–2964,2975–2983`（dispatch）；`:2901–2907`（recall）。

### 转引导冲突

本地 `[x]@0`，Host `[x,other]@1`。dispatch 正确返回 conflict。客户端正确采纳 `[x,other]@1`，但无条件 `rollback(true)` 又将 x 放回草稿。x **仍在权威队列中**，并没有因为本请求冲突而消失。

最新 Issue 评论以及 `docs/message-send-third-review.repro.mjs` 的 G1 注释称“本轮载荷已不在权威队列里”，与该测试自己断言的 `items=['x','other-tab']` 直接矛盾；现有回归反而要求重复草稿出现。

### 召回冲突

相同过期 revision 下，clear 被 Host 明确拒绝，队列保持 `[x,other]`。`handleRecallQueue` catch 把 `input_queueConflict` 当作结果未知，将 x 放回草稿。这里不是需要未知状态对账的断网案例，而是已经知道没有清成功。

**证据**：新探针 H1/H1b，执行当前真实 hook callbacks + 临时 Host/CAS，断言同一时刻 Host 仍持 x、恢复回调又收到 x。H1b 的 console 中 `input_queueConflict` 是预期复现输出。没有调用真实模型；重复副本已证实，后续用户再次发送造成重复执行是风险，不伪称已经发生真实模型双发。

**修复验收**：冲突/已知拒绝、accepted、unknown 必须分开。队列里的载荷没有移交给草稿，就不能恢复成可重发副本；仅未入队的 extra 可以独立恢复。确认条目身份和 disposition，不以正文猜测。回归应断言冲突后 x 仍只在队列中，不要把“保住所有文本”误当 exactly-once。

## H2 · P1：召回成功也可能取回已经在投递的消息

位置：`hooks/useAgentSession.ts:2876–2897`。

召回抓取 `payloadsForWrite(entry)` 后提交的是“清空当前可移除队列”，不是“原子取回这一批 itemId”。clear 成功不等于捕获的每一项都已移交。

复现时序：

1. 当前队列 x waiting，召回捕获 x，clear 进入浏览器串行链，尚未执行。
2. 另一视图整队 dispatch，Host 把 x 持久化为 claimed，SDK steer 暂挂；较新队列快照到达浏览器。
3. 串行 clear 使用最新 revision，**成功**；Host 正确保留不能撤回的 claimed。
4. 召回不检查 clear 回执中 claimed/inFlight，也不检查实际移除结果，直接把先前捕获的 x 放回草稿。

**证据**：H2 用真实 Host dispatch 和 set 队列，加可控 SDK steer Promise；以真实 queueReceiptBase 构造相应到达快照。断言成功召回后草稿含 x、Host 同时仍有 x claimed。随后释放 Promise 正常结束，无真实模型请求。该探针代表跨视图认领与 state 到达的合法交错，不是浏览器实机重放。

**修复验收**：服务端提供明确的条目级 recall/claim 边界，回执返回实际取回项；或等价地拒绝不能完整转移的召回。只能把确认移交的条目放进草稿。覆盖 pending 入队、claimed、其他标签新增和 clear 落盘失败，不要仅扩大客户端捕获快照。

## H3 · P1：带附件发送完成后清空了另一个会话的草稿

位置：`components/ChatInput.tsx:993–1025`，尤其 `if (hasAttachment) clearInput()`。

发送捕获了 `capturedDraftKey`，但只在纯文本失败分支使用。带图片或 ready 文件时等待 onSend，然后不检查归属就清当前输入。

复现：A 带附件发出，回执在途；用户切到 B 并编辑 B；A 的 onSend 成功返回；clearInput 操作当前 B。B 的未发送正文/图片/文件被清空。

**证据**：H3 从当前 ChatInput AST 提取真实 handleSend，注入延迟 onSend；切换 draftKeyRef 到 B 后放行，实际 clearInput 调用对象是 B。未运行真实 DOM。这个风险前轮已作为静态边界记录，本轮完成受控 callback 复现；不是声称 `641caea` 首次引入。

**修复验收**：成功只结算 A 的被发送草稿版本；不仅比较 sid，还应避免清掉 A 在等待期间新编辑的内容。测试 A→B、A 同会话继续编辑、图片/普通文件、成功与明确失败。

## 已修与新功能复核

- G1 原“旧内容覆盖他人”时序：第三轮回归通过，权威快照保留；但 H1 表明补偿语义有误。
- G2 原 pending 被漏召回：第三轮回归通过；H2 表明仍无原子移交保证。
- G3 切会话后恢复：相关直接 callback 回归通过，新增恢复函数支持没有输入框时写草稿；不是说所有异步输入生命周期已完成，见 H3。
- `expectedRevision` 非法类型被拒绝，有定向解析测试。
- `56436b3` run 序号：Host agent_start 递增，agent_end 投影保留序号；registry 收到不同序号的结束事件会提前 return，不继续通知视图。对应合成事件测试通过。新 agent_start 会覆盖浏览器序号，因此**不能仅因 Host 重建归零就断言必然卡住**。本轮未做 Host 重建/重连/旧 Promise 来源的完整事件集成，不把该补丁当 H1 的解决方案，也不凭猜测新增阻塞项。
- `641caea` 附件入口：粘贴、拖拽、选择器统一按位图/其他文件分流；运行中位图可入队，普通文件显式显示不支持运行中上传的提示。不能把提交标题解读为“任意文件可运行中排队”。这些共享路径有静态核对，本轮未执行文件选择器/剪贴板浏览器自动化。

## 测试及限制

联合测试：

```bash
node --test lib/sdk-session-queue-consumption.test.mjs lib/sdk-session-host.test.mjs lib/queue-state.test.mjs lib/queue-merge.test.mjs lib/agent-client.test.mjs lib/agent-commands.test.mjs lib/chat-attachments.test.mjs lib/attachment-gc.test.mjs lib/agent-event-stream.test.mjs lib/browser-session-runtime-registry.test.mjs hooks/useAgentSessionQueue.test.mjs docs/message-send-rereview-2026-09-17.repro.mjs docs/message-send-third-review.repro.mjs
node_modules/.bin/tsc --noEmit
node --test docs/message-send-fourth-review.repro.mjs
```

- 联合 **174 项：172 通过、2 失败**。
- 失败在已经提交的 `docs/message-send-rereview-2026-09-17.repro.mjs` F3/F4，均为 `ReferenceError: payloadsForWrite is not defined`。生产 callback 新依赖没有注入测试环境；属于回归探针维护错误，不是本轮新增业务缺陷的证据。审查未擅改旧探针来制造全绿。
- Typecheck 通过。
- 新增 **4/4 缺陷特征探针通过**（H1、H1b、H2、H3），表示缺陷被复现，不是正确行为验收通过。
- 临时 agentDir、受控 SDK/HTTP/callback 依赖，无真实用户会话写入、无真实模型请求。没有真实浏览器、手机或 Electron 冒烟证据。
- 其他会话在 Issue 报告全量 1489 与浏览器操作，本轮没有重跑那些证据，不能与本轮的联合测试结果混为一谈。

## 多端与下一步

H1/H2 属共享 hook/Host，影响桌面、手机、Electron 网页与多标签；H2 特别覆盖跨视图认领，H3 对切会话/移动端后台迟到响应同样适用。无 Electron bridge 专属改动；Windows 真机仅作附注，不替代可重复自动化。

建议先修复载荷所有权移交：队列、claimed、草稿三者不能同时把同一消息当成可再次发送；其次让成功回调绑定原草稿版本。修复两处旧探针注入错误，调整现有 G1 回归中不正确的“必须恢复 x”断言。#42 保持 OPEN；本轮不修改业务实现、不关闭 Issue、不另建重复 Issue。
