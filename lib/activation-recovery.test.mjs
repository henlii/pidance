import assert from "node:assert/strict";
import test from "node:test";

import {
  beginActivationRun,
  createActivationRecovery,
  emptyActivationState,
  endActivationRun,
  noteActivation,
} from "./activation-recovery.ts";

/** 手动计时器：测试里显式推进，避免依赖真实时间。 */
function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimer(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    /** 跑掉当前所有到期任务（按注册顺序）。 */
    async flush() {
      for (const [id, item] of [...pending]) {
        pending.delete(id);
        item.fn();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
    sizes: () => [...pending.values()].map((item) => item.ms),
  };
}

test("#52 状态机：同批合并、在途补跑、失败不卡死", () => {
  // 一次激活 → 安排
  const first = noteActivation(emptyActivationState());
  assert.equal(first.note, "schedule");
  // 同批第二次（focus + visibilitychange 一起到）→ 吞掉
  const second = noteActivation(first.state);
  assert.equal(second.note, "coalesced");
  assert.equal(second.state.scheduled, true);

  // 执行期间来的激活 → 记一笔待补跑
  const running = beginActivationRun(second.state);
  assert.equal(running.scheduled, false);
  assert.equal(running.inFlight, true);
  const during = noteActivation(running);
  assert.equal(during.note, "deferred");
  assert.equal(during.state.rerun, true);

  // 结束 → 需要补跑一次（不丢）
  const ended = endActivationRun(during.state);
  assert.equal(ended.rerun, true);
  assert.equal(ended.state.inFlight, false);

  // 补跑期间又没来新激活 → 不再补跑
  assert.equal(endActivationRun(beginActivationRun(ended.state)).rerun, false);
});

test("#52 驱动器：同一批 focus+visibilitychange 只执行一次", async () => {
  const timers = fakeTimers();
  let runs = 0;
  const driver = createActivationRecovery({
    perform: () => { runs += 1; },
    coalesceMs: 200,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  assert.deepEqual(timers.sizes(), []);
  driver.notify(); // focus
  driver.notify(); // 同一批的 visibilitychange
  assert.deepEqual(timers.sizes(), [200], "同批只安排一次执行");
  await timers.flush();
  assert.equal(runs, 1, "一次激活只恢复一次");
  driver.dispose();
});

test("#52 驱动器：执行期间到达的激活补跑一次（宁可多一次也不丢）", async () => {
  const timers = fakeTimers();
  let runs = 0;
  let release;
  const driver = createActivationRecovery({
    perform: () => { runs += 1; return new Promise((resolve) => { release = resolve; }); },
    coalesceMs: 200,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  driver.notify();
  await timers.flush(); // 第一次开始执行（不 await perform）
  assert.equal(runs, 1);
  driver.notify(); // 执行期间又来一次
  driver.notify(); // 同批的第二个事件
  release();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(timers.sizes(), [0], "结束后立刻补跑一次");
  await timers.flush();
  assert.equal(runs, 2);
  driver.dispose();
});

test("#52 驱动器：perform 抛错不卡死，后续激活仍能执行", async () => {
  const timers = fakeTimers();
  let runs = 0;
  const driver = createActivationRecovery({
    perform: () => { runs += 1; if (runs === 1) throw new Error("boom"); },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  driver.notify();
  await timers.flush();
  assert.equal(runs, 1);
  assert.equal(driver.snapshot().inFlight, false, "同步抛错也要收尾，不能卡在 inFlight");
  driver.notify();
  await timers.flush();
  assert.equal(runs, 2, "下一次激活仍会执行");
  driver.dispose();
});

test("#52 驱动器：dispose 后不再执行待跑的安排", async () => {
  const timers = fakeTimers();
  let runs = 0;
  const driver = createActivationRecovery({
    perform: () => { runs += 1; },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  driver.notify();
  driver.dispose();
  await timers.flush();
  assert.equal(runs, 0);
  driver.notify();
  await timers.flush();
  assert.equal(runs, 0, "dispose 之后激活不再触发");
});
