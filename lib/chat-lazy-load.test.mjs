import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./chat-lazy-load.ts");
}

test("shows only the last visible render items", async () => {
  const { getVisibleRenderWindow } = await loadSubject();
  assert.deepEqual(getVisibleRenderWindow(200, 50), { startIndex: 150, hasMore: true });
});

test("shows all render items when the visible count reaches the total", async () => {
  const { getVisibleRenderWindow } = await loadSubject();
  assert.deepEqual(getVisibleRenderWindow(30, 50), { startIndex: 0, hasMore: false });
  assert.deepEqual(getVisibleRenderWindow(50, 50), { startIndex: 0, hasMore: false });
  assert.deepEqual(getVisibleRenderWindow(0, 50), { startIndex: 0, hasMore: false });
});

test("continues paging when render items outnumber source messages", async () => {
  const { getNextVisibleCount, getVisibleRenderWindow } = await loadSubject();
  let visibleCount = 50;

  visibleCount = getNextVisibleCount(visibleCount);
  assert.deepEqual(getVisibleRenderWindow(120, visibleCount), { startIndex: 20, hasMore: true });

  visibleCount = getNextVisibleCount(visibleCount);
  assert.deepEqual(getVisibleRenderWindow(120, visibleCount), { startIndex: 0, hasMore: false });
});

test("尾部追加时增大 visibleCount，避免 startIndex 前移卸载更早消息", async () => {
  const { growVisibleCountOnAppend, getVisibleRenderWindow } = await loadSubject();

  // 固定 50 窗口：total 50→55 会把 startIndex 从 0 推到 5，卸载前 5 条
  assert.deepEqual(getVisibleRenderWindow(55, 50), { startIndex: 5, hasMore: true });

  // 同步增大窗口后 startIndex 仍为 0，历史仍挂载
  const grown = growVisibleCountOnAppend(50, 50, 55);
  assert.equal(grown, 55);
  assert.deepEqual(getVisibleRenderWindow(55, grown), { startIndex: 0, hasMore: false });

  // 已在中部窗口时：total 100→103、visible 50 → visible 53，startIndex 保持 50
  const mid = growVisibleCountOnAppend(50, 100, 103);
  assert.equal(mid, 53);
  assert.deepEqual(getVisibleRenderWindow(103, mid), { startIndex: 50, hasMore: true });

  // 缩减或不变不改 visibleCount
  assert.equal(growVisibleCountOnAppend(80, 100, 90), 80);
  assert.equal(growVisibleCountOnAppend(80, 100, 100), 80);
});

test("计划缩短时收 visibleCount，避免 startIndex 前移挂上更早内容", async () => {
  const { shrinkVisibleCountOnPlanShrink, getVisibleRenderWindow } = await loadSubject();

  // 中部窗口：total 100→90、visible 80。不收窗口则 startIndex 20→10，更早 10 项进视口上方
  assert.deepEqual(getVisibleRenderWindow(100, 80), { startIndex: 20, hasMore: true });
  assert.deepEqual(getVisibleRenderWindow(90, 80), { startIndex: 10, hasMore: true });
  const shrunk = shrinkVisibleCountOnPlanShrink(80, 100, 90);
  assert.equal(shrunk, 70);
  assert.deepEqual(getVisibleRenderWindow(90, shrunk), { startIndex: 20, hasMore: true });

  // 已显示全部：startIndex 保持 0，窗口收到新 total
  assert.equal(shrinkVisibleCountOnPlanShrink(80, 24, 3), 3);
  assert.deepEqual(getVisibleRenderWindow(3, 3), { startIndex: 0, hasMore: false });

  // 缩短到比原 startIndex 还短：只能从 0 显示全部
  assert.equal(shrinkVisibleCountOnPlanShrink(80, 100, 10), 10);
  assert.deepEqual(getVisibleRenderWindow(10, 10), { startIndex: 0, hasMore: false });

  // 增长或不变不改
  assert.equal(shrinkVisibleCountOnPlanShrink(80, 100, 110), 80);
  assert.equal(shrinkVisibleCountOnPlanShrink(80, 100, 100), 80);
});

test("计划增长（prepend 或 append）都按增量补 visibleCount，保持 startIndex", async () => {
  const { growVisibleCountOnAppend, getVisibleRenderWindow } = await loadSubject();
  // 已显示全部 40 项时 prepend 80：visible 50→130，startIndex 仍为 0
  const grown = growVisibleCountOnAppend(50, 40, 120);
  assert.equal(grown, 130);
  assert.deepEqual(getVisibleRenderWindow(120, grown), { startIndex: 0, hasMore: false });
  // 流式尾项身份可以一直是 live：只看数量增量
  const streamed = growVisibleCountOnAppend(50, 40, 41);
  assert.equal(streamed, 51);
  assert.deepEqual(getVisibleRenderWindow(41, streamed), { startIndex: 0, hasMore: false });
});

test("restores the viewport after prepending content", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  const savedDistance = captureScrollDistance(2000, 500);

  assert.equal(savedDistance, 1500);
  assert.equal(restoreScrollTop(2500, savedDistance), 1000);
});

test("restores top and bottom boundary positions", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  assert.equal(restoreScrollTop(3000, captureScrollDistance(2000, 0)), 1000);
  assert.equal(restoreScrollTop(3000, captureScrollDistance(2000, 2000)), 3000);
});

test("哨兵：按计划窗口 localHasMore，不和消息条数比", async () => {
  const { shouldShowHistorySentinel, resolveHistoryLoadAction, getVisibleRenderWindow } = await loadSubject();
  assert.equal(shouldShowHistorySentinel(false, true), true);
  assert.equal(shouldShowHistorySentinel(true, false), true);
  assert.equal(shouldShowHistorySentinel(false, false), false);

  assert.equal(
    resolveHistoryLoadAction({
      localHasMore: false,
      hasMoreBefore: true,
      historyLoading: false,
    }),
    "load-server",
  );
  assert.equal(
    resolveHistoryLoadAction({
      localHasMore: true,
      hasMoreBefore: true,
      historyLoading: false,
    }),
    "expand-local",
  );
  assert.equal(
    resolveHistoryLoadAction({
      localHasMore: false,
      hasMoreBefore: true,
      historyLoading: true,
    }),
    "none",
  );
  assert.equal(
    resolveHistoryLoadAction({
      localHasMore: false,
      hasMoreBefore: false,
      historyLoading: false,
    }),
    "none",
  );

  // 后台跑完的长会话：80 条消息合成 12 个计划项，首屏 50 已盖住全部计划
  // 旧逻辑用 visibleCount < messages.length 会空扩一次本地窗口并吃掉补偿快照
  const planWindow = getVisibleRenderWindow(12, 50);
  assert.equal(planWindow.hasMore, false);
  assert.equal(
    resolveHistoryLoadAction({
      localHasMore: planWindow.hasMore,
      hasMoreBefore: true,
      historyLoading: false,
    }),
    "load-server",
  );
});

test("captureScrollDistance / restoreScrollTop 互逆（补偿的数学前提）", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  const saved = captureScrollDistance(1000, 400); // 距底 600
  // 上方插入 300px 内容后：scrollTop 应前移同样的 300px，视口内容不变
  assert.equal(restoreScrollTop(1300, saved), 700);
});
