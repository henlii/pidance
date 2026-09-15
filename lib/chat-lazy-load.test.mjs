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


// ---------------------------------------------------------------------------
// Bug：打开旧会话/刚结束的会话，首次向上滚动跳过很大一段
// 补偿必须发生在「头部变老」（prepend）时；尾部追加同样改变 scrollHeight，
// 但它位于视口下方，套用同一补偿会把视口错误下移。
// ---------------------------------------------------------------------------

test("prepend 补偿只在头部变老时进行（尾部追加不补偿）", async () => {
  const { shouldCompensatePrepend } = await loadSubject();
  // 哨兵命中并捕获快照，头部换成更旧的 entry → 补偿
  assert.equal(
    shouldCompensatePrepend({
      savedDistance: 120,
      headEntryId: "old-head",
      compensatedHeadEntryId: "newer-head",
    }),
    true,
  );
  // 尾部追加（流式/新消息）：头部不变 → 不得补偿
  assert.equal(
    shouldCompensatePrepend({
      savedDistance: 120,
      headEntryId: "same-head",
      compensatedHeadEntryId: "same-head",
    }),
    false,
  );
});

test("prepend 补偿：无快照或头部未知时不补偿（避免套用陈旧距离）", async () => {
  const { shouldCompensatePrepend } = await loadSubject();
  assert.equal(
    shouldCompensatePrepend({ savedDistance: null, headEntryId: "a", compensatedHeadEntryId: null }),
    false,
  );
  assert.equal(
    shouldCompensatePrepend({ savedDistance: 120, headEntryId: null, compensatedHeadEntryId: null }),
    false,
  );
  // 首次 prepend：尚未补偿过任何头部
  assert.equal(
    shouldCompensatePrepend({ savedDistance: 120, headEntryId: "a", compensatedHeadEntryId: null }),
    true,
  );
});

test("captureScrollDistance / restoreScrollTop 互逆（补偿的数学前提）", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  const saved = captureScrollDistance(1000, 400); // 距底 600
  // 上方插入 300px 内容后：scrollTop 应前移同样的 300px，视口内容不变
  assert.equal(restoreScrollTop(1300, saved), 700);
});
