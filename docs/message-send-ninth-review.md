# #42 第九轮复核：cdfffdf

## 结论

**第八轮 K2 的产品路径已修好。** `projectState().queuedMessages` 和 `queued` 回执都带 `admittedAttemptIds`；`normalizeQueuedMessages` / `applyProjectedQueues` / `acceptQueuedReceipt` 会透传；**缺字段是 `undefined`，不会用空数组冒充「从未受理」**（旧 Host）。仓库 K2 用例：回执丢失 → 热投影 → 待发送仍一条 `hello` → 再入队 `next` → 服务端 `["hello","next"]`。

从历次点名的所有权缺陷看，**主路径可以视为收口**：H1–H3、I1/I4/I6/I7、J1、K1、K2 均有真实 Host 或账本回归，且对应的旧「缺陷刻画」探针已变红（K1）或由仓库用例替代（K2）。

**不自动关 Issue。** 仍有明确的非阻塞残留；要关的话应把它们写进 Issue 作为已知限制，而不是当成没审到。

基线：HEAD `cdfffdf`。原有 18 个无关 dirty 文件未动。未改业务代码。`tsc --noEmit` 通过。本轮定向 `useAgentSessionQueue` + `queue-state` + 第八轮探针 **36/36**（其中第八轮 K2 探针仍绿，见下）。

## 已验证

| 项 | 证据 |
|---|---|
| K2 热投影带令牌 | `hooks/useAgentSessionQueue.test.mjs` K2；摘掉 Host 令牌会失败（提交说明中的反证） |
| 缺字段不覆盖账本令牌 | `normalizeQueuedMessages` 非数组 → `undefined`；adopt 只有字段存在才替换 |
| `queued` prompt 回执带令牌 | `enqueuePayloads` 的 `queue.admittedAttemptIds` |
| 此前 J1/K1/I7/H1–H3 | 本轮同套件仍绿 |

第八轮探针 `docs/message-send-eighth-review.repro.mjs` **仍绿**：它直接给账本喂「不带令牌的快照」，刻画的是账本在信息缺失时无法判断。修复在生产者，不在 `adoptServerSnapshot`。等价验收以仓库 K2 为准，不要把该探针再当产品缺陷。

## 非阻塞残留

1. **`[]` 与缺字段**
   `next.admittedAttemptIds ?` 里空数组为真，会把账本令牌写成 `[]`。新 Host 空数组表示「确实没有受理过」，语义正确。只有错误的空数组才会误伤；当前 `projectState` 发送的是真实列表。

2. **J2**
   无 id / 失效 id 仍按正文配对，避免同文重复条目。主路径带真 id。已是显式产品选择。

3. **跨崩溃 exactly-once**
   unknown 不恢复、Host `commandReceipts` 不跨进程，产品语义是待确认，不是崩溃后精确一次。

4. **浏览器双标签无头**
   多标签语义由真实 Host 交错覆盖；没有 CDP 双页基建。不阻塞这条所有权修补。

## 建议

所有权主路径可以停手。若接受上面 4 条为已知限制，可以关 #42；若要关得更干净，只需再补：空数组 vs 缺字段的单测、以及把第八轮 K2 探针改成走 `applyProjectedQueues`（可选）。本轮不修改业务代码。
