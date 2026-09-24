/**
 * 工具渲染器重渲调度（issue #69）。
 *
 * 验收口径：① 插件 invalidate() 会**重新调用渲染器**（不是只重渲缓存组件）；
 * ② 同栈重入不丢刷新（渲染期间又来的 request 补跑一次）；③ 行内容未变不重复推事件；
 * ④ 高频刷新被限频，但最后一次一定到。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { createToolRenderScheduler, pickChangedSlots } = await jiti.import("./tool-render-scheduler.ts");
const { renderToolCallLines, loadPiTheme } = await jiti.import("./tui-render-bridge.ts");
// 渲染桥需要主题；加载不到就直接判为环境问题，别让下面的验收用例神秘失败。
const themeReady = loadPiTheme() !== null;

/** 假时钟 + 假定时器：不依赖真实等待，也不依赖测试机器快慢。 */
function fakeClock() {
  let time = 0;
  const timers = [];
  return {
    now: () => time,
    setTimer: (fn, ms) => {
      const handle = { fn, at: time + ms, cancelled: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      handle.cancelled = true;
    },
    advance(ms) {
      time += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.cancelled || timer.at > time) continue;
        timer.cancelled = true;
        timer.fn();
      }
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

function makeScheduler(clock, compute, { minIntervalMs = 100 } = {}) {
  const emitted = [];
  const errors = [];
  const scheduler = createToolRenderScheduler({
    minIntervalMs,
    recompute: compute,
    emit: (key, change) => emitted.push({ key, change }),
    onError: (error) => errors.push(error),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { scheduler, emitted, errors };
}

test("无变化不推事件；有变化才推", () => {
  const clock = fakeClock();
  let change = null;
  const { scheduler, emitted } = makeScheduler(clock, () => change);
  scheduler.request("t1");
  assert.deepEqual(emitted, [], "recompute 返回 null 时不得推事件");
  change = { callLines: ["a"] };
  clock.advance(1000);
  scheduler.request("t1");
  assert.deepEqual(emitted, [{ key: "t1", change: { callLines: ["a"] } }]);
});

test("限频：间隔内的连续 request 合并成一次尾随渲染（最后一次一定到）", () => {
  const clock = fakeClock();
  let renders = 0;
  const { scheduler, emitted } = makeScheduler(clock, () => {
    renders += 1;
    return { callLines: [`r${renders}`] };
  });
  scheduler.request("t1"); // 立即渲染
  assert.equal(renders, 1);
  scheduler.request("t1"); // 间隔内 → 排队
  scheduler.request("t1");
  scheduler.request("t1");
  assert.equal(renders, 1, "限频期间不得立即重渲");
  assert.equal(clock.pending(), 1, "只应有一个尾随定时器");
  clock.advance(100);
  assert.equal(renders, 2, "尾随定时器到点补跑一次");
  assert.equal(emitted.length, 2);
});

test("同栈重入不丢刷新：渲染期间来的 request 结束后补跑一次", () => {
  const clock = fakeClock();
  let renders = 0;
  const { scheduler, emitted } = makeScheduler(clock, () => {
    renders += 1;
    if (renders === 1) {
      // 插件把 invalidate 写进自己的 render 里：不能递归、也不能丢。
      scheduler.request("t1");
    }
    return { callLines: [`r${renders}`] };
  });
  scheduler.request("t1");
  assert.equal(renders, 1, "第一次渲染期间不得递归");
  clock.advance(100);
  assert.equal(renders, 2, "结束后补跑一次（不丢那次刷新）");
  assert.equal(emitted.length, 2);
  clock.advance(1000);
  assert.equal(renders, 2, "补跑只有一次（自激不会无限循环）");
});

test("recompute 抛错不打断调度：记录错误且不卡在渲染中", () => {
  const clock = fakeClock();
  let renders = 0;
  const { scheduler, emitted, errors } = makeScheduler(clock, () => {
    renders += 1;
    if (renders === 1) throw new Error("renderer boom");
    return { callLines: ["ok"] };
  });
  scheduler.request("t1");
  assert.equal(errors.length, 1);
  assert.equal(scheduler.isRendering("t1"), false, "抛错后必须解除渲染中标记");
  clock.advance(1000);
  scheduler.request("t1");
  assert.deepEqual(emitted, [{ key: "t1", change: { callLines: ["ok"] } }]);
});

test("flush 立即重渲并清掉待执行定时器；dispose 之后定时器不再触发", () => {
  const clock = fakeClock();
  let renders = 0;
  const { scheduler } = makeScheduler(clock, () => {
    renders += 1;
    return { callLines: ["x"] };
  });
  scheduler.request("t1");
  scheduler.request("t1"); // 排队
  scheduler.flush("t1");
  assert.equal(renders, 2, "flush 立即渲染");
  assert.equal(clock.pending(), 0, "flush 应清掉待执行定时器");
  scheduler.request("t1"); // 限频期间 → 排队
  assert.equal(clock.pending(), 1, "限频期间应有一个待执行定时器");
  scheduler.dispose();
  assert.equal(clock.pending(), 0, "dispose 要清掉待执行定时器");
  clock.advance(10_000);
  assert.equal(renders, 2, "dispose 之后不得再渲染（那次排队被清掉）");
});

// 宿主 dispose 后仍可能收到插件的 invalidate（异步回调在飞）。只清定时器不够：
// 下一次 request 会为同一个 key 新建状态并直接 run → 销毁后还在推事件（旧行为）。
test("dispose 之后 request/flush 一律空跑（销毁后不再重算、不再推事件）", () => {
  const clock = fakeClock();
  let renders = 0;
  const { scheduler, emitted } = makeScheduler(clock, () => {
    renders += 1;
    return { callLines: [`r${renders}`] };
  });
  scheduler.request("t1");
  assert.equal(renders, 1);
  scheduler.dispose();
  const emittedBefore = emitted.length;
  scheduler.request("t1");
  scheduler.request("t2");
  scheduler.flush("t1");
  scheduler.flushAll(["t1", "t2"]);
  assert.equal(renders, 1, "dispose 后不得再渲染（哪怕是新 key 或 flush）");
  assert.equal(emitted.length, emittedBefore, "dispose 后不得再推事件");
  assert.equal(clock.pending(), 0, "dispose 后不得留下定时器");
  clock.advance(10_000);
  assert.equal(renders, 1, "推进时钟也不得触发渲染");
  assert.equal(scheduler.isRendering("t1"), false);
});

test("验收：插件（真实渲染桥 + 真实组件形状）在异步完成后 invalidate，宿主要重调渲染器并推送新行", () => {
  const clock = fakeClock();
  const lines = [];
  let rendererCalls = 0;
  let pendingResolve = null;

  // 组件形状与 pi-tui 一致：对象 + render(width) → 行数组。
  const makeComponent = (text) => ({ render: () => [text] });

  // 渲染器形状与 SDK 一致：renderCall(args, theme, context)，编辑器的 diff 预览就是
  // 在 context.argsComplete 为真时起一个异步计算，完成后调 context.invalidate()。
  const def = {
    renderCall: (args, theme, context) => {
      rendererCalls += 1;
      if (rendererCalls === 1) {
        pendingResolve = () => {
          lines.push("preset-diff");
          context.invalidate();
        };
        return makeComponent("computing-diff");
      }
      return makeComponent(`diff:${lines.at(-1) ?? "none"}`);
    },
  };

  const { scheduler, emitted } = makeScheduler(clock, (key) => {
    const context = {
      args: { path: "a.ts" },
      toolCallId: key,
      invalidate: () => scheduler.request(key),
      lastComponent: undefined,
      state: {},
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: false,
    };
    const rendered = renderToolCallLines(def, { path: "a.ts" }, context);
    return rendered ? { callLines: rendered } : null;
  });

  assert.ok(themeReady, "渲染桥主题加载失败（环境问题，非本次改动）");
  scheduler.request("t1");
  assert.equal(rendererCalls, 1, "首次渲染调用渲染器一次");
  assert.match(emitted[0].change.callLines[0], /computing-diff/);

  pendingResolve(); // 异步计算完成 → 插件 invalidate()
  clock.advance(100);
  assert.equal(rendererCalls, 2, "invalidate 必须重新调用渲染器（不是只重渲缓存组件）");
  assert.match(emitted[1].change.callLines[0], /diff:preset-diff/, "新内容要真的推给前端");
});

test("验收：行内容未变不重复推事件（去重判定）", () => {
  const previous = { callLines: ["a", "b"], resultLines: ["r1"] };
  assert.equal(pickChangedSlots({ callLines: ["a", "b"], resultLines: ["r1"] }, previous), null, "完全相同 → 不推");
  assert.deepEqual(
    pickChangedSlots({ callLines: ["a", "b"], resultLines: ["r2"] }, previous),
    { resultLines: ["r2"] },
    "只有变化的那一槽进事件",
  );
  assert.deepEqual(
    pickChangedSlots({ callLines: ["a", "c"], resultLines: null }, previous),
    { callLines: ["a", "c"] },
    "槽这次没产出就不推它（也不清空已显示的旧行）",
  );
  assert.deepEqual(pickChangedSlots({ callLines: ["a"] }, previous), { callLines: ["a"] }, "长度变化算变化");
  assert.deepEqual(pickChangedSlots({ callLines: ["x"] }, {}), { callLines: ["x"] }, "首次推送");
});
