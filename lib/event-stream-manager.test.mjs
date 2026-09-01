import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createEventStreamManager,
  EventStreamConnectionError,
} = await jiti.import("./event-stream-manager.ts");

const CLOSED = 2;
const OPEN = 1;

// 极简假 EventSource：用 readyState + onmessage/onerror 模拟浏览器行为。
function createFakeSource() {
  const handlers = {
    onmessage: null,
    onerror: null,
  };
  const source = {
    readyState: CONNECTING_FAKE(),
    closecalled: false,
    close() { this.closecalled = true; },
    onmessage: null,
    onerror: null,
    // 触发器：测试代码主动调用以模仿服务器送达一帧。
    emit(data) { this.onmessage?.({ data: JSON.stringify(data) }); },
    emitError(readyStateAfter) { this.readyState = readyStateAfter; this.onerror?.(); },
  };
  Object.defineProperty(source, "onmessage", {
    get: () => handlers.onmessage,
    set: (v) => { handlers.onmessage = v; },
    configurable: true,
  });
  Object.defineProperty(source, "onerror", {
    get: () => handlers.onerror,
    set: (v) => { handlers.onerror = v; },
    configurable: true,
  });
  return source;
}

function CONNECTING_FAKE() { return 0; }

function fakeTimers() {
  const queue = [];
  let next = 1;
  const handles = new Map();
  return {
    schedule(fn, ms) {
      const id = next++;
      handles.set(id, { fn, ms });
      queue.push(id);
      return id;
    },
    clear(id) {
      handles.delete(id);
    },
    // 推进时间：触发所有 <= ms 的定时器；这里我们提供 flush 模式，按 ms 升序执行。
    flush() {
      const entries = [...handles.entries()].sort((a, b) => a[1].ms - b[1].ms);
      for (const [id, { fn }] of entries) {
        handles.delete(id);
        fn();
      }
    },
    pending() { return handles.size; },
    pendingMsList() { return [...handles.values()].map((h) => h.ms); },
  };
}

function fakeFrames() {
  let next = 1;
  const handles = new Map();
  return {
    schedule(fn) {
      const id = next++;
      handles.set(id, fn);
      return id;
    },
    cancel(id) {
      handles.delete(id);
    },
    flush() {
      const callbacks = [...handles.values()];
      handles.clear();
      callbacks.forEach((fn) => fn());
    },
    pending() { return handles.size; },
  };
}

test("connect 收到 connected 帧后以 connected 状态 resolve", async () => {
  const source = createFakeSource();
  const timers = fakeTimers();
  const manager = createEventStreamManager({
    createEventSource: () => source,
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    connectTimeoutMs: 5_000,
  });

  const promise = manager.connect("s1", () => {});
  // 模拟服务器送达 connected 帧。
  source.readyState = OPEN;
  source.emit({ type: "connected" });

  const result = await promise;
  assert.equal(result.status, "connected");
  assert.equal(result.source, source);
  assert.equal(timers.pending(), 0, "成功后连接超时定时器应被清除");
});

test("connect 超时未收到 connected 帧时以 timeout 状态 resolve", async () => {
  const source = createFakeSource();
  const timers = fakeTimers();
  const manager = createEventStreamManager({
    createEventSource: () => source,
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    connectTimeoutMs: 1_000,
  });

  const promise = manager.connect("s1", () => {});
  // 不送达任何帧，直接走超时路径。
  timers.flush();

  const result = await promise;
  assert.equal(result.status, "timeout");
  assert.equal(result.source, source);
});

test("ensureConnected 在超时情况下抛出 EventStreamConnectionError", async () => {
  const source = createFakeSource();
  const timers = fakeTimers();
  const manager = createEventStreamManager({
    createEventSource: () => source,
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    connectTimeoutMs: 500,
  });

  const promise = manager.ensureConnected("s1", () => {});
  timers.flush();

  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof EventStreamConnectionError, "应是 EventStreamConnectionError 实例");
    assert.equal(err.status, "timeout");
    return true;
  });
  assert.equal(source.closecalled, true, "失败时应关闭 source");
  assert.equal(manager.getCurrentSource(), null, "失败后 getCurrentSource 为 null");
});

test("ensureConnected 在 connected 帧到达时正常返回", async () => {
  const source = createFakeSource();
  const timers = fakeTimers();
  const manager = createEventStreamManager({
    createEventSource: () => source,
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    connectTimeoutMs: 1_000,
  });

  const promise = manager.ensureConnected("s1", () => {});
  source.readyState = OPEN;
  source.emit({ type: "connected" });

  await promise;
  assert.equal(manager.getCurrentSource(), source);
  assert.equal(source.closecalled, false);
});

test("onEvent 回调在每帧送达时被调用（包括 connected 帧）", async () => {
  const source = createFakeSource();
  const timers = fakeTimers();
  const events = [];
  const manager = createEventStreamManager({
    createEventSource: () => source,
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    connectTimeoutMs: 5_000,
  });

  const promise = manager.connect("s1", (e) => events.push(e));
  source.readyState = OPEN;
  source.emit({ type: "connected" });
  source.emit({ type: "message_start", message: { role: "assistant" } });
  await promise;
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "connected");
  assert.equal(events[1].type, "message_start");
});

test("message_update 每帧只投递最新完整快照", async () => {
  const source = createFakeSource();
  const timers = fakeTimers();
  const frames = fakeFrames();
  const events = [];
  const manager = createEventStreamManager({
    createEventSource: () => source,
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
  });

  const promise = manager.connect("s1", (event) => events.push(event));
  source.readyState = OPEN;
  source.emit({ type: "connected" });
  source.emit({ type: "message_update", message: { content: "a" } });
  source.emit({ type: "message_update", message: { content: "ab" } });
  await promise;

  assert.deepEqual(events.map((event) => event.type), ["connected"]);
  assert.equal(frames.pending(), 1);
  frames.flush();
  assert.deepEqual(events.map((event) => event.type), ["connected", "message_update"]);
  assert.equal(events[1].message.content, "ab");
});

test("非流式边界先同步 flush message_update，再保持原事件顺序", async () => {
  const source = createFakeSource();
  const timers = fakeTimers();
  const frames = fakeFrames();
  const events = [];
  const manager = createEventStreamManager({
    createEventSource: () => source,
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
  });

  const promise = manager.connect("s1", (event) => events.push(event));
  source.readyState = OPEN;
  source.emit({ type: "connected" });
  source.emit({ type: "message_update", message: { content: "final snapshot" } });
  source.emit({ type: "message_end", message: { content: "final snapshot" } });
  await promise;

  assert.deepEqual(events.map((event) => event.type), [
    "connected",
    "message_update",
    "message_end",
  ]);
  assert.equal(frames.pending(), 0);
});

test("切换或关闭连接会取消旧会话待投递帧", async () => {
  const source = createFakeSource();
  const timers = fakeTimers();
  const frames = fakeFrames();
  const events = [];
  const manager = createEventStreamManager({
    createEventSource: () => source,
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
  });

  const promise = manager.connect("s1", (event) => events.push(event));
  source.readyState = OPEN;
  source.emit({ type: "connected" });
  source.emit({ type: "message_update", message: { content: "stale" } });
  await promise;
  manager.close();
  frames.flush();

  assert.deepEqual(events.map((event) => event.type), ["connected"]);
});

test("致命错误 CLOSED 触发 closed 状态 resolve", async () => {
  const source = createFakeSource();
  const timers = fakeTimers();
  const manager = createEventStreamManager({
    createEventSource: () => source,
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    connectTimeoutMs: 5_000,
    shouldAutoReconnect: () => false,
  });

  const promise = manager.connect("s1", () => {});
  source.readyState = CLOSED;
  source.emitError(CLOSED);

  const result = await promise;
  assert.equal(result.status, "closed");
});

test("致命错误 + shouldAutoReconnect 为 true 时调度一次重连", async () => {
  const source1 = createFakeSource();
  const source2 = createFakeSource();
  const sources = [source1, source2];
  let created = 0;
  const timers = fakeTimers();
  let running = true;
  const manager = createEventStreamManager({
    createEventSource: () => sources[created++] ?? createFakeSource(),
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    connectTimeoutMs: 5_000,
    reconnectDelayMs: 1_000,
    shouldAutoReconnect: () => running,
  });

  const events = [];
  const promise = manager.connect("s1", (e) => events.push(e));
  // 第一次连接致命错误。
  source1.readyState = CLOSED;
  source1.emitError(CLOSED);
  const first = await promise;
  assert.equal(first.status, "closed");
  assert.equal(created, 1, "Created initial source");
  assert.equal(timers.pending(), 1, "应有一次待执行的重连定时器");
  // 还有一个候选 source 第二号；触发重连。
  timers.flush();
  // 第二次连接成功。
  source2.readyState = OPEN;
  source2.emit({ type: "connected" });
  // 没有等待第二次 connect 的 Promise 句柄——但应能通过 ensureConnected 验证。
  // 我们改为断言 created 数与事件流接入。
  assert.equal(created, 2, "重连后产生了第二个 source");
  assert.equal(manager.getCurrentSource(), source2);
});

test("close 清除当前 source 并取消挂起的重连定时器", async () => {
  const source = createFakeSource();
  const timers = fakeTimers();
  const manager = createEventStreamManager({
    createEventSource: () => source,
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    connectTimeoutMs: 5_000,
    reconnectDelayMs: 1_000,
    shouldAutoReconnect: () => true,
  });

  const promise = manager.connect("s1", () => {});
  source.readyState = CLOSED;
  source.emitError(CLOSED);
  await promise;
  assert.equal(timers.pending(), 1, "应挂起重连");
  manager.close();
  assert.equal(timers.pending(), 0, "close 取消重连");
  assert.equal(manager.getCurrentSource(), null);
  // 致命 CLOSED 后旧 source 已被浏览器关闭，管理器走重连路径会先把
  // current 置 null，close 不会再触发旧 source.close（浏览器已关）。
  // 但如果尚有挂起重连，重连定时器必须被取消 — 上面已断言。
});

test("connect 切换到新会话时先关闭旧 source", async () => {
  const sourceA = createFakeSource();
  const sourceB = createFakeSource();
  const sources = [sourceA, sourceB];
  let created = 0;
  const timers = fakeTimers();
  const manager = createEventStreamManager({
    createEventSource: () => sources[created++],
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    connectTimeoutMs: 5_000,
  });

  // 第一次连接成功（OPEN + connected）。
  sourceA.readyState = OPEN;
  const aPromise = manager.connect("s1", () => {});
  sourceA.emit({ type: "connected" });
  await aPromise;
  assert.equal(manager.getCurrentSource(), sourceA);
  assert.equal(sourceA.closecalled, false);

  // 第二次连接：connect 入口会先 close 旧 source 再创建新的。
  sourceB.readyState = OPEN;
  const bPromise = manager.connect("s2", () => {});
  sourceB.emit({ type: "connected" });
  await bPromise;
  assert.equal(manager.getCurrentSource(), sourceB);
  assert.equal(sourceA.closecalled, true, "connect 入口关闭旧 source");
  assert.equal(created, 2);
});
