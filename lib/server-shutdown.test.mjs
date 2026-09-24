/**
 * 退出收尾顺序：先 await dispose（交出 writer），再硬断 SSE。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  closeAllEventStreams,
  disposeLiveHosts,
  installShutdownHooks,
  registerEventStreamCloser,
  resetShutdownStateForTests,
  runGracefulShutdown,
} = await jiti.import("./server-shutdown.ts");

function silent() {
  return () => {};
}

test("顺序：全部 host dispose 完成后才断流", async () => {
  resetShutdownStateForTests();
  const order = [];
  registerEventStreamCloser(() => order.push("close-stream-1"));
  registerEventStreamCloser(() => order.push("close-stream-2"));
  const hosts = [
    { sessionId: "a", async destroyAsync() { order.push("dispose-a"); } },
    { sessionId: "b", async destroyAsync() { order.push("dispose-b"); } },
  ];
  await runGracefulShutdown({ listHosts: () => hosts, log: silent() });
  assert.deepEqual(order, ["dispose-a", "dispose-b", "close-stream-1", "close-stream-2"]);
});

test("dispose 超时不阻塞断流（超时后仍硬断，标记 timedOut）", async () => {
  resetShutdownStateForTests();
  const closed = [];
  registerEventStreamCloser(() => closed.push("stream"));
  const result = await disposeLiveHosts({
    capMs: 50,
    listHosts: () => [{ sessionId: "stuck", destroyAsync: () => new Promise(() => {}) }],
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.settled, 0);
  assert.equal(result.total, 1);
  await runGracefulShutdown({
    capMs: 50,
    listHosts: () => [{ sessionId: "stuck-2", destroyAsync: () => new Promise(() => {}) }],
    log: silent(),
  });
  assert.deepEqual(closed, ["stream"], "dispose 卡住也必须走到断流");
});

test("dispose 抛错不影响其它 host 与断流", async () => {
  resetShutdownStateForTests();
  const settled = [];
  const result = await disposeLiveHosts({
    listHosts: () => [
      { sessionId: "boom", async destroyAsync() { throw new Error("busy"); } },
      { sessionId: "ok", async destroyAsync() { settled.push("ok"); } },
    ],
  });
  assert.equal(result.settled, 2, "抛错按已结算处理，不能卡住收尾");
  assert.deepEqual(settled, ["ok"]);
});

test("重复信号只收尾一次（幂等）", async () => {
  resetShutdownStateForTests();
  let listed = 0;
  const options = {
    listHosts: () => {
      listed += 1;
      return [{ sessionId: "a", async destroyAsync() {} }];
    },
    log: silent(),
  };
  await Promise.all([runGracefulShutdown(options), runGracefulShutdown(options)]);
  assert.equal(listed, 1, "并发收尾必须共享同一次执行");
  await runGracefulShutdown(options);
  assert.equal(listed, 1, "收尾完成后重复触发不得再跑一遍");
});

test("closer 注销后不再被调用；单条抛错不阻断其它连接", () => {
  resetShutdownStateForTests();
  const called = [];
  const unregister = registerEventStreamCloser(() => called.push("temp"));
  unregister();
  registerEventStreamCloser(() => { throw new Error("closed already"); });
  registerEventStreamCloser(() => called.push("kept"));
  const count = closeAllEventStreams();
  assert.equal(count, 2);
  assert.deepEqual(called, ["kept"]);
});

test("installShutdownHooks 幂等，reset 后摘掉信号钩子", () => {
  resetShutdownStateForTests();
  const before = process.listenerCount("SIGTERM");
  installShutdownHooks({ log: silent() });
  installShutdownHooks({ log: silent() });
  assert.equal(process.listenerCount("SIGTERM"), before + 1, "重复安装只能有一个钩子");
  assert.equal(process.listenerCount("SIGINT"), process.listenerCount("SIGTERM"));
  resetShutdownStateForTests();
  assert.equal(process.listenerCount("SIGTERM"), before);
});
