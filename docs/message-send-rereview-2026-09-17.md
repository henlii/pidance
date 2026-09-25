# #42 消息发送修复复核（2026-09-17）

## 结论

**复核已完成；修复尚不能验收。** 已有改善真实存在，但仍有消息丢失、跨标签覆盖、附件错配与已引用文件误删风险。#42 保持 OPEN，不应按已完成关闭。

本次仅审查，新增本报告与隔离复现脚本；未修改业务代码、未提交、未部署、未操作 31415/上游服务、未写真实用户会话。

- 原始专项：[Issue #42](https://github.com/henlii/pidance/issues/42)、[原始报告](message-send-review-2026-09-16.md)。
- 复核 HEAD：`2badb50`，比较基线 `49fdb54`，覆盖 `f28d77d`、`1afd997`、`f9b11b3`、`6f66896`、`2badb50` 五个提交。
- 当前 18 个原有 dirty 文件仍纳入工作区基线。`git diff --binary -- app components hooks lib` SHA256：`42f6edc084f97b731ddeabe8d4eff9d5fd157beb06ec414568d57bf6c72f64b6`。不是沿用原报告哈希。
- Node `v24.18.0`；SDK `@earendil-works/pi-coding-agent@0.85.1`。
- 以下行号指本次本地工作区。报告与新探针尚未提交，远端仓库文件链接不能代表它们。

## 验证及证据边界

既有定向测试 **146/146 通过**，`tsc --noEmit` 通过。新增 [复现脚本](message-send-rereview-2026-09-17.repro.mjs) **11/11 通过**；这些断言刻画的是残留缺陷，绿色表示复现成功，**不是正确行为回归已通过**。修复时应改成相反的正确行为断言，并补集成覆盖。

```bash
# 使用 Node >=22.19；本次 PATH 指向 ~/.nvm/versions/node/v24.18.0/bin
node --test lib/sdk-session-queue-consumption.test.mjs lib/sdk-session-host.test.mjs lib/queue-state.test.mjs lib/queue-merge.test.mjs lib/agent-client.test.mjs lib/agent-commands.test.mjs lib/chat-attachments.test.mjs lib/attachment-gc.test.mjs lib/browser-session-runtime-registry.test.mjs
node_modules/.bin/tsc --noEmit
node --test docs/message-send-rereview-2026-09-17.repro.mjs
```

证据分两类：

- **函数级复现**：从当前源码提取真实 React callback 表达式并注入环境，或调用实际工具函数；不是重写一份“相似逻辑”。HTTP 请求由 mock 捕获，没有真实浏览器 DOM/HTTP 集成。
- **Host/SDK 隔离复现**：真实临时 Host、独立临时 agentDir、实际持久化/解析；通过可控 Promise 或运行标志构造时序，不启动真实模型请求。F7 实际进入 SDK steering queue；F8 实际触发 SDK 的 busy 拒绝。

未运行本轮真实浏览器/Windows/Electron 冒烟、真实进程崩溃或模型调用，也没有把其他会话对旧提交的浏览器测试当作最新 `2badb50` 的验证。

## 按风险列出的残留问题

编号与探针一致；顺序按修复优先级，不按发现时间。

### F11 · P1：有第二个待提交操作时，CAS 冲突仍会覆盖另一标签页的消息

位置：`hooks/useAgentSession.ts:578–619`；`lib/queue-state.ts:185–231`。

`updateLocalFollowUp` 排进 promise 链后，在实际执行时读取整个最新 `pending`，而不是本次操作快照。`settleSyncSuccess/Failure` 只清理匹配本地代次的 pending；冲突回执虽更新权威内容和版本，却保留较新代次的旧整包 pending。下一请求直接把它配上新 revision 发出。

确定性时序：

1. 标签 A 本地 `[x]@0`；Host 因标签 B 入队成为 `[x,other-tab]@1`。
2. A 连续提出 `[x,mine-1]` 与 `[x,mine-1,mine-2]`，两次都已进入本地串行链。
3. 第一次收到 conflict：权威内容/版本更新为 `[x,other-tab]@1`，但第二次 pending 不清除。
4. 第二次使用 revision 1 写入 `[x,mine-1,mine-2]`，Host 合法接受；`other-tab` 永久从队列删除。

**证据**：F11 对真实 hook callback + 临时 Host 执行，两次结果为 rejected/fulfilled，最终磁盘 owner 的队列没有 other-tab。

**最小方向/验收**：冲突后不得将基于旧权威基线的整包意图自动升级到新版本；取消/拒绝受影响的后继操作并保留草稿，或以明确的条目级操作重算。至少覆盖“另一标签新增 + 本地连续两次入队/召回”的交错，而非只测单个纯函数结算。

### F6 · P1：GC 误删仍被 JSONL 引用的历史附件

位置：`lib/attachment-gc.ts:64,89–96,137–144`；`lib/chat-attachments.ts:36–46`。

JSONL 引用扫描用正则分隔字符切原始文本，在空格、单引号、逗号、`)`、`]`、反斜杠处结束；但文件名清洗并未禁止这些字符。`screen shot.png` 是合法文件名，JSONL 的完整 path 也是合法 JSON。扫描只收集到 `.../screen`，随后把真实文件判为无引用。

**证据**：F6 在临时目录写合法 JSONL 和老附件，实际执行 sweep，结果 `complete:true, deleted:1`，被引用文件确实消失。无须真实等 30 天，测试固定 mtime 即可重复。

**影响**：到达 30 天回收条件并触发扫描后，历史原图/预览/附件下载失效；桌面、手机、Electron 共用服务端均受影响。不是“只多留垃圾”。

**最小方向/验收**：按 JSONL JSON 语义解析字符串/对象并保守收集引用，解析不完整时 fail-closed；支持嵌入正文的路径时另行设计边界，不能用错误切词判定无引用。加入空格、中文、引号、逗号、括号、转义字符和损坏 JSONL 用例。

### F4 · P1：召回完成前切换会话，队列已清而草稿未保存

位置：`hooks/useAgentSession.ts:2817–2834`。

召回先 `await updateLocalFollowUp([], sid)`，成功后若当前 sid 已变便直接 return；只通过当前输入框 ref 回填，没有先把返回的正文/图片写入原 sid 的草稿存储。

**证据**：F4 执行实际 callback，记录对 A 的清队请求，等待期间切 B，完成后无任何草稿恢复调用。证明回调层的丢失路径；未运行真实 React 页面切换。

相同所有权缺口还存在于 `handleSteer`、`handleFollowUp` 的失败恢复：`hooks/useAgentSession.ts:2603–2620,2657–2660,2712–2717` 切走后直接放弃恢复。“不写 B”不等于“已恢复 A”。

**最小方向/验收**：草稿恢复/召回结果由会话级 owner 按原 sessionId 持有；组件是否当前可见仅决定渲染，不决定保存。延迟响应后切 B，再切回 A，正文与媒体均应完整；B 不得变化。

### F2 · P1：召回的图片模型副本错配，再入队会漏发图片

位置：`lib/attachment-upload.ts:186–213,253–264,287–294`；`hooks/useAgentSession.ts:151–152,2827`。

写入顺序是每张图 `model → original`；`groupQueueMedia` 却把 model 交给“上一张 original”。

- 一张图 `[modelA,originalA]`：modelA 被丢弃，召回只剩 originalA。
- 两张图 `[modelA,originalA,modelB,originalB]`：modelB 被配给 originalA，originalB 没有模型副本。
- 只有 original 的召回图再次入队时 `imageMediaRefs` 只输出 original；Host `readQueueModelImages` 只读取 role=model，因此图片不再成为模型图像输入。普通直接发送另被 F1 阻断；引导 fallback 还可能以未缩小原图替代模型副本。

**证据**：F2 执行真实转换链，断言第一张原图对应第二张模型副本、单图重新入队无 model 引用。

**最小方向/验收**：不要靠含混的顺序约定把两类独立引用拼回一张图；至少修正并严格验证配对，缺副本不得当完整图片成功。单图、多图分别做“入队→召回→再入队→投递” round trip，校验模型字节及原图卡片对应同一图。

### F10 · P1：整队合并会写出解码器拒绝的唯一持久副本

位置：`lib/sdk-session-host.ts:818–837`；`lib/session-queue.ts:65,78–79,187–189`。

每条媒体引用上限 32（16 张图的 model/original）；整队转引导把多个合法条目合并为一个 claimed，却未重新检查合并结果的上限。17 张图分两条入队合法，合并后 claimed 有 34 个引用。持久化编码器照写，但恢复解码器会整条丢弃它。

**证据**：F10 临时 Host 接收 16 图+1 图两条，手动派发挂在可控 steer Promise 时读取真实 prefs，确认唯一 claimed 有 34 引用；调用同一个恢复 decoder 得到 `items:[]`。未实际杀进程，已执行确切的持久化与恢复解码步骤。

**影响**：此窗口崩溃/重启时不会恢复为 unknown，而是正文和图片引用一起消失，破坏“先保存唯一副本”的核心保证。

**最小方向/验收**：claimed 批次应保留合法条目身份/结构，或在任何破坏性合并前拒绝超限批次；所有写入结果必须满足自身 decoder 的 round-trip。覆盖两条各自合法但合并超限、超限纯图/图文的恢复。

### F8 · P1：活动 run 中拒绝普通 prompt 仍污染原 run

位置：`lib/sdk-session-host.ts:2049–2059,2117–2147`；SDK `dist/core/agent-session.js:864–866`。

新门禁只拦 `promptRunning && !session.isStreaming`（预检期），没拦 SDK 已在运行的普通 prompt。Host 先重置运行状态/计时，再调 SDK；SDK 因没有 streamingBehavior 拒绝后，Host catch 把原 run 标 error、设 hold、`promptRunning=false`、发 `prompt_done`，原 SDK run 仍活跃。

**证据**：F8 使用真实 Host/SDK、注入 active 标志触发 SDK 实际 busy 异常，确认原 `session.isStreaming=true` 同时出现上述错误状态。不是模拟真实模型运行全流程。

**最小方向/验收**：普通 prompt 的 busy 准入应在任何 run 状态变更前完成；合法扩展命令/显式 streamingBehavior 作为明确路径处理。双标签并发普通 prompt，第二条拒绝不能结束、重计时或 hold 第一轮。

### F1 · P2：普通发送没接入图片引用协议，恢复草稿/召回后发不出去

位置：`lib/agent-client.ts:50–52`；`lib/browser-session-runtime-registry.ts:1399–1401`；`components/ChatInput.tsx:219–239`。

最新改造让草稿只持 media 引用、不持 data；但已有会话和新会话普通发送仍序列化 `{type:'image',data:img.data}`，没有复用已有 `promptImageInputs`。恢复后图片没有 data，最终请求被 `parsePromptImages` 抛 `invalid image`。新上传暂时保留 data，容易让只测刚选图即发的验收漏掉该缺陷。

**证据**：F1 捕获真实 submitAgentPrompt 的请求 JSON，再交实际服务端 parser，确实拒绝；同时证明引用型 serializer 已存在。新会话路径为相同语句的静态证据。

**最小方向/验收**：已有/新建会话共用同一个图片序列化入口。上传→切会话→回来、上传→刷新、队列召回后三条路径都能普通发送，且没有重新内联无必要的 base64。

### F3 · P2：纯图队列转引导被正文空串判断挡住

位置：`hooks/useAgentSession.ts:2850–2854`。

队列已能接收纯图，但手动派发入口只 merge 正文，`if (!merged) return`。纯图队列正文是空串，因此根本不请求服务端；Host 支持图片派发不能弥补该入口缺失。

**证据**：F3 执行实际 callback，合法带图条目直接返回，未走发送命令。

**最小方向/验收**：按完整载荷判断可发送性；纯图队列无输入框额外文字时，也必须派发图片，且投影不伪造正文。

### F5 · P2：上传完成回调无取消/草稿归属检查

位置：`components/ChatInput.tsx:694–706,785–793,854–870`。

移除 pending 附件只删 UI 状态，上传仍继续；成功回调无条件 append 图片。用户取消后图片重新出现。切换 draftKey 也不使上传失效或绑定原草稿，存在晚到图片进入新草稿的风险。

**证据**：F5 用真实上传 callback + 可控 Promise，移除 pending 后完成上传，attachedImages 又增加一张。跨会话风险来自静态缺失归属检查；未声称浏览器实机串图已复现。

**最小方向/验收**：上传绑定 draft/session + generation；取消后不得附加，结果只结算原草稿，成功但无人接收的文件安全回收。覆盖移除、切会话、卸载、失败重试与迟到成功。

### F9 · P2（重复投递风险）：非 prompt 提交的在途幂等仍不成立

位置：`lib/sdk-session-host.ts:2216–2217,2273–2281,2285–2300`；`hooks/useAgentSession.ts:2594–2598,2866–2870`。

普通 prompt 有 `promptInFlight`，steer 只有完成后的 receipt cache。同一 submissionId 在 await steer 期间到达两次，两次均进 SDK。set_follow_up_queue 检查了 commandReceipts 却未保存写回执。UI 的 steer/dispatch/set 请求也没有提供稳定 submissionId，服务器生成新 ID，网络响应丢失后用户重试无法关联原操作。

**证据**：F9 在实际 Host 上挂起 session.steer，同 ID 并发两请求，SDK 方法调用两次且都回 accepted。HTTP 丢响应/用户重试为静态风险，不冒充真实断网复现。

**最小方向/验收**：复用会话级提交事务，操作在发起前有身份，Host 对同 ID single-flight；unknown 不能当确定失败自动退回成可盲重发草稿。验证并发重复、已完成重复、响应丢失后对账。内存去重不能承诺跨重启 exactly-once。

### F7 · P2：预检期引导仍只进入无活动 run 的 SDK 内存队列

位置：`lib/sdk-session-host.ts:2249–2273`；SDK `dist/core/agent-session.js:1016–1024,1046–1058`。

dispatch 分支已以 `session.isStreaming` 决定 steer，但普通 steer 分支仍以 `!this.isRunning()` 判断空闲。promptRunning=true 的预检期也算 busy，SDK steer 只入内存队列，不启动 run、不保存到产品队列；如果原 prompt 预检失败，该消息可悬挂到后续运行，Host 销毁则丢失。

**证据**：F7 构造 preflight-only 状态，调用真实 SDK steer，回 accepted/steer；SDK 无活动 run、产品队列为空、steeringMessages 中有该消息。后续预检失败/销毁是该状态的风险推论，没有发真实模型请求。

**最小方向/验收**：steer 的可消费条件与 dispatch 收口；没有活动 SDK run 时明确拒绝/持久延迟，不能用“总 busy”作可消费条件。预检失败后的引导载荷仍可恢复。

## 对原 R1–R12 的复核状态

| 原项 | 本次判断 |
|---|---|
| R1 成功写入未采纳 revision | 单次成功路径已修，实际回执成为 CAS 基线；不是所有队列并发问题已解决 |
| R2 冲突只推版本 | 单次结算已改善，但有后继 pending 仍丢另一标签消息，见 F11 |
| R3 清队+引导客户端补偿 | 已换 Host dispatch，旧“回滚写入 B 队列”路径移除；召回/失败草稿归属仍残缺，见 F4 |
| R4 清队不取消在途 | claimed 不被 set 清除，自动/手动并发拒绝保护已有测试；不能据此宣称所有投递具备 exactly-once |
| R5 cursor/正文确认 | 自动消费按捕获 ids 出队，不再靠任意 user event 确认；新增合并超限破坏恢复，见 F10 |
| R6 compact/bash/预检期准入 | compact-only/bash 显式处理有进展；普通 steer 预检期问题仍在，见 F7 |
| R7 引导失败输入丢失 | 当前会话可恢复/提示，切走后不保存；unknown 与 rejected 未统一，见 F4/F9 |
| R8 rejected 误入队、运行态污染 | 已区分可排队原因；active run 的普通 prompt 仍污染原运行态，见 F8 |
| R9 入口回调分叉 | ChatWindow 按 sessionBusy 配回调，sendQueued 缺回调不清输入已改善；纯图派发遗漏，见 F3 |
| R10 媒体双队列/纯图 | 新队列支持媒体引用、纯图并 fail-closed，但引用序列化/召回/上传生命周期仍不完整，见 F1/F2/F5 |
| R11 提交身份与 unknown | 普通 prompt single-flight/校验有改善；其他提交未进入同一个事务 owner，见 F9 |
| R12 持久化失败仍确认 | commit 队列先落盘后发布已修；hold 落盘失败仍仅 emit 错误，没有内存 fail-closed，不能宣称全部持久化风险清零 |

## 其他需要补验的静态边界（不计入 11 个复现）

1. `app/api/message-media/route.ts:63–76` 的显式 DELETE 只验证目录路径、不核查队列/历史/其他草稿的引用；`components/ChatInput.tsx:768–777` 移除图片即删服务端文件。GC 的引用保护不能保护这种直接删除，多标签共享草稿/历史复用需测试。
2. `lib/sdk-session-host.ts:849–850` 的活动 run 整队 steer 未提交已经收集的 original binary blocks；hook 的 steer 和闲时 follow-up 也只传 images。不能把 prompt 路径有原图卡片等同于每个发送模式都有。
3. `components/ChatInput.tsx:945` 附件发送 await 成功后直接 clearInput，未检验 capturedDraftKey；切 B 后旧 A 成功回调可能清当前输入。应与 F4/F5 同时做真实组件级延迟响应测试。
4. 新建 prompt 回执只检查 truthy status；其他 sendAgentCommand 泛型无运行时 receipt 校验；queued 缺 snapshot 仍可能被当 accepted。完整 trust-boundary 测试未补齐。
5. `pidance-runtime` 仍称引导要“先清 Host 队列再发”，与现有服务端 dispatch 实现不一致；后续按技能维护流程同步，不能用过时规则作为实现正确证据。

## 架构收敛建议（不是要求大重构）

依赖方向 Route → Service → Registry → Host → SDK 可继续保留，问题在职责尚未闭合：

1. **意图/载荷**：普通/引导/排队都复用一个完整 payload 序列化入口；纯图判断、图片配对、binary 卡片不可分别丢字段。
2. **浏览器事务**：runtime/会话级 owner 持有原 sid、submissionId、草稿和 unknown；UI 仅显示，不因切页决定消息是否保存。不要让新队列账本修复绕过该 owner。
3. **队列写入**：整包 CAS 必须绑定产生整包的基线；冲突后不能把旧 pending 换成新版本重放。服务端稳定 itemId 已存在，但客户端写入仍舍弃 ID、按正文对齐，不宜声称全链路稳定身份已经完成。
4. **消费与恢复**：每次被接受的持久状态必须可由相同 decoder 无损读回；claimed/unknown 保护不得被超限 merge 绕过。
5. **媒体生命周期**：上传、草稿、产品队列、已发送历史是不同持有者；“当前输入框不引用了”不足以证明磁盘文件无人使用。回收以完整引用证据为准。

优先修 F11/F6/F4/F2/F10/F8，再补 F1/F3/F5/F9/F7；按交错时序做回归，不以增加静态源代码断言代替行为测试。

## 多端验收条件

- **桌面浏览器**：完整四路径，纯图/多图/普通文件，失败恢复，上传取消与迟到，队列召回→再投递。
- **手机浏览器（如 390×844）**：复用上述 payload/owner；验证按钮、软键盘换行与显式引导差异，后台/前台期间晚到响应不丢原会话草稿。
- **多标签**：F11 的冲突+后继操作、双标签普通 prompt、同图草稿移除/队列引用保护；不得只验证两个单次请求 CAS。
- **Electron/Windows**：共享网页/Host 的所有问题同样适用；本轮未改 desktop 专有 bridge。用跨平台路径/合法文件名 fixture 覆盖 GC，Windows 手工仅作待确认附注，不能代替自动化，也不作为关闭的必需人工门禁。
- 当前没有新浏览器证据，不能将仅通过 Node 单测包装为 A9/A10/A11 全端验收完成。
