/**
 * live-event-sources（#91）：pagehide 让出连接、pageshow 恢复通知。
 *
 * 这些断言对应 issue 的现场证据：进 bfcache 的旧文档会继续占着同源连接，把新文档的
 * 普通请求饿住（`/api/sessions` duration 恰好等于自己的 10s 超时、transferSize 0）。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  closeAllLiveEventSources,
  closeTrackedEventSource,
  handlePageHide,
  handlePageShow,
  liveEventSourceCount,
  resetLiveEventSourcesForTests,
  subscribeLiveStreamRestore,
  trackLiveEventSource,
} = await jiti.import("./live-event-sources.ts");

function fakeSource(options = {}) {
  let closed = 0;
  return {
    readyState: 1,
    close() {
      closed += 1;
      this.readyState = 2;
      if (options.throwOnClose) throw new Error("close failed");
    },
    closedCount: () => closed,
  };
}

beforeEach(() => {
  resetLiveEventSourcesForTests();
});

test("登记与注销：计数反映当前登记的连接", () => {
  const a = fakeSource();
  const b = fakeSource();
  const untrackA = trackLiveEventSource(a);
  trackLiveEventSource(b);
  assert.equal(liveEventSourceCount(), 2);
  untrackA();
  assert.equal(liveEventSourceCount(), 1);
  untrackA(); // 幂等
  assert.equal(liveEventSourceCount(), 1);
});

test("pagehide：关闭所有已登记连接并清空登记（各关一次）", () => {
  const a = fakeSource();
  const b = fakeSource();
  trackLiveEventSource(a);
  trackLiveEventSource(b);
  handlePageHide();
  assert.equal(a.closedCount(), 1);
  assert.equal(b.closedCount(), 1);
  assert.equal(a.readyState, 2);
  assert.equal(liveEventSourceCount(), 0);
  // 再关一次不应该重复关闭（登记表已空）
  handlePageHide();
  assert.equal(a.closedCount(), 1);
});

test("单条 close 抛错不影响其它连接，且登记表仍被清空", () => {
  const bad = fakeSource({ throwOnClose: true });
  const good = fakeSource();
  trackLiveEventSource(bad);
  trackLiveEventSource(good);
  assert.equal(closeAllLiveEventSources(), 2);
  assert.equal(good.closedCount(), 1);
  assert.equal(liveEventSourceCount(), 0);
});

test("pageshow：persisted 才通知恢复；非 persisted（全新加载）不通知", () => {
  let restored = 0;
  subscribeLiveStreamRestore(() => {
    restored += 1;
  });
  handlePageShow(false);
  assert.equal(restored, 0);
  handlePageShow(true);
  assert.equal(restored, 1);
});

test("恢复回调退订后不再被通知", () => {
  let restored = 0;
  const unsubscribe = subscribeLiveStreamRestore(() => {
    restored += 1;
  });
  unsubscribe();
  handlePageShow(true);
  assert.equal(restored, 0);
});

test("一个恢复回调抛错不影响其它回调", () => {
  let second = 0;
  subscribeLiveStreamRestore(() => {
    throw new Error("boom");
  });
  subscribeLiveStreamRestore(() => {
    second += 1;
  });
  handlePageShow(true);
  assert.equal(second, 1);
});

test("closeTrackedEventSource：关闭并注销，可重复调用", () => {
  const source = fakeSource();
  trackLiveEventSource(source);
  closeTrackedEventSource(source);
  assert.equal(source.closedCount(), 1);
  assert.equal(liveEventSourceCount(), 0);
  closeTrackedEventSource(source);
  assert.equal(source.closedCount(), 2);
  assert.equal(liveEventSourceCount(), 0);
});

test("pagehide 与「所有者自己 close」互不干扰：登记后自己关掉的条目不会再被关一次", () => {
  const mine = fakeSource();
  const other = fakeSource();
  trackLiveEventSource(mine);
  trackLiveEventSource(other);
  closeTrackedEventSource(mine);
  handlePageHide();
  assert.equal(mine.closedCount(), 1, "自己关过的那条不该在 pagehide 里再关一次");
  assert.equal(other.closedCount(), 1);
});
