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


test("哨兵：本地到头但服务端仍有更旧时仍显示（避免二次上滚无法加载）", async () => {
  const { shouldShowHistorySentinel, resolveHistoryLoadAction } = await loadSubject();
  assert.equal(shouldShowHistorySentinel(false, true), true);
  assert.equal(shouldShowHistorySentinel(true, false), true);
  assert.equal(shouldShowHistorySentinel(false, false), false);

  assert.equal(
    resolveHistoryLoadAction({
      visibleCount: 160,
      messagesLength: 160,
      hasMoreBefore: true,
      historyLoading: false,
    }),
    "load-server",
  );
  assert.equal(
    resolveHistoryLoadAction({
      visibleCount: 50,
      messagesLength: 160,
      hasMoreBefore: true,
      historyLoading: false,
    }),
    "expand-local",
  );
  assert.equal(
    resolveHistoryLoadAction({
      visibleCount: 160,
      messagesLength: 160,
      hasMoreBefore: true,
      historyLoading: true,
    }),
    "none",
  );
  assert.equal(
    resolveHistoryLoadAction({
      visibleCount: 200,
      messagesLength: 160,
      hasMoreBefore: false,
      historyLoading: false,
    }),
    "none",
  );
});
