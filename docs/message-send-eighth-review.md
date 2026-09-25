# #42 第八轮复核：331465b

## 结论

**第七轮 K1 已修好。** 待发送列表重整只认身份：有服务端 id 的走权威条目；无 id 的只在 `attemptId` 已受理或已定论回草稿时排除。第二条同文 `hello` 会留在待发送列表。旧 K1 探针已变红（`["hello","other-tab","hello"]`）。

**还不宜关 #42。** `get_state` 热投影和 `applyProjectedQueues` 仍不带 `admittedAttemptIds`。回执丢失后若先走这条快照，账本令牌仍是空的，已落地的那次写入会被当成「新增」再列一遍，随后 set 会多出一条同文队列。

基线：HEAD `331465b`。原有 18 个无关 dirty 文件未动，SHA256：`ef8f8cd4fe39ee50ffd5ff2513778a716bf71b50b20dc24dd89b24dbba058215`。未改业务代码。

## 已验证

- K1 仓库测试：`lib/queue-state.test.mjs` 两条（第二条同文保留；已受理令牌不重复列）。
- J1 / I7 / H1–H3 / I1 / I6 定向仍绿。
- 第七轮 K1 缺陷刻画失败，与修复一致。
- `tsc --noEmit` 通过。`queue-state` + hook 交错 **34/35**（失败项仅为旧 K1 探针）。

## 残留 K2 · P2

位置：

- `lib/sdk-session-host.ts:2086–2093` `queuedMessages` 无 `admittedAttemptIds`
- `hooks/useAgentSession.ts:537–539` `applyProjectedQueues` 只 adopt items/inFlight/revision
- SSE `follow_up_queue_changed` 和写入回执是带令牌的，这条路径没有对齐

时序：入队成功但 HTTP 回执丢失 → 客户端 pending 为 unknown、令牌未记入账本 → reconcile/`get_state` 把 `hello` 写进 items → `rebasePendingPayloads` 因 admitted 为空把 `try-a` 再拼进 payloads → 用户再入队任何内容时，服务端多一条同文。

**证据**：`docs/message-send-eighth-review.repro.mjs` K2，快照不带令牌时 payloads 为 `["hello","hello"]`。对照：同一快照若带 `admittedAttemptIds:["try-a"]` 则只有一条（仓库 K1 第二条）。

**修复**：`get_state` 与 `applyProjectedQueues`/`normalizeQueuedMessages` 带上与 SSE 相同的 `admittedAttemptIds`；缺字段时保持账本旧令牌（不要用空数组覆盖）。回归：K2 时序下待发送列表只有一条 `hello`。

J2 正文配对仍是无 id 时的显式兜底，主路径带 id。不单列。

## 下一步

补 K2 后，发送所有权主路径（入队/召回/冲突/unknown/同文/跨标签）才齐。浏览器双标签无头仍缺基建，不阻塞这条修补。本轮不修改业务代码。
