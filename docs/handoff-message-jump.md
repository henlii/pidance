# 交接文档：消息导航跳转（已完成）

最后更新：2026-10-06
状态：**已修复并提交（f20a99f + c4a35f6）。**

后续会话的结论（推翻本文的部分推断，先看这段再往下读）：

- §10.3「每页只有 77 条」不成立：页宽按 500 生效（实测一页 ≈ 500 条可见消息
  ≈ 950 条记录）。总数少是因为该会话本来就只有 2375 条 —— 补 3 页就到头了。
- §6.3/§6.4「视口始终被钉在底部」不是 bug：补页只往上方插内容，视口停在原内容上，
  表现就是仍贴着（变长后的）底部。这条被误判成了自动跟随抢滚动。
- 真正的成因有两个，都在 `hooks/useMessageJump.ts`：① 补页循环在 `await` 之后
  同步查一次 DOM，React 还没提交，必然查不到 → 一路补到顶端 → `loadOlder` 返回
  false → 旧代码 `return false` 结束整次跳转（目标其实已经在时间线里）；② 增量
  分支从没调过 `notifyBrowsingHistory`。
- §10.2 的备选方案（`around` + `toEnd=1`）没有采用：它换的是请求数不是渲染量，
  而耗时几乎全花在把上千条消息挂进 DOM 上。`jumpToEntry` 保留原样，目前无调用方
  （它是 `hasMoreAfter` /「加载更新的历史」那套机制的唯一生产者）。
- 后续又改了一版（c4a35f6）：按页宽 500 一页页补仍然「多补一页」—— 点最近的那条
  未加载消息，目标离窗口起点只有 40 条也要拉 ≈950 条。现在 context 接口加了 `from`
  参数，与 `before` 一起表示「要 [from, before) 这一段」，距离由服务端按两个 entryId
  精算，跳转一次请求到位（实测 rail #78：99ms / 112KB / DOM 只涨 69 条）。
  相关代码：`lib/session-context-window.ts` 的 `sliceContextRange`、`from` 参数。

---

# 0. 一句话概括

用户在会话区左侧的「用户消息导航条」点击一条历史消息时，希望**保留当前已加载的内容、
往更早方向逐页加载直到目标进入时间线、然后快速滚动过去**。

目前的实现确实在增量加载（时间线从 52 条涨到 2352 条），但**补了 2300 条仍未抵达目标**，
且**视口始终被钉在底部**。等于"加载了一堆但没定位"，比改动前还差。需要继续修。

---

# 1. 任务

## 1.1 用户的原话（按时间顺序）

1. > 点击消息导航的效果应该是先加载会话到选中消息处，然后快速滚动到选中消息位置

2. > 现在会把后续的会话折叠起来

3. > 此处的逻辑应该是点击消息后，以当前已经加载的消息为准，继续上前加载到选中位置的会话，然后再滚动过去

4. > 那就继续，不完成不要停。

## 1.2 需求拆解

| # | 要求 | 出处 |
|---|------|------|
| R1 | **保留**当前已加载的消息，不要整体换窗 | 原话 3 的"以当前已经加载的消息为准" |
| R2 | 往**更早**方向增量加载，直到把选中的那条包进来 | 原话 3 的"继续上前加载到选中位置的会话" |
| R3 | 加载完**滚动过去**（且要"快速"） | 原话 3 + 原话 1 |
| R4 | 目标**之后**的消息不能消失 | 原话 2（这是最初报的现象） |

## 1.3 最初的现象（R4 的由来）

点导航跳过去之后，目标之后的消息不在时间线里，底部出现一个「加载更新的历史」按钮
（`components/ChatWindow.tsx:1401`，label `t("chat_loadNewer")`），要手动点才往下补。
用户把这种现象描述为"把后续的会话折叠起来"。

---

# 2. 涉及的功能与调用链

## 2.1 组件拓扑

```
AppShellInner (components/AppShell.tsx:108)
 └── ChatWindow (components/ChatWindow.tsx:161)
      ├── 会话区滚动容器  <div ref={scrollContainerRef} data-chat-scroller="true">
      ├── 消息列表        每条消息一个 [data-message-entry-id] 元素
      ├── MessageNavRail  左侧竖条（绝对定位覆盖层，不参与布局）
      └── useMessageJump  跳转机制（hook，由 ChatWindow 持有）
```

## 2.2 消息导航条（MessageNavRail）

- 位置：`components/MessageNavRail.tsx`
- 渲染条件：非手机端（`ChatWindow` 里 `isMobile` 时该区域返回 null）
- 每一项是一个 `<button>`，`aria-label` = `messageNavPreview(item.text)`（消息预览文本），
  见 `MessageNavRail.tsx:511`
- **容器本身**也有包含「用户消息导航」字样的 aria-label —— 这正是探针一开始选错元素的原因
- 点击处理：`MessageNavRail.tsx:514` → `onClick={() => void jumpTo(item.entryId)}`
- hover 预览也会触发：`MessageNavRail.tsx:421` → `void jumpTo(item.entryId)`

跳转机制本身**不在**这个组件里，它通过 prop 注入（`MessageNavRail.tsx:42` 声明
`jumpTo: (entryId: string) => Promise<boolean>`）。原因写在 `useMessageJump.ts` 的模块注释里：
定位请求可能由会话外发起（全文搜索命中），消费方必须始终挂载，而导航条在手机端不渲染。

## 2.3 跳转的完整链路

```
用户点导航条某一项
  → MessageNavRail 的 onClick 调 jumpTo(entryId)
  → useMessageJump.jumpTo
       ├─ 判断目标是否已在 DOM（resolveMessageElementRef）
       ├─ 不在 → 触发加载（改前是 jumpToEntry；改后是 loadOlder/loadNewer）
       ├─ 等目标进 DOM（waitForTarget，最多 10 帧 rAF）
       └─ scrollToTarget（滚动 + 收敛校正）
  → 加载走 HTTP：GET /api/sessions/<id>/context?...
  → 服务端 app/api/sessions/[id]/context/route.ts
  → lib/session-context-window.ts 的切片函数
  → 客户端 registry.hydrate(...) 把结果并进时间线
```

## 2.4 会话内容的两种加载方式

| 方式 | 参数 | 客户端合并 | 是否保留现有内容 |
|------|------|-----------|-----------------|
| 换窗（`jumpToEntry`） | `around=<entryId>` + `toEnd` | `mode: "replace"` | ❌ 整段替换 |
| 向上分页（`loadOlderHistory`） | `before=<当前最早 entryId>` | `mode: "prepend"` | ✅ 前插保留 |
| 向下分页（`loadNewerHistory`） | `after=<当前最新 entryId>` | `mode: "append"` | ✅ 追加保留 |

**本次改动就是把跳转从第一行换成了第二/三行。**

---

# 3. 改动前的原逻辑（完整）

## 3.1 加载：`jumpToEntry`（`hooks/useAgentSession.ts:1870`）

```js
const jumpToEntry = useCallback(async (
  entryId: string,
  options?: { limit?: number; toEnd?: boolean },
): Promise<boolean> => {
  const sid = sessionIdRef.current;
  if (!sid || !entryId) return false;
  const generation = ++jumpGenerationRef.current;
  const leafAtStart = activeLeafIdRef.current;
  const isCurrent = () =>
    jumpGenerationRef.current === generation
    && sessionIdRef.current === sid
    && activeLeafIdRef.current === leafAtStart;
  const registry = getOrCreateBrowserSessionRuntimeRegistry();
  const hydrateRequestSeq = registry.beginHydrate(sid);
  const hydrateSinceSeq = registry.getSnapshot(sid)?.timelineSeq ?? 0;
  // 进入「浏览历史」态必须发生在加载之前：hydrate 提交新窗口的那一帧会改变内容高度，
  // 若此时仍是 following，自动跟随会先钉底（用户看到「先向下滚一段」），随后才切态。
  notifyBrowsingHistory();
  try {
    const params = new URLSearchParams({
      around: entryId,
      deferThinking: "1",
      deferMedia: "1",
      toEnd: options?.toEnd === false || !agentRunning ? "0" : "1",
    });
    if (options?.limit) params.set("limit", String(options.limit));
    if (leafAtStart) params.set("leafId", leafAtStart);
    const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/context?${params}`, {
      signal: beginLoadRequest(),
    });
    if (!res.ok) return false;
    const d = await res.json() as { context: { messages; entryIds; hasMoreBefore?; hasMoreAfter?; totalMessageCount? } };
    if (!isCurrent()) return false;
    const outcome = registry.hydrate(sid, nextMessages, nextEntryIds, {
      sinceSeq: hydrateSinceSeq,
      hydrateRequestSeq,
      mode: "replace",
      pending: "retain",
      hasMoreAfter: d.context.hasMoreAfter === true,
    });
    ...
  }
}, [agentRunning, beginLoadRequest, notifyBrowsingHistory]);
```

`toEnd` 那一行是关键：**空闲会话（`!agentRunning`）取 `toEnd=0`**，也就是只取目标附近一页，
目标之后的内容不进时间线 —— 直接造成 R4 的现象。

原注释（已随改动回退保留）：

```
// 只有运行中的会话才取到最新：那时「目标 → 最新」整段必须留在时间线里，
// 否则尾部流式输出会脱离时间线。空闲会话只取锚点附近一页 —— 以前靠客户端
// 渲染窗口压 DOM，窗口已删除，取到最新会把几千条消息一次性塞进 DOM。
// 向下补由 hasMoreAfter + loadNewerHistory 负责。
```

## 3.2 滚动：改前的 `scrollToTarget`

```
settleThenScroll()                        递归 rAF，等布局连续 2 帧稳定
  → scrollEl.scrollTo({ top, behavior: "smooth" })     原生 smooth，时长浏览器定、不可调
  → watch()                             每 60ms 采样 scrollTop，连续 3 次不变才算动画结束
  → converge()                          最多 12 次 × 100ms 的有界校正
```

原注释（说明为什么不能用固定 450ms 判断动画结束）：

```
// 等平滑动画真正停下（连续三次 scrollTop 不变）再进收敛：
// 固定 450ms 太早，会在动画中段就判「偏离」并把视口定在中途
// （实测：目标停在视口上方 214px，而它本可以贴顶）。
```

**项目里其实已经有自控时长的缓动实现**，只是跳转没用它：

- `components/MessageNavRail.tsx:620` `export function easeInOutCubic(t: number): number`
- `components/MessageNavRail.tsx:632` `export const RAIL_SCROLL_DURATION_MS = 420;`
- `components/MessageNavRail.tsx:638` `export function railScrollBehavior(...)`
- 使用处 `MessageNavRail.tsx:230` `scrollRailTo`（导航条自身的滚动）

那条注释写得很直白：

```
/**
 * 缓动：两端慢、中间快。
 *
 * 原生 scrollTo({behavior:"smooth"}) 的时长由浏览器决定且不可调（实测偏快），
 * 所以要自己插值。
 */
```

---

# 4. 改动后的代码（工作区未提交）

## 4.1 `hooks/useMessageJump.ts`

### 4.1.1 props 变化

删除：

```ts
/** 按 entryId 跳到历史某条：服务端返回该条附近窗口并整体替换时间线（一次到位） */
jumpToEntry: (entryId: string) => Promise<boolean>;
```

新增：

```ts
/** 向上（更早）补一页，保留当前已加载的消息（prepend）；limit 可指定页宽 */
loadOlder: (limit?: number) => Promise<boolean>;
/** 向下（更晚）补一页 */
loadNewer: () => Promise<boolean>;
/** 更早方向还有没有内容（决定还能不能再往上补） */
hasMoreBefore: boolean;
/** 更晚方向还有没有内容 */
hasMoreAfter: boolean;
```

### 4.1.2 新增常量

```ts
const JUMP_SCROLL_DURATION_MS = 260;

/**
 * 跳转时每页取多少条。
 *
 * 不跟「会话内容懒加载」设置走：那条设置是给正常上滚分页用的（默认 20 条），
 * 而跳转要跨很远的历史，按 20 条补 30 页只有 600 条，稍长的会话根本到不了目标。
 * 取服务端上限 500（clampLimit 1..500），30 页 ≈ 15000 条，覆盖任何合理长度。
 */
const JUMP_LOAD_PAGE_LIMIT = 500;

/**
 * 一次跳转最多补几页。
 *
 * 「以当前已加载的消息为准往上补」要一页页来，目标可能离当前窗口很远；
 * 但也不能无限补（目标不在这个分支、或已被删除时会把整条会话拉下来）。
 * 30 页 × 默认 100 条 ≈ 3000 条，够覆盖正常的历史跳转。
 */
const MAX_JUMP_LOAD_PAGES = 30;
```

（注意：最后这段注释里的"默认 100 条"与后来加的 `JUMP_LOAD_PAGE_LIMIT = 500` 已经不一致，
修的时候顺手改掉。）

### 4.1.3 新增导入

```ts
import { easeInOutCubic } from "@/components/MessageNavRail";
```

### 4.1.4 `jumpTo` 主体（替换掉原来的 `immediate` 之后整段）

```ts
    let handedOff = false;
    // 目标已在 DOM：不加载，直接滚过去（用户就是在当前窗口里点的这一条）。
    const immediate = await waitForTarget();
    if (immediate) {
      notifyBrowsingHistory();
      handedOff = true;
      scrollToTarget(immediate);
      return true;
    }

    setJumpingTo(entryId);
    // 增量补页会往时间线里插内容（向上是 prepend），上方高度一变当前视口就被推走。
    // 先记下「加载前视口顶部那段内容」，每补一页后把它钉回去 —— 用户读到的位置不动。
    const anchor = captureAnchor();
    try {
      // 以当前已加载的消息为准，往更早的方向一页页补，直到目标进入时间线。
      //
      // 这里刻意不用「around 换窗」：那会把已经读到的内容整段替换掉，目标之后的消息
      // 也不在手边（表现为「跳过去以后后续的会话被折叠起来」）。增量补页保留现状，
      // 加载完直接滚过去。
      let pages = 0;
      while (!findTarget() && hasMoreBefore && pages < MAX_JUMP_LOAD_PAGES) {
        pages += 1;
        if (!(await loadOlder(JUMP_LOAD_PAGE_LIMIT)) || !isCurrent()) return false;
        if (anchor) applyAnchorOffset(anchor);
      }
      // 更早的方向到底了目标还没出现：说明它在更晚的方向，往下补。
      while (!findTarget() && hasMoreAfter && pages < MAX_JUMP_LOAD_PAGES) {
        pages += 1;
        if (!(await loadNewer()) || !isCurrent()) return false;
        if (anchor) applyAnchorOffset(anchor);
      }
      const target = await waitForTarget();
      if (target && isCurrent()) {
        handedOff = true;
        // 锚点还在就继续钉着，然后滚到目标（动画保留）；没有锚点就直接滚。
        scrollToTarget(target, anchor ? { anchor } : undefined);
      }
    } finally {
      if (isCurrent()) setJumpingTo(null);
      // 未交给 scrollToTarget（目标始终没渲染出来）：立即按归属解除钉住。
      // 漏这一步的后果不是“高亮不准”，而是导航条**永久停止跟随**。
      if (!handedOff && jumpPinRef.current === entryId) jumpPinRef.current = null;
    }
    return handedOff;
  }, [loadOlder, loadNewer, hasMoreBefore, hasMoreAfter, resolveMessageElementRef, scrollContainer, railHandleRef, notifyBrowsingHistory]);
```

### 4.1.5 滚动实现（`scrollToTarget` 里 `settleThenScroll` 的收尾段）

改前：

```ts
        if (nextStable >= 2 || attempt > 20) {
          scrollEl.scrollTo({ top, behavior: "smooth" });
          // 等平滑动画真正停下（连续三次 scrollTop 不变）再进收敛：
          // 固定 450ms 太早，会在动画中段就判「偏离」并把视口定在中途
          // （实测：目标停在视口上方 214px，而它本可以贴顶）。
          const watch = (lastTop: number, idleFrames: number) => {
            if (interrupted || !isCurrent() || !el.isConnected) { stopWatching(); return; }
            const now = scrollEl.scrollTop;
            if (idleFrames >= 3) { converge(0, 0); return; }
            window.setTimeout(
              () => watch(now, Math.abs(now - lastTop) < 1 ? idleFrames + 1 : 0),
              60,
            );
          };
          window.setTimeout(() => watch(scrollEl.scrollTop, 0), 60);
          return;
        }
```

改后：

```ts
        if (nextStable >= 2 || attempt > 20) {
          // 自控时长的快速滚动。动画跑完直接进收敛——以前用原生 smooth，
          // 还要靠「每 60ms 采样、连续三帧 scrollTop 不变」去猜它何时结束，
          // 既拖长了链路，也因为猜不准而多绕一轮收敛。
          const from = scrollEl.scrollTop;
          const delta = top - from;
          const startedAt = performance.now();
          const step = (now: number) => {
            if (interrupted || !isCurrent() || !el.isConnected) { stopWatching(); return; }
            const progress = Math.min(1, (now - startedAt) / JUMP_SCROLL_DURATION_MS);
            scrollEl.scrollTop = from + delta * easeInOutCubic(progress);
            if (progress < 1) { requestAnimationFrame(step); return; }
            converge(0, 0);
          };
          requestAnimationFrame(step);
          return;
        }
```

### 4.1.6 函数签名

```ts
export function useMessageJump({
  scrollContainer,
  resolveMessageElementRef,
  loadOlder,
  loadNewer,
  hasMoreBefore,
  hasMoreAfter,
  railHandleRef,
  notifyBrowsingHistory,
}: MessageJumpOptions): MessageJumpHandle {
```

## 4.2 `hooks/useAgentSession.ts`

### 4.2.1 `loadOlderHistory` 加可选页宽

```ts
  /**
   * 向上（更早）补一页。
   *
   * limitOverride 给「跳转到历史某条」用：那条路径要一路补到目标，跟着懒加载设置走
   * （默认 20 条/页）会补不动。正常分页（「加载更早的历史」按钮）不传，保持设置口径。
   */
  const loadOlderHistory = useCallback(async (limitOverride?: number): Promise<boolean> => {
    ...
      const lazyLoadLimit = sessionLazyLoadLimit(loadSessionLazyLoadSetting());
      // 跳转专用页宽优先；服务端会把 limit 夹到 1..500。
      const pageLimit = limitOverride ?? lazyLoadLimit;
      if (pageLimit !== null) params.set("limit", String(pageLimit));
```

### 4.2.2 return 段

去掉 `jumpToEntry,`（已无调用方）；`hasMoreBefore` 本来就在导出里，未动。

### 4.2.3 中途一次误改（已回退）

`jumpToEntry` 里的 `toEnd` 一度被改成：

```ts
toEnd: options?.toEnd === false ? "0" : "1",
```

配套 deps 也改过。因为该函数已无调用方，两处都**已回退为原样**。
如果后续决定改用「`around` + `toEnd=1`」的备选方案，这里要重新改。

## 4.3 `components/ChatWindow.tsx`

### 4.3.1 `useMessageJump` 传参（约 597 行）

```ts
  const messageJump = useMessageJump({
    scrollContainer: scrollContainerRef,
    resolveMessageElementRef,
    loadOlder: loadOlderHistory,
    loadNewer: loadNewerHistory,
    hasMoreBefore,
    hasMoreAfter,
    railHandleRef,
    notifyBrowsingHistory,
  });
```

### 4.3.2 解构

去掉 `jumpToEntry,`，保留 `loadOlderHistory,` / `loadNewerHistory,` / `hasMoreAfter,`，
新增解构 `hasMoreBefore,`。

## 4.4 门禁与部署（已执行）

| 项 | 结果 |
|---|---|
| `node_modules/.bin/tsc --noEmit` | 通过（无输出） |
| `npm test` | 2775 项 / 2775 通过 / 0 失败 |
| `npx eslint hooks/useMessageJump.ts hooks/useAgentSession.ts components/ChatWindow.tsx` | 44 problems / **0 errors**（全是历史遗留 warning） |
| `node .agents/skills/pidance-development/scripts/local-deploy.mjs restart` | 已部署 31416 |

**改动全部未 commit。**

---

# 5. 实测数据（关键证据）

## 5.1 测试方法

- 目标会话：`01a0f040-b790-718f-8b42-f7cd219528cd`（用户自己的长会话，**只读打开，不占写租约，安全**）
- 脚本：`/tmp/jump-verify3.mjs <sessionId>`
- 流程：登录 → 打开 `?session=<id>` → 读取初始读数 → 点 rail 里第 1 个 button → 等 9s → 再读
- 探针用 `data-message-entry-id` 数消息元素，用 `getBoundingClientRect().top` 相对滚动容器判断位置

## 5.2 逐轮结果

### 第 1 轮（`/tmp/jump-verify.mjs`）—— 无效

```
初始: {"body":"登录 Pidance\n输入服务器密码以继续\n密码\n信任此设备（长期有效，可在设置中删除）\n登录","error":"no scroller"}
```

原因：登录还没完成就切会话；而且 ref 顺序写错（先 fill 后 uncheck）。
**教训**：登录三步必须"先取消信任 → 填密码 → 点登录"，且每步重新取 ref。

### 第 2 轮（修正登录后）—— 无效

```
初始:   {"entryCount":0,"firstLabel":"用户消息导航（点击跳转）","hasLoadNewer":true,"navCount":1,"scrollTop":4120,"scroller":true}
跳转后: {"entryCount":0,"firstNavTop":36,"hasLoadNewer":true,"scrollHeight":4617,"scrollTop":4120}
```

无效原因：`navCount:1` 命中的是**导航条容器本身**（它的 aria-label 也含「用户消息导航」）；
`entryCount:0` 因为用了不存在的 `[data-entry-id]`。

### 第 3 轮（`/tmp/jump-verify2.mjs`，取容器内的 button）—— 有效

```
初始:   {"btnCount":79,"firstBtnTop":-973,
         "labels":["右上角的tps是怎么算的？我用同样的渠道和模型，","当前算工具吗？计算方式和dsh一致吗","好像还是会计算工具调用时间，因为首次思考结束时3"],
         "loadNewerBtn":true,"msgs":0,"rail":true,"scrollHeight":4801,"scrollTop":4304}
点第 1 条后: {"btnCount":79,"loadNewerBtn":true,"msgs":0,"rail":true,"scrollHeight":157641,"scrollTop":157144}
截图: /tmp/jump-after2.png
```

- ✅ 加载生效：`scrollHeight` 4801 → 157641
- ❌ 视口在底部（157144 ≈ 157641 − 视口）
- ❌ 目标没进视口（`firstBtnTop: -973` 是 rail 项在 rail 内的位置，不能作为 DOM 判据）

### 第 4 轮（页宽改 500 之后）

```
初始:   {"btnCount":80,"firstBtnTop":-991,"scrollHeight":4990,"scrollTop":4493}
点第 1 条后: {"btnCount":80,"scrollHeight":254434,"scrollTop":253937}
```

比第 3 轮补得更多，但**结论相同**：仍在底部，仍未定位。

### 第 5 轮（`/tmp/jump-verify3.mjs`，改用 `data-message-entry-id`）—— 判据正确

```
初始:   {"firstMsgText":"此处的逻辑应该是点击消息后，以当前已经加",
         "firstMsgTopVsScroller":-4851,"firstRailLabel":"右上角的tps是怎么算的？我用同样的渠道",
         "lastMsgTopVsScroller":256,"msgs":52,"railBtns":80,
         "scrollHeight":5383,"scrollTop":4886}

点第 1 条: true

跳转后: {"firstMsgText":"","firstMsgTopVsScroller":-254330,
         "lastMsgTopVsScroller":256,"msgs":2352,"railBtns":80,
         "scrollHeight":254827,"scrollTop":254330}
```

## 5.3 结论

| 判据 | 结果 |
|---|---|
| 增量加载是否生效 | ✅ `msgs` 52 → 2352，内容保留，不是换窗 |
| 是否抵达目标 | ❌ rail 第 1 项（会话最早的用户消息）始终不是第一条消息 |
| 视口位置 | ❌ 始终在底部（`scrollTop ≈ scrollHeight − 视口高`） |
| 每页条数 | ❌ 30 页 × 500 应能补 15000 条，实际只补了 2300 条（约 77 条/页） |

**一句话：加载在跑，但既没到目标，也没停住视口。**

---

# 6. 已定位的疑点（未解决）

## 6.1 每页条数不符（最可疑）

传了 `limit=500`，实际约 77 条/页。

要查：

1. `limitOverride` 是否真到了 `loadOlderHistory`
   —— `ChatWindow` 传的是函数引用 `loadOlder: loadOlderHistory`，类型已放宽为
   `(limit?: number) => Promise<boolean>`，理论上直通。**但没有实测验证过
   `pageLimit` 的实际取值**（可以在 `loadOlderHistory` 里临时 `console.error(pageLimit)`，
   或写文件，见 §9.6 的诊断技巧）。
2. 服务端在 `before` 模式下是否还有别的裁剪：
   - `app/api/sessions/[id]/context/route.ts:25-27` 的 `parseContextLimitParam`
   - `lib/session-context-window.ts` 的 `clampLimit`（1..500）与 `sliceContextBefore`
   - `MIN_RAW_WINDOW_SPAN = 200` / `rawWindowSpanCap(budget) = max(200, budget*6)` 这套
     "原始窗口跨度"机制是否在 `before` 模式下额外收窄了结果。

## 6.2 循环可能提前 break

`loadOlderHistory` 开头：

```ts
// hooks/useAgentSession.ts:1742
if (!sid || !hasMoreBeforeRef.current || historyLoadingRef.current) return false;
```

`historyLoadingRef.current = false` 在函数 `finally` 里（**已确认存在**，见下），
但外层循环是**紧跟 `await loadOlder(...)` 就发下一次调用**，仍可能撞上尚未重置的窗口。
一旦返回 `false`，外层 `while` 直接退出，于是只补了几页。

```ts
// loadOlderHistory 尾部结构
      const applied = outcome === "applied";
      if (!applied) return false;
      const more = d.context.hasMoreBefore === true ...;
      hasMoreBeforeRef.current = more;
      return true;
    } catch (e) {
      ...
      return false;
    } finally {
      historyLoadingRef.current = false;
    }
```

**验证方法**：在循环里累计 `pages`，跳转后在页面上把 `pages` 读出来（例如写进
`document.title` 或一个临时 DOM 属性），看是不是远小于 30。

## 6.3 视口始终在底部

`notifyBrowsingHistory()` 之后自动跟随仍在钉底。

相关代码 `hooks/useChatAutoFollow.ts`：

- `:73` `const autoFollowModeRef = useRef<AutoFollowMode>("following");`
- `:170` / `:176` `autoFollowModeRef.current = "following";`（两处重置回 following）
- `:184` 注释："不能用 notifyAutoFollowBranchReset —— 那是「重置回 following 并钉底」"
- `:307` `} else if (autoFollowModeRef.current === "following") {`
- `:309` 注释："否则内容会停在半途（下一次增长才被拉回）。只补钉底，不改成 released/following。"
- `:412` 注释："会看成「高度没变的用户滚动」，占位缩到真实底部时会被吸回 following。"
- `:459` `const isAutoFollowing = useCallback(() => autoFollowModeRef.current === "following", []);`
- `:310` / `:385` / `:393` / `:396` 有 `requestAnimationFrame` 与
  `container.addEventListener("scroll", onScroll, { passive: true })`

**要查的是**：`notifyBrowsingHistory()` 到底改的是哪个状态，为什么 prepend 之后
`autoFollowModeRef.current` 还是 `"following"`。

`notifyBrowsingHistory` 在 `hooks/useAgentSession.ts:1178` 被取出、`:1896` 被调用（原
`jumpToEntry` 里），定义在 `useChatAutoFollow` 那侧。

## 6.4 锚点为何没生效

外层循环里每补一页都调了 `applyAnchorOffset(anchor)`，但实测 `scrollTop` 仍被推到底。
两种可能：

- 锚点本身失效（`captureViewportScrollAnchor` 量到的元素在新窗口里找不到）
- 自动跟随抢在锚点之后把视口钉底（§6.3）

**注意**：`captureAnchor` / `applyAnchorOffset` 原本是为「换窗」场景写的
（在 `useMessageJump` 里包了 `lib/chat-scroll-anchor` 的
`captureViewportScrollAnchor` / `applyViewportScrollAnchor`）。
增量 prepend 场景下锚点的语义略有不同（内容是插在上方而不是整体替换），
是否直接复用需要确认。

---

# 7. 相关文件与行号地图

> 行号是改动**后**的当前工作区状态，改动会使其漂移，必要时用 grep 重新定位。

## 7.1 `hooks/useMessageJump.ts`

| 行 | 内容 |
|---|---|
| 1 | `"use client";` |
| 3–17 | 模块注释：为什么跳转机制单独成 hook |
| 19–22 | import react + `@/lib/chat-scroll-anchor` |
| 23 | `import { easeInOutCubic } from "@/components/MessageNavRail";` |
| 26 | `const JUMP_PIN_WATCHDOG_MS = 5_000;` |
| 28–36 | `JUMP_SCROLL_DURATION_MS` / `JUMP_LOAD_PAGE_LIMIT` / `MAX_JUMP_LOAD_PAGES` 及注释 |
| 38–50 左右 | `MessageJumpOptions`（含 `loadOlder` / `loadNewer` / `hasMoreBefore` / `hasMoreAfter`） |
| 72–75 | `MessageJumpRailHandle` |
| 78–83 | `MessageJumpHandle` |
| 85–95 | `export function useMessageJump({...})` 签名与 state/ref |
| 约 100 | `const jumpTo = useCallback(async (entryId) => {` |
| 内部 | `findTarget` / `isCurrent` |
| 约 108 | `scrollToTarget`（嵌套定义） |
| — | `measure()` |
| — | `interrupted` / `onInterrupt` / `watchInterrupts` / `stopWatching` |
| — | `drift()` / `holdAnchor()` |
| — | `converge(stableCount, attempt)` 最多 12 次 × 100ms |
| — | `settleThenScroll(attempt, last, stable)`（含新的自控缓动） |
| — | `watchInterrupts()`；`instantAtTarget` 分支；`requestAnimationFrame(() => settleThenScroll())` |
| 约 203 | `captureAnchor()` |
| 约 212 | `waitForTarget()`（最多 10 帧 rAF） |
| 约 228 起 | jumpTo 主体（immediate → anchor → 两个 while → waitForTarget → scrollToTarget） |
| 末 | deps `[loadOlder, loadNewer, hasMoreBefore, hasMoreAfter, resolveMessageElementRef, scrollContainer, railHandleRef, notifyBrowsingHistory]` |
| 末 | `return { jumpTo, jumpingTo, jumpPinRef };` |

## 7.2 `hooks/useAgentSession.ts`

| 行 | 内容 |
|---|---|
| 584 左右 | `const [hasMoreBefore, setHasMoreBefore] = useState(false);` |
| 632 | `const hasMoreBeforeRef = useRef(false);` |
| 1178 | 解构出 `notifyBrowsingHistory,` |
| 1358 | `hasMoreBeforeRef.current = false;` |
| 1419–1422 | `const more = d.context.hasMoreBefore === true ...; hasMoreBeforeRef.current = more;` |
| 1740 起 | `const loadOlderHistory = useCallback(async (limitOverride?: number) => {` |
| 1742 | `if (!sid \|\| !hasMoreBeforeRef.current \|\| historyLoadingRef.current) return false;` |
| 1743 | `const before = entryIdsRef.current[0];` |
| 1751 | `params: { deferThinking:"1", deferMedia:"1", before }` |
| 1753–1756 | lazyLoadLimit + **`const pageLimit = limitOverride ?? lazyLoadLimit;`** |
| 1757–1759 | `fetch(...)` |
| 1771 | `if (sessionIdRef.current !== sid) return false;` |
| 1774–1778 | 空结果则 `hasMoreBeforeRef.current = false` |
| 1780–1786 | `registry.hydrate(..., mode: "prepend")` |
| 1787 起 | `if (!applied) return false;` → 更新 `hasMoreBeforeRef` → `return true` |
| 尾部 | `catch { return false }` / `finally { historyLoadingRef.current = false; }` |
| ~1870 起 | `const jumpToEntry = useCallback(async (entryId, options) => {`（**已无调用方**） |
| ~1887–1894 | 其中 `around` + `toEnd` 的 params（**已回退为原样**） |
| ~1948 | `jumpToEntry` 的 deps `[agentRunning, beginLoadRequest, notifyBrowsingHistory]` |
| ~1947 起 | `const loadNewerHistory = useCallback(async () => {` |
| ~4978–4993 | return 段（`loadOlderHistory` / `loadNewerHistory` / `hasMoreBefore` / `hasMoreAfter`；`jumpToEntry` 已删） |

## 7.3 `components/ChatWindow.tsx`

| 行 | 内容 |
|---|---|
| 45 | `import { MessageNavRail } from "./MessageNavRail";` |
| 57 | 注释：消息列左右边距由两侧竖条（各 `CHAT_GUTTER` px） |
| 236–246 | `useAgentSession` 的解构（含 `loadOlderHistory` / `loadNewerHistory` / `hasMoreAfter` / `hasMoreBefore`） |
| 597 起 | `const messageJump = useMessageJump({...})` |
| 609 | 注释：等 `loading` 落下再跳 |
| 617 / 620 | `jumpToRef` 的初始化与每帧赋值 |
| 685 / 687 / 1241 | `isAtLiveTail: !hasMoreAfter` |
| 1217 | 注释：左侧用户消息导航条是绝对定位覆盖层，不参与布局 |
| 1230 起 | `<MessageNavRail ... />` |
| 1237 / 1238 | `jumpTo={messageJump.jumpTo}` / `jumpingTo={messageJump.jumpingTo}` |
| **1361** | **`data-message-entry-id={!isLive && item.attachRef ? entryIds[idx] : undefined}`** ← 消息元素的真实属性 |
| 1401 | `{hasMoreAfter && (` ←「加载更新的历史」按钮 |
| 1402–1420 | 该按钮本体：`onClick={() => void loadNewerHistory()}`，`disabled={historyLoading}`，label `t("chat_loadNewer")` |
| 1395–1400 | `runPhaseNotice`（相邻的另一个状态行） |

## 7.4 `components/MessageNavRail.tsx`

| 行 | 内容 |
|---|---|
| 4 | 文件头注释：对齐 codex app 的左侧用户消息导航 |
| 42 | `jumpTo` 的 prop 类型声明 |
| 72 | `export function MessageNavRail({` |
| 77 | 解构 `jumpTo,` |
| 129 / 334 | `scrollTop: list.scrollTop` |
| 192 | `scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight`（是否到底） |
| 201 | 注释：jumpTo 是异步流程，等待期间时间线会被换成新窗口并重渲染 |
| 225–227 | `cancelRailTween()` / `railTweenTargetRef.current = null` |
| 230–253 | `scrollRailTo`：自控时长 + `easeInOutCubic` |
| 366 | 注释：不在列表 scroll 事件里重居中 |
| 421 | hover 预览：`void jumpTo(item.entryId);` |
| 511 | `aria-label={messageNavPreview(item.text) \|\| t("nav_userMessages")}` |
| 514 | `onClick={() => void jumpTo(item.entryId)}` ← **导航项的点击入口** |
| 606 | `export function messageNavPreview(text, maxLength = 120)` |
| 620–629 | `export function easeInOutCubic(t)` |
| 632 | `export const RAIL_SCROLL_DURATION_MS = 420;` |
| 638–645 | `export function railScrollBehavior(input, smallDeltaPx = 24)` |
| 659 / 665 / 689–695 | 轨道上下指示与自身居中 |

## 7.5 服务端

`app/api/sessions/[id]/context/route.ts`

| 行 | 内容 |
|---|---|
| 16 | `const before = url.searchParams.get("before") ?? undefined;` |
| 17–18 | 注释 + `const around = url.searchParams.get("around") ?? undefined;` |
| 19–20 | 注释 + `const after = url.searchParams.get("after") ?? undefined;` |
| 22 | `const aroundToEnd = url.searchParams.get("toEnd") !== "0";` |
| 25–27 | `const limit = parseContextLimitParam(params, before \|\| around \|\| after ? DEFAULT_SESSION_HISTORY_PAGE : DEFAULT_SESSION_TAIL_LIMIT)` |
| 33–37 | 把 `before/around/after/aroundToEnd/limit` 传给 service |

`lib/session-context-window.ts`（常量与切片）

- `DEFAULT_SESSION_TAIL_LIMIT = 100`
- `DEFAULT_SESSION_HISTORY_PAGE = 100`
- `DEFAULT_TURN_ALIGN_MAX_EXTEND = 100`
- `clampLimit`：把 limit 夹到 1..500
- `parseContextLimitParam`：读 `limit` 或 `tail`；缺省/空 → null（不切片）
- `MIN_RAW_WINDOW_SPAN = 200`，`rawWindowSpanCap(budget) = max(200, budget*6)`
- `sliceContextTail` / `sliceContextAround` / `sliceContextAfter` / `sliceContextBefore`
- `countsTowardWindow`：除 `role === "toolResult"` 外都算窗口预算（toolResult 跟着工具卡走）
- `DEFAULT_COMPACTION_RESERVE_TOKENS = 16384`

`hooks/useChatAutoFollow.ts` —— 见 §6.3。

---

# 8. 环境、命令与工具

## 8.1 端口与实例

| 端口 | 角色 | 允许操作 |
|---|---|---|
| **31416** | 工作区持续测试实例 | ✅ 全部测试都在这里 |
| 31415 | Windows 稳定安装版 | ❌ **永不操作** |
| — | 上游服务 | ❌ 永不操作 |

## 8.2 常用命令

```bash
cd /home/moss/works/open/pidance

# 门禁
node_modules/.bin/tsc --noEmit
npm run lint
npm test                     # 2775 项
npm run check                # typecheck && lint && test

# 部署到 31416（改过应用代码就必须跑）
node .agents/skills/pidance-development/scripts/local-deploy.mjs restart

# 改了 CSS 需要先清构建产物（否则会发出陈旧 CSS）
rm -rf .next-public && node .agents/skills/pidance-development/scripts/local-deploy.mjs restart
```

## 8.3 登录凭据

```bash
PID=$(pgrep -f 'bin/pidance.js -p 31416' | head -1)
tr '\0' '\n' < /proc/$PID/environ \
  | grep -E '^(PIDANCE_PASSWORD|PI_WEB_PASSWORD)='
```

Basic 用户名固定为 `pi`，即 `Authorization: Basic base64("pi:<password>")`。

## 8.4 浏览器自动化

- 路径：`/home/moss/.nvm/versions/node/v24.18.0/bin/agent-browser`
  （通常不在 PATH 里，`which agent-browser` 会失败）
- **每条命令都必须显式带 `--session <名字>`**：默认的匿名 session 是机器级共享的，
  会跨对话串味
- `agent-browser --json <cmd>` 的返回是 `{ data: ... }` 信封
- `snapshot --json` 的 `data.refs` 是一个**对象**（键是 `e1`/`e2` 这样的 ref），不是数组

## 8.5 验证脚本

| 脚本 | 用途 |
|---|---|
| `/tmp/jump-verify.mjs <sid>` | 第一版（登录顺序错，已废弃） |
| `/tmp/jump-verify2.mjs <sid>` | 用 rail 容器内的 button；读数含 `btnCount` / `loadNewerBtn` / `scrollTop` |
| `/tmp/jump-verify3.mjs <sid>` | **当前可用版本**：用 `data-message-entry-id` 数消息，读数含 `msgs` / `firstMsgTopVsScroller` / `firstRailLabel` |

输出截图：`/tmp/jump-after.png`、`/tmp/jump-after2.png`、`/tmp/jump-after3.png`

## 8.6 31416 的日志位置

`local-deploy.mjs` 起的持久守护进程，stdout 与 stderr 都指向：

```
/var/log/pidance-local-31416-1000.service.log
```

**不是** `journalctl --user`，**不是** `/tmp`。
运行时目录 `/tmp/pidance-local-31416-1000/` 里只有 0 字节的 `next.log` 和 `state.json`。

---

# 9. 陷阱（本项目踩过的，务必先读）

## 9.1 编辑代码

- **CRLF**：项目里的 `.ts` / `.tsx` 多是 CRLF。用字节级读写保留行尾，
  例如 `p.write_bytes(t.replace("\n", "\r\n").encode("utf8"))`。
- **python 补丁脚本的原子性**：推荐"先把所有锚点断言过一遍，最后才 `write_bytes`"。
  这样中途失败文件保持字节不变。
  但要注意：**同一个 heredoc 里前面的 `t = t.replace(...)` 已经改在内存里了**，
  断言失败不写盘 —— 所以会出现"以为改了其实没写"的情况。每次失败后要重新读文件确认。
- **锚点匹配失败的常见原因**：字符串里有不可见的空格/缩进差异。
  解决顺序：① 用 `grep -n` 定位行号 ② 用 `re.compile` 数命中数
  ③ 用 `t.index(old, start)` 取**指定范围后的第一次出现** ④ 实在不行按行号改。
  本次就踩过：同一段字符串全文件命中 3 处；按函数范围切片后仍 2 处；
  最后用 `t.index(old, start)` 才成功。
- **不要用大范围的字符串替换改 JSX**：曾经用脚本搬一段 300 多行的 JSX，结果是
  `TS17008 JSX element 'fieldset' has no corresponding closing tag` 加一串解析错误，
  只能整体回滚。大块 JSX 搬迁要手工做。

## 9.2 部署

- **`local-deploy.mjs` 在 `tsc` 失败时照样部署旧构建**。任何时候看到它"部署成功"，
  都要先确认 `tsc` 的 rc 是 0，否则你测的是旧代码。
- 改 **CSS** 后 `Turbopack` 可能发出**陈旧 CSS**（chunk 里还是删掉的旧规则）。
  必须 `rm -rf .next-public` 再 restart（约 30s）。
- 只改 `.test.mjs` 不需要重新部署（测试文件不进构建）。

## 9.3 浏览器 QA

- 登录顺序（重要）：
  1. 打开 `http://127.0.0.1:31416/`
  2. **先取消**「信任此设备」复选框（否则留下 10 年设备记录）
  3. 填密码
  4. 点 **name 精确等于「登录」** 的 button（不要用模糊匹配，会撞到页面标题「登录 Pidance」）
  - 每一步都要**重新取 ref**，ref 会失效
- 打开指定会话要**登录之后**再 `open ?session=<id>`：先带参数再登录，登录完参数会丢
- **导航条容器本身**也带含「用户消息导航」的 aria-label，要取它内部的 `button`
- 消息元素的属性是 **`data-message-entry-id`**，不是 `data-entry-id`
- **一次探针读数为 0 往往说明"探针装错了/页面没渲染"，而不是"没问题"**。
  每次采样前先断言页面真的渲染了（有 `[data-chat-scroller]`、有消息元素）

## 9.4 认证

- 部署后**立刻**读密码会撞 401 或 429（`{"error":"Too many failed attempts","locked":true}`，
  共享退避桶）。等 45s 以上，再**单次**尝试。
- 密码变量名有两个：`PIDANCE_PASSWORD`（新）与 `PI_WEB_PASSWORD`（旧），要都试。
- 读 `/proc/<pid>/environ` 时 pid 要**动态取**（`pgrep`），进程会重启。

## 9.5 测试会话卫生

- 测试要**自己新建带标记的会话**，用完删掉。
- 删除用 `DELETE /api/sessions/<id>`（Basic 认证），**按明确记录的 id 逐个删**，
  加 `timeout` / `curl -m` 保护，删完 `GET` 确认 404。
- **绝对不要**用内容 grep 去 `~/.pi/agent/sessions/` 找测试会话：
  **本对话自身的文本会污染匹配**（曾经因为 `grep -rl "DELTEST"` 命中用户正在使用的会话，
  对用户自己的会话发出了 DELETE）。
- 打开历史会话是**只读**的，不占写租约，可以用来做只读验证（本次实测就是这么做的）。

## 9.6 诊断技巧

- 从探针里看不到 `console.error` 时，改成写文件：
  ```js
  try {
    const { appendFileSync } = require("node:fs");
    appendFileSync("/tmp/<name>.log", JSON.stringify({...}) + "\n");
  } catch {}
  ```
- 探针脚本（`/tmp/*.mjs`）**不要用脆弱的字符串替换去改**，容易把脚本改坏、
  丢掉本轮唯一的自动化证据。要改就整份重写。
- `.mjs` 里不能用 `require("node:fs")`，要用 `import`（会报
  `ERR_AMBIGUOUS_MODULE_SYNTAX`）。

---

# 10. 下一步（按优先级）

## 10.1 必须做的事

1. **查清每页实际条数为什么不是 500**（§6.1）
   - 在 `loadOlderHistory` 里临时把 `pageLimit` 写到文件，确认取值
   - 如果 `pageLimit` 确实是 500，则去查服务端 `sliceContextBefore` 是否按
     `MIN_RAW_WINDOW_SPAN` / `rawWindowSpanCap` 额外收窄

2. **修循环提前退出**（§6.2）
   - 方案 A：在 `loadOlderHistory` 开头把 `historyLoadingRef` 的守卫放宽，
     或让跳转路径走一条不受该守卫影响的调用
   - 方案 B：把累计页数暴露出来，确认到底跑了几页再决定

3. **修视口被钉底**（§6.3）
   - 查 `notifyBrowsingHistory` 与 `autoFollowModeRef` 的关系
   - 确认 prepend 时自动跟随是否应该被 browsing 态挡住

4. **目标进 DOM 后滚到目标并复测**
   - 用 `/tmp/jump-verify3.mjs 01a0f040-b790-718f-8b42-f7cd219528cd` 对比前后
   - 期望：`msgs` 增加、`firstRailLabel` 那条出现在视口内、`scrollTop` 落在目标附近

5. **提交**（当前所有改动都在工作区，未 commit）

## 10.2 备选方案（若增量补页在超长会话上始终低效）

退回「换窗」，但补上 `toEnd`：

```
around=<entryId> + toEnd=1   →   窗口 = [目标前半页, 最新]
```

一次请求同时满足 R4（目标之后不折叠）和"能定位到目标"，**代价是丢掉当前窗口内容**，
与用户 R1（"以当前已经加载的消息为准"）冲突。**采用前必须跟用户确认。**

改动位置：`hooks/useAgentSession.ts` 的 `jumpToEntry` 里的 `toEnd` 那一行
（本次会话里改过又回退了，改法与回退方法见 §4.2.3）。

## 10.3 还有一个未验证的假设

`MAX_JUMP_LOAD_PAGES = 30` 这个上限本身是否够用，取决于"每页到底多少条"。
如果每页确实是 500，30 页 = 15000 条，足够任何会话；
如果每页实际只有 77 条，30 页 = 2310 条 —— **正好接近实测的 2300 条**，
这反过来支持"循环确实跑满了 30 页，但每页只有 77 条"这一判断。

**这是当前最值得先验证的一条**：跑满 30 页 × 77 条 = 2310，与实测 2352 − 52 = 2300 高度吻合。
如果成立，那么问题不在循环退出，而在**每页条数**（§6.1），
修好页宽后这个方案可能直接就能用。

---

# 11. 附录：本次会话的改动文件清单

```
 M components/ChatWindow.tsx
 M hooks/useAgentSession.ts
 M hooks/useMessageJump.ts
```

全部未提交。`git status --porcelain` 可确认。
