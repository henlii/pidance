# #42 第七轮复核：ee48a72 / 35f3e32

## 结论

**第六轮 J1 原复现已经不成立。** 冲突回执只要带 revision，就会给更早的 unknown pending 定论；未结算整包会在采纳权威快照时以当前队列为底重建，发出去的是账本里这份提交的当前载荷，不是提出时冻住的旧列表。

**还不能把 #42 当成发送链路已完全收口。** 重整用「无 id 则正文+附件相同即已在队列里」判断新增载荷，会把用户刚入队的**第二条同文**从待发送列表里拿掉，候选集还留着。成功写入后这条既不在服务端，也不会按「本次提交」回草稿（当前代次不走 restore）。

基线：HEAD `35f3e32`（`ee48a72` + 自查 `35f3e32`）。业务工作区仍是原先 18 个无关 dirty 文件，SHA256：`ef8f8cd4fe39ee50ffd5ff2513778a716bf71b50b20dc24dd89b24dbba058215`。未改业务代码、未部署。

Issue 评论中 I3/I7-b「未受理回草稿」维持可接受。第六轮探针 J1 现已变红（`hasUncertainWrite` 在冲突后为 false），这是修复证据，不要再当回归绿。

## 已验证

| 项 | 状态 |
|---|---|
| J1 冲突后 unknown pending 盖住权威队列，再 set 删 other-tab | 已修。仓库 `hooks/useAgentSessionQueue.test.mjs` J1；旧第六轮探针断言失败 |
| J1-b 在途 P2 在 SSE/回执采纳后补上 other-tab | 已修。`lib/queue-state.test.mjs` J1-b；hook 发送用 `liveProposal.payloads` |
| 400 空体不 adopt、不定论 | 已修。`authoritativeSnapshot` |
| I1 / I6 / I7 召回与成功替换 | 仍绿 |

定向：`queue-state` / `useAgentSessionQueue` / `session-queue` / `sdk-session-queue-consumption` / `ChatInputSendOwnership` **66/67**。唯一失败是旧 J1 **缺陷刻画**探针，不是产品回归。`tsc --noEmit` 通过。

## 残留

### K1 · P2：权威重整把「第二条相同正文」当成已存在

位置：`lib/queue-state.ts:356–371` `represented()`：没有 `payload.id` 时用 `text + sameQueuedMedia` 判断已在权威队列里，从而不进入重整后的 `payloads`。`candidates` 不动。

时序：队列已有 `hello`；用户再入队一条 `hello`（合法的第二条）；期间 SSE/冲突采纳快照。重整后待发送列表只剩一条 `hello` + 别人的新条目。随后这次 set 成功：第二条从未交给 Host，当前代次又不走 `resolved/restore`。

**证据**：`docs/message-send-seventh-review.repro.mjs` K1，`payloads === ["hello","other-tab"]`，`candidates` 仍有第二条 `hello`。

同文两条在 Host 侧是允许的（I4 测试即两条 same）。这里是客户端发送前丢失。

**修复方向**：无 id 的新增载荷（有 `attemptId` 的 candidate）一律视为「自己的」，不要用正文去和权威条目消重。权威底只通过 `itemToPayload` 带 id 的条目表达。

### J2

无 id / 失效 id 退回正文配对仍是显式产品选择，注释已改到与实现一致。主路径带真 id。不单列为新缺陷。

## 下一步

K1 体量小，建议修掉再谈关闭 #42。浏览器多标签交错仍建议补一条无头用例，但不替代 K1 的单测。本轮不修改业务代码。
