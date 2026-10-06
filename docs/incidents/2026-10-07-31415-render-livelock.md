# 调查报告：31415 稳定版卡死（工具渲染把事件循环打满）

时间：2026-10-07 00:17–00:24（+08）
版本：Pidance `@henlii/pidance` 0.2.52（`~/.local/share/pidance/releases/0.2.52`，systemd user unit `pidance.service`）
工作区代码：`main` @ `21e8c25`
结论：**进程没崩，是被一次超大工具输出（advisor 咨询，55 万字符且仍在增长）的重复全量重渲染打到 100% CPU，事件循环再无空闲处理 HTTP、定时器和租约心跳。** 属于可复现的设计缺陷，不是偶发故障。

---

## 1. 现象

| 观测项 | 卡死时 | 重启后 |
|---|---|---|
| `GET http://127.0.0.1:31415/` | 15s 无响应，0 字节（TCP 已连上） | 200，5–10ms |
| 进程主线程 | 5s 内 497 tick ≈ 单核 99.4%（worker 线程 ~0） | 8% |
| RSS | 4.68GB → 5.33GB（仍在涨，约 5MB/s） | 280MB |
| systemd `MemoryCurrent` | 9.31GB | 234MB |
| 端口 | 在监听（0.0.0.0:31415） | 同 |
| HTTP 连接 | 大量 CLOSE-WAIT，接收队列压着 1KB–6.6KB 未读请求；ESTAB 连接 Send-Q 1081 | 正常 |

端口活着、TCP 三次握手能成，但一个字节的业务数据都没处理——这是「事件循环被同步 JS 占满」的典型形态，不是崩溃也不是死锁。

## 2. 现场证据

### 2.1 时间线

| 时刻（+08） | 事件 |
|---|---|
| 10-05 14:33:41 | 31415 进程启动（release 0.2.52），累计 uptime 到卡死时 33.7 小时 |
| 10-06 23:38:53 | 会话 `01a10f1a-9cba-…`（cwd `/home/moss/works/open/pidance`）取得 running 租约 |
| 10-07 00:00:03 | 该会话最后一次写盘：assistant 发起 `ask_advisor`（toolCallId `call_z6nre3em`，draft 是 21e8c25 面板拖拽提交的复核请求） |
| 00:01:32 | journal 仍有该进程的定时任务输出（未读条目回收）——此时事件循环还能跑定时器 |
| 00:08:16 | 租约心跳最后一次落盘（心跳间隔 8s）——**此后定时器再没跑过** |
| 00:17–00:19 | 采样：主线程 99% 在渲染；partialResult 273KB → 550KB；HTTP 15s 无响应；RSS 涨到 5.3GB；内存 3.53GB 计在 ArrayBuffers |
| 00:24:22 | 用户确认后重启 `pidance.service` |

### 2.2 栈采样（`kill -USR1` 打开 inspector 后经 CDP `Debugger.pause` 抓取）

连续 9 次采样，栈顶**全部**落在渲染链内，但命中位置各不相同（折行、宽度计算、markdown 词法、背景色应用）——说明不是某一个转不出来的死循环，而是事件循环被一次次渲染持续占满，每次采样都正好撞在另一次渲染中间。

```
processTicksAndRejections
  _handleAgentEvent → _emit (EventEmitter)
    handleSessionEvent
      withRenderedToolLines        ← lib/sdk-session-host.ts:2321
        renderToolSlotsNow         ← lib/sdk-session-host.ts:2629
          render → render
            wrapTextWithAnsi → wrapSingleLine → splitIntoTokensWithAnsi
            visibleWidth / isPrintableAscii / applyBackgroundToLine
            lexer → inlineTokens → inlineText
```
被渲染的事件：

```json
{ "type": "tool_execution_update",
  "toolName": "ask_advisor",
  "toolCallId": "call_z6nre3em",
  "streamRunSeq": 1,
  "argsKeys": ["draft", "gitContext"],
  "partialResult": "…（55 万字符，仍在增长）" }
```

文本开头是 advisor 的评审正文（"I'll review the claimed panel-resize commit against the actual code, tests, and remaining product risks…"），也就是**顾问模型自己吐出了一份失控的长回复**——这是触发条件，不是 Pidance 的锅；但 Pidance 不该被它打死。

### 2.3 增长速率

| 采样时刻 | partialResult 长度 |
|---|---|
| 00:17:30 | 273,312 |
| 00:18:26 | 550,195 |
| 00:18:30–00:18:43 | 550,539 → 551,601 |

增长是突发式的（56s 涨 27.7 万，随后 16s 只涨 1.4K）。**关键点：渲染开销取决于输出总长度，与单次增量无关**，所以哪怕流已经变慢，事件循环也救不回来。

## 3. 根因链

1. 工具结果渲染是**全量重渲染**：每次得到 `partialResult` 就把它整段交给插件渲染器，advisor 插件把全文塞进 `new Markdown(text)`，包一层带背景色的 `Box`，再调 `component.render(width=100)`。
   - 宿主：`lib/sdk-session-host.ts:2432`（`tool_execution_update` 分支）→ `:2629` `renderToolSlotsNow` → `lib/tui-render-bridge.ts:656` `renderToolResultLines`。
2. **触发源不止流式增量**。advisor 插件在 partial 阶段挂了一个 80ms 的 spinner 定时器（`pi-advisor-flow@0.8.0` dist:`renderPartialAdvisorResult` 里 `setInterval(() => context.invalidate(), 80)`），经 `context.invalidate` → `scheduleToolRerender` → `createToolRenderScheduler`。**即使一个字节的新数据都没有，也会持续触发重渲染。**
3. 限流是**按时间**（100ms），不是按开销：
   - `PARTIAL_RENDER_MIN_INTERVAL_MS = 100`（`lib/sdk-session-host.ts:608`，增量路径）
   - `RERENDER_MIN_INTERVAL_MS = 100`（`:615`，插件 invalidate 路径）
   两条路各允许 10 次/秒。
4. 单次渲染实测量级 ~300ms（见第 4 节）。10 次/秒 × 300ms = **3 秒的活压在 1 秒里**，事件循环永久欠债：定时器（心跳、未读回收、SSE heartbeat）、HTTP 处理、socket 读全部饿死。
5. 而且这些开销**全部白干**：`lib/tui-render-bridge.ts:566` 的 `isValidRenderOutput` 在渲染**之后**才判 `RENDER_MAX_LINES = 500` / `RENDER_MAX_TOTAL_CHARS = 200KB`。实测 55 万字符渲染出 8360 行 / 约 100 万字符，必然超限 → 返回 null → 丢弃。每 100ms 烧掉一次 300ms 的 CPU，产出为零。

## 4. 量化（离线复刻同一条渲染路径）

脚本：`/tmp/pidance-render-bench.mjs`、`/tmp/pidance-render-bench2.mjs`
环境：`@earendil-works/pi-tui@0.87.0`（release 0.2.52 自带那份），复刻插件结构 `Box(bg) > Markdown(text)`，`render(100)`，连续实测。

| 输入字符数 | 单次渲染耗时 | 输出行数 | 输出字符数 | 是否被上限丢弃 |
|---|---|---|---|---|
| 10,000 | 9–29 ms | 152 | 18K | 否 |
| 100,000 | 48–59 ms | 1,523 | 182K | 否 |
| 200,000（≈`RENDER_MAX_TOTAL_CHARS`） | ~100 ms | ~3,000 | ~360K | 是 |
| 273,000 | 132 ms | 4,151 | 495K | 是 |
| 550,000 | 269–298 ms | 8,360 | 997K | 是 |

耗时与总长度近似线性（≈0.5 µs/字符）。表里 20 万那行是按线性插值估的，其余为实测。

由此推出**临界点**：输出超过约 20 万字符时，单次渲染已 ≥100ms，与 100ms 的限流间隔相等；再往上，限流放行的频率就超过事件循环的实际吞吐——一旦越过这条线，进程再也不会恢复空闲。本次事故里 advisor 输出冲到 55 万字符，是临界点的近 3 倍。

## 5. 现有防护为什么没挡住

| 防护 | 位置 | 为什么无效 |
|---|---|---|
| 增量渲染限流 100ms | `lib/sdk-session-host.ts:608` | 限的是频率，不是开销；单次渲染 > 100ms 时限流形同虚设 |
| 插件 invalidate 限流 100ms | `lib/sdk-session-host.ts:615` + `lib/tool-render-scheduler.ts` | 同上；且插件自带 80ms spinner，是持续的独立触发源 |
| 输出上限 500 行 / 200KB | `lib/tui-render-bridge.ts:128-130`、`:566` `isValidRenderOutput` | 校验在 `component.render()` **之后**，省不下任何计算 |
| 租约心跳 8s | `lib/session-running-lease.ts` | 心跳跑在同一个被占满的事件循环里，00:08 之后再没触发 |

## 6. 附带发现（**经复核不成立**，见 §11.1）

~~**租约判活窗口 20s，心跳停在 00:08:16 → 从 00:08:36 起，别的实例（31416）会把 `01a10f1a` 判成「无人持有」**（`lib/session-running-lease.ts:204`：`now - heartbeatAt <= 20s && pidAlive`）。这时若在另一边打开同一会话并发起 prompt，两个进程会同时写同一个 JSONL —— 撞上 `SessionManager` 唯一 writer 的硬边界。~~

更正：`:204` 那个 20s 窗口只在 `isFresh` 里用，而它唯一的调用点是租约扫描里给「新鲜租约」列表
用的；接管 / 占用 / 写保护一律只看**持有者 pid 是否存活**（`isLeaseHeldByLiveOwner`），心跳过期
不放行。心跳被饿死**不会**让别的进程抢走 writer，本次事故没有双写风险 —— 依据见 §11.1。

## 7. 未确认项

- **3.53GB 计在 ArrayBuffers 名下**（`heapUsed` 只有 311MB，`external` 3.54GB），卡死期间以约 5MB/s 增长。最可能的方向：SSE 每帧原样透传 `tool_execution_update`（含完整 `partialResult`，55 万字符），几十个连不上又没断开的客户端各自排队导致帧积压（`app/api/agent/[id]/events/route.ts` 用 `ReadableStream` + `controller.enqueue`，没有背压处理）。**没有证实**，进程已被重启，无法再做堆快照。下次复现时应在卡死前用 inspector 抓 `--heapsnapshot`。
- 顾问模型为什么能吐出 55 万字符、且长时间不收敛，属于 advisor 那条链路的问题，本次没展开。

## 8. 复现步骤

不必真的等下一次事故，用离线基准即可复现核心现象：

```bash
# 1) 量单次渲染开销 + 事件循环是否被占满（本报告第 4 节的数据与 §11.2 的验证）
node scripts/verify-render-livelock.mjs

# 2) 端到端：在 31416 上建一个测试会话，让某次工具调用产出 >20 万字符的 partial
#    （最省事的办法：注册一个 renderResult 恒返回 new Markdown(巨文本) 的测试插件），
#    然后观察 /proc/<pid>/stat 的 utime 与 curl 的响应时间。
```

现场取证手法（本次用的，注意副作用）：

```bash
kill -USR1 <pid>                     # Node 会打开 inspector，监听 127.0.0.1:9229
curl -s http://127.0.0.1:9229/json/list   # 取 webSocketDebuggerUrl
# 用 CDP 连上去：Debugger.enable → Debugger.pause → 读 callFrames
# 结束后 Debugger.resume；inspector 端口会一直开着直到进程退出（重启即清）
```

## 9. 修复建议

按优先级：

**P1 渲染预算按实测开销自适应（根治）**
把固定 100ms 换成有反馈的间隔：`minIntervalMs = max(100, 上次单次渲染耗时 × K)`，或在调度器里累计「渲染占用时间 / 墙钟时间」，超过阈值（例如 30%）就抬高间隔。目标是任何情况下渲染都不允许吃满事件循环。改在宿主通用层（`lib/tool-render-scheduler.ts` / `lib/sdk-session-host.ts`），不碰插件——符合「显示优化必须通用」。

**P2 上限前置（止血，见效快）**
在调用插件渲染器**之前**按 `partialResult` 体量判断：超过「可能产出的行数/字符数上限」就直接不渲染，走既有的原文回退路径，并给出**可见**降级（例如卡片上标「输出过大，未渲染，展开看原文」）。现在这条路径是「烧 300ms 再静默丢弃」，用户既没看到内容也没得到提示。

**P3 SSE 不再每帧重发全文**
`tool_execution_update` 现在原样透传（`lib/agent-event-stream.ts`）。对超大 partial，服务端应发「增量」或「截断 + 快照 id」，而不是每个客户端、每帧都序列化 55 万字符。顺带给 `ReadableStream` 加背压/丢弃策略。

**P4 租约的次生风险**
心跳被饿死后 20s 就判无人持有。至少要保证「进程还活着但心跳停了」不会导致另一个 writer 抢锁：可以把判活窗口放大到分钟级，或在抢锁失败路径上明确拒绝并提示，而不是静默接管。

## 10. 当前状态

- 31415 已重启（`systemctl --user restart pidance`，00:24:22），释放约 9GB，CPU 8%，页面 5ms 响应。
- 会话 `01a10f1a` 的 JSONL 完好，断点是 00:00:03 那条发起 `ask_advisor` 的 assistant 消息；那次顾问咨询的结果丢失，未写盘。
- 该会话现在由新进程以 `running: false` 重新登记租约，不会自动重跑。
- 根因**已在工作区修复**（渲染开销预算，见 §11.2）；发布版 0.2.52 里仍是旧逻辑，要等下一次发版。
- §6 的次生风险经复核**不成立**（见 §11.1）。

---

## 11. 复核与修复（工作区，2026-10-07）

### 11.1 §6 的双写风险：不成立

判活窗口 `RUNNING_LEASE_TTL_MS = 20s` 只用在 `isFresh`（`lib/session-running-lease.ts:203`），
而 `isFresh` 唯一的调用点是 `scanLeases` 里给「新鲜租约」列表用的（启动清扫的 active 计数）。
所有**接管 / 占用 / 写保护**判定走的都是 `isLeaseHeldByLiveOwner`：

- `isRunningLeaseHeldByOther`（`acquireRunningLease` 与各写保护路径）
- `isRunningLeaseActivelyRunningByOther`（对端「在跑」的投影）
- `canEvictLease`（租约回收）

三者都只看 `isPidAlive(lease.pid)`，心跳过期一概不放行 —— 文件里那段注释写的正是本次这个场景
（「持有者可能只是被 SIGSTOP / 长阻塞 / GC 暂停，进程仍活着，其 SessionManager 仍持有 JSONL
writer」）。既有测试也钉着它：`lib/session-running-lease.test.mjs` 的
「running lease：活 pid 心跳过期不得抢占，死 pid 才可接管（#30）」。

结论：心跳被饿死**不会**让另一个实例拿到 writer，本次事故没有双写风险；不需要为此改租约。

### 11.2 已修：渲染开销预算（§9 的 P1）

新增 `lib/render-budget.ts`：把「上一次渲染花了多久」换成「下一次至少等多久」——
`minIntervalMs = max(基础间隔, 上次开销 ÷ 0.25)`。基础间隔更大时取基础间隔，所以正常情况下
行为与改动前完全一致；开销超过基础间隔（实测 55 万字符 ≈ 262ms）才按占空比放大。
**有意不设上限**：宁可最坏情况下界面更新变慢，也不让事件循环被打满。

接线：

- 宿主在 `renderToolSlotsNow`（所有工具重渲的**唯一**入口：partial / 插件 invalidate / start / end）
  量实际开销并在 `finally` 里记账；
- partial 限流（`shouldRenderPartialUpdate`）从固定 100ms 改成读预算；
- 插件 `invalidate` 的调度器（`lib/tool-render-scheduler.ts`）改为现读预算（`minIntervalMs` 支持函数），
  每次调度只读一次；
- 宽度变化的重渲（`rerenderToolLines`）从 `flushAll`（立即、绕过限频）改成走限频路径 ——
  拖动窗口时宽度是**逐帧**变的，一个超大工具输出拖着窗口就能把循环打满。

验证（`node scripts/verify-render-livelock.mjs`：真 pi-tui 的 `Box + Markdown(55 万字符)`、
每 80ms 一次 invalidate、另挂一个 100ms「心跳」定时器，跑 6s）：

| | 重渲次数 / 6s | 渲染占墙钟 | 心跳 |
|---|---|---|---|
| 改前（固定 100ms 间隔） | 25 | **98%** | 13/64（饿死） |
| 改后（开销预算） | 6 | **25%** | 45/60（正常） |

单次同步渲染仍会把一个 100ms 定时器最多推后「一次渲染」的时长 —— 要保证的是渲染**不占满**
事件循环，而不是单次不卡。

### 11.3 未修（留给决策）

- **§9 P2「上限前置」**：按 partial 体量在调用插件渲染器之前拦掉。这条是**启发式** —— 输入大
  不等于插件输出必然超限（插件可以只画摘要），拦掉会换掉用户看到的卡片；而且现在的路径是
  「烧掉 300ms 再静默丢弃」，要变成可见降级得动客户端契约（工具卡上的「输出过大」提示）。
- **§9 P3「SSE 不再每帧重发全文」**：`app/api/agent/[id]/events/route.ts` 仍在 `controller.enqueue`
  里每帧发完整 `partialResult`，且**没有背压处理**。§7 那 3.5GB ArrayBuffers 最可能出在这里
  （循环被占满 → socket 排不出去 → 每帧约 550KB 的 `Uint8Array` 堆在流队列里）。预算修好后
  循环能排空、积压自然消失，但「慢客户端 + 超大帧」的积压风险仍在，值得单独做。

---

## 附录 A：基准脚本（自包含，可直接跑）

放到任意路径执行即可复现第 4 节的数字。用的是 release 自带的 pi-tui；换成工作区那份（`node_modules/@earendil-works/pi-tui`）结果同量级。

```js
// render-bench.mjs
import { Markdown, Box } from '<pi-tui>/dist/index.js';   // 见下方路径说明

const id = (t) => t;
const theme = {
  heading: id, link: id, linkUrl: id, code: id, codeBlock: id, codeBlockBorder: id,
  quote: id, quoteBorder: id, hr: id, listBullet: id, bold: id, italic: id,
  strikethrough: id, underline: id,
};

// 近似顾问输出：连续散文段 + 少量 markdown 结构
const para = 'The advisor streams prose back in deltas. Each delta re-renders the whole partial output, so cost grows with total length, not with the delta size. ';
function makeText(chars) {
  let out = '';
  while (out.length < chars) {
    out += `## Section ${Math.floor(out.length / 2000)}\n\n${para.repeat(6)}\n\n- ${para.slice(0, 80)}\n- ${para.slice(0, 60)}\n\n`;
  }
  return out.slice(0, chars);
}

for (const n of [10_000, 100_000, 273_000, 550_000]) {
  const box = new Box(1, 0, (t) => `\x1b[48;5;236m${t}\x1b[49m`);   // 复刻插件的外层背景框
  box.addChild(new Markdown(makeText(n), 0, 0, theme));
  const t0 = performance.now();
  const lines = box.render(100);                                    // RENDER_WIDTH = 100
  const t1 = performance.now();
  console.log(`${n} chars -> ${(t1 - t0).toFixed(0)} ms, ${lines.length} lines, ${lines.reduce((a, l) => a + l.length, 0)} 输出字符`);
}
```

pi-tui 路径：

- release 副本：`~/.local/share/pidance/releases/0.2.52/node_modules/@earendil-works/pi-tui/dist/index.js`
- 工作区顶层：`node_modules/@earendil-works/pi-tui/dist/index.js`
- 工作区 SDK 内嵌副本：`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js`

## 附录 B：现场原始读数

```
# ss -tnp | grep 31415（节选）
CLOSE-WAIT 6691 0  100.99.31.9:31415  100.99.31.8:58383
CLOSE-WAIT 1095 0  100.99.31.9:31415  100.99.31.8:58407
ESTAB      1081 0  100.99.31.9:31415  100.99.31.8:58411
FIN-WAIT-2    0 0  127.0.0.1:60606     127.0.0.1:31415
（Recv-Q 是服务器没读走的请求字节）

# /proc/<pid>/task 逐线程 tick（5 秒窗口）
ticks/5s=   497  tid=3545803  MainThread
ticks/5s=     4  tid=3545811  V8Worker
（其余线程 ≈ 0；100 tick/s = 单核 100%）

# process.memoryUsage()（inspector 内取）
{ rss: 5328445440, heapTotal: 429043712, heapUsed: 290777544,
  external: 3698591677, arrayBuffers: 3694218305 }

# 卡死时的租约文件
{"pid":3545803,"sessionId":"01a10f1a-9cba-7232-b942-a59d54e536f2",
 "heartbeatAt":1791302896665,"startedAt":1791301133977,"running":true}
（heartbeatAt = 00:08:16，观测时已 00:17，超过 20s TTL）
```
