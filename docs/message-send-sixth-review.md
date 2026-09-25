# #42 第六轮复核：8786f34

## 结论

**第五轮点名的 I1、I6，以及 I7 在「下一次写入被受理」（召回/成功整包替换）这两条路上已经修好，可以认可。** 仍不能关 #42：unknown 之后若下一次是 **CAS 冲突**，更早的未决 pending 不会被解决；投影继续盖住刚采纳的权威快照，随后一次成功 set 会按过期 pending 整包覆盖，删掉其他标签页的条目。这与 I7 同类，只是触发从 accepted 换成了 conflict。

基线：HEAD `8786f34`，增量 `5b3b6ca..HEAD`，含原有 dirty 工作区。业务 diff SHA256：`ef8f8cd4fe39ee50ffd5ff2513778a716bf71b50b20dc24dd89b24dbba058215`。未改业务代码、未部署。Node v24.18.0。

Issue 评论里问 I3 变红是否可接受： succeded-write 把从未受理的 uncertain 拉回草稿，比静默丢掉更符合「不得删唯一副本」。**可以接受。** 本轮 J1 不是要改回 I3，而是冲突路径漏了同一套定论。

## 已验证修复

| 项 | 状态 | 证据 |
|---|---|---|
| I7 召回 accepted 清空未知 pending | 已修 | `hooks/useAgentSessionQueue.test.mjs` I7：Host 与投影皆空，再入队只有 `next` |
| I7-b 成功替换把未受理载荷回草稿 | 已修 | 同文件 I7-b；对应第五轮 I3 的新语义 |
| I7-c 回执丢失但已受理 → 不复制草稿 | 已修 | 同文件 I7-c |
| I1 set 成功/冲突按 submissionId 缓存 | 已修 | `lib/sdk-session-queue-consumption.test.mjs` 两条 I1 |
| I6 重叠前缀不剥正文 | 已修 | `ChatInputSendOwnership.test.mjs` I6 |
| I4 带 id 的同文省略/换序 | 主路径已修 | `itemToPayload` 带 `id`；`session-queue.test.mjs` I4。无 id 的 first-fit 仍是兜底 |

定向 82 项（queue-state / hook 交错 / session-queue / host consumption / ChatInput 归属 / agent-commands）+ `tsc --noEmit` 通过。

## 残留

### J1 · P1：冲突采纳了快照，却不解决更早的 unknown pending

位置：`lib/queue-state.ts:352–362`（`settleSyncFailure` 只丢掉 `revision >= 本次` 的 pending）、`469–533`（`resolvePendingsAgainstAuthority` **仅** `disposition === "accepted"` 且快照完整时调用）。注释写明故意不在拒绝/冲突上做 I7 定论，理由是 400 空体不可信。但同一次 `settleSyncFailure` **已经** `adoptServerSnapshot` 采信了冲突回执的 items/revision。结果是：CAS 基线信了权威队列，显示仍信过期 pending。

可重复时序（隔离 Host + 真实 hook 回调）：

1. 客户端与 Host 均为 `[keep]`。入队 `uncertain`，请求在途失败 → pending=`[keep,uncertain]`，Host 仍 `[keep]`。
2. 另一端把 Host 写成 `[keep, other-tab]`（revision 前进）。
3. 本端再入队，带过期 expectedRevision → 冲突。客户端 `serverRevision` 已更新，但 `hasUncertainWrite` 仍为真，投影仍是 `[keep, uncertain]`，看不见 `other-tab`。
4. 用户按屏幕上的队列再发 `foo`（`payloadsForWrite` 取最新 pending）→ 成功整包变成 `[keep, uncertain, foo]`，`other-tab` 被删。

**证据**：`docs/message-send-sixth-review.repro.mjs` J1。无真实模型。这是多标签可达路径，不是只存在于召回。

**修复方向**：冲突回执只要已经当作权威快照写入账本，就应对不晚于本次的未决提交走与 accepted 相同的 `resolvePendingsAgainstAuthority`（attemptId 在 `admittedAttemptIds` 里不恢复，否则回草稿并改写后继 payload）。若某类 400 空体没有 items/revision，就不要 adopt，也就不要定论。不要「adopt 了权威内容却让过期 pending 继续当投影和下一笔 set 的载荷」。

验收：J1 时序下，冲突后投影为 `[keep, other-tab]`（或等价权威 items），uncertain 回草稿；随后入队不得丢掉 `other-tab`。现有 I7 召回/成功替换回归必须仍绿。

### J2 · P2：声明了已不存在的 id 仍按正文顶到另一条同文 waiting

位置：`lib/session-queue.ts:350–372`。类型注释写「命中不了就当新条目」，实现和测试却是「退回正文配对以免重复」。当前客户端成功路径会带真 id，且 accepted 定论会从后继里去掉 `id not in liveIds`。J1 那种冲突未定论时，后继仍可能带着过期 id 进入 first-fit。主路径风险低于 J1。

**证据**：J2 纯函数；仓库 I4 第三条把该行为标成预期。

## 验证与限制

```bash
node --test lib/queue-state.test.mjs hooks/useAgentSessionQueue.test.mjs lib/session-queue.test.mjs lib/sdk-session-queue-consumption.test.mjs components/ChatInputSendOwnership.test.mjs lib/sdk-session-host.test.mjs lib/agent-commands.test.mjs
node_modules/.bin/tsc --noEmit
node --test docs/message-send-sixth-review.repro.mjs
```

- 上述定向 **82/82 通过**；typecheck 通过。
- 第六轮探针 **2/2 复现残留**（绿=缺陷仍在），不是修复验收通过。
- 第五轮 I7 刻画探针若再跑应变红（行为已改），不要当回归红。
- 无浏览器/Electron/真实会话。其他会话 1517 全量本轮未重跑。

## 下一步

先补 J1：权威快照一旦被账本采信，就必须清掉与它矛盾的更早 pending。I1/I6/I7-accepted 的测试保留。#42 保持 OPEN。本轮不修改业务代码。
