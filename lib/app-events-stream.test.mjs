/**
 * app-events-stream（#91）：pagehide 让出连接后，bfcache 恢复必须重建。
 *
 * 回归点：pagehide 关掉的是底层 EventSource，而本模块持有的引用还在 —— 若恢复时用
 * 「source 为空」当判据，就永远不会重建，运行集/偏好变更会**静默停更**。
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.closedCount = 0;
    this.onmessage = null;
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closedCount += 1;
    this.readyState = 2;
  }
  emit(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

globalThis.EventSource = FakeEventSource;

const { appEventsConnected, subscribeAppEvents } = await jiti.import("./app-events-stream.ts");
const { handlePageHide, handlePageShow } = await jiti.import("./live-event-sources.ts");

const last = () => FakeEventSource.instances.at(-1);

test("订阅即建立连接，且用的是同一个 URL", () => {
  FakeEventSource.instances.length = 0;
  const received = [];
  const unsubscribe = subscribeAppEvents((payload) => received.push(payload));
  assert.equal(FakeEventSource.instances.length, 1);
  assert.equal(last().url, "/api/agent/running/events");
  assert.equal(appEventsConnected(), true);
  last().emit({ type: "running", runningSessionIds: ["a"] });
  assert.deepEqual(received, [{ type: "running", runningSessionIds: ["a"] }]);
  unsubscribe();
  assert.equal(appEventsConnected(), false, "最后一个订阅者退订后应关闭连接");
});

test("pagehide 关连接、pageshow(persisted) 必须重建（否则运行集静默停更）", () => {
  FakeEventSource.instances.length = 0;
  const received = [];
  const unsubscribe = subscribeAppEvents((payload) => received.push(payload));
  const first = last();
  assert.equal(FakeEventSource.instances.length, 1);

  handlePageHide();
  assert.equal(first.closedCount, 1, "pagehide 必须让出这条同源连接");
  assert.equal(first.readyState, 2);

  handlePageShow(true);
  assert.equal(FakeEventSource.instances.length, 2, "bfcache 恢复后应重建一条新连接");
  const second = last();
  assert.notEqual(second, first);
  second.emit({ type: "running", runningSessionIds: ["b"] });
  assert.deepEqual(received.at(-1), { type: "running", runningSessionIds: ["b"] }, "重建后的连接要真的送达事件");

  unsubscribe();
  assert.equal(appEventsConnected(), false);
});

test("pageshow(false)（全新加载）不重建；没有订阅者时也不重建", () => {
  FakeEventSource.instances.length = 0;
  // 没有订阅者：pagehide/pageshow 都不该凭空建连接
  handlePageHide();
  handlePageShow(true);
  assert.equal(FakeEventSource.instances.length, 0);

  const unsubscribe = subscribeAppEvents(() => {});
  assert.equal(FakeEventSource.instances.length, 1);
  handlePageHide();
  unsubscribe();
  handlePageShow(true);
  assert.equal(FakeEventSource.instances.length, 1, "已退订的流不该被恢复");
});

test("重新订阅后仍能工作（恢复路径与首个订阅者互不干扰）", () => {
  FakeEventSource.instances.length = 0;
  const first = subscribeAppEvents(() => {});
  first();
  const seen = [];
  const unsubscribe = subscribeAppEvents((payload) => seen.push(payload));
  assert.equal(FakeEventSource.instances.length, 2, "退订后再订阅应新建连接");
  last().emit({ type: "prefs", revision: 3 });
  assert.deepEqual(seen, [{ type: "prefs", revision: 3 }]);
  unsubscribe();
});

after(() => {
  delete globalThis.EventSource;
});
