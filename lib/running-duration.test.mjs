/**
 * P1-5 运行时长纯函数测试。
 *
 * 覆盖：
 * - splitRunningDuration 毫秒拆分（秒/分+秒/时+分 边界）
 * - formatRunningDuration 键选择与占位符（<1m / <1h / ≥1h）
 * - trackRunningStartedAt first-seen 语义（新增保留首次时间、消失移除、
 *   再出现重新记时、无变化返回原引用）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./running-duration.ts");

// 假 t：返回键本身（断言键选择）；带占位符时渲染 `key(h=1,m=5)`。
const t = (key, values = {}) =>
  Object.keys(values).length === 0
    ? key
    : `${key}(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(",")})`;

test("splitRunningDuration：毫秒拆分与负值/零值兜底", () => {
  assert.deepEqual(mod.splitRunningDuration(45_000), { hours: 0, minutes: 0, seconds: 45 });
  assert.deepEqual(mod.splitRunningDuration(2 * 60_000 + 14_000), { hours: 0, minutes: 2, seconds: 14 });
  assert.deepEqual(mod.splitRunningDuration(60 * 60_000 + 5 * 60_000 + 3_000), { hours: 1, minutes: 5, seconds: 3 });
  assert.deepEqual(mod.splitRunningDuration(0), { hours: 0, minutes: 0, seconds: 0 });
  // 负值按 0（now - startedAt 在时钟回拨时不会出现负时长）
  assert.deepEqual(mod.splitRunningDuration(-5_000), { hours: 0, minutes: 0, seconds: 0 });
  // 未满 1 秒也显示 0s（不伪造）
  assert.deepEqual(mod.splitRunningDuration(500), { hours: 0, minutes: 0, seconds: 0 });
});

test("formatRunningDuration：量级决定键", () => {
  assert.equal(mod.formatRunningDuration(45_000, t), "sidebar_runningSeconds(s=45)");
  assert.equal(mod.formatRunningDuration(2 * 60_000 + 14_000, t), "sidebar_runningMinutesSeconds(m=2,s=14)");
  // 恰好 60s 走分+秒
  assert.equal(mod.formatRunningDuration(60_000, t), "sidebar_runningMinutesSeconds(m=1,s=0)");
  // ≥1 小时走时+分（秒丢弃）
  assert.equal(mod.formatRunningDuration(65 * 60_000 + 3_000, t), "sidebar_runningHoursMinutes(h=1,m=5)");
  // 整 1 小时：m=0
  assert.equal(mod.formatRunningDuration(3_600_000, t), "sidebar_runningHoursMinutes(h=1,m=0)");
});

test("trackRunningStartedAt：first-seen 保留、消失移除、再出现重新记时", () => {
  const initial = new Map([["s1", 1000], ["s2", 2000]]);
  // 无变化：返回原引用（组件可跳过 setState）
  const same = mod.trackRunningStartedAt(initial, ["s2", "s1"], 9999);
  assert.equal(same, initial);

  // 新增 s3（now=9999），s1 保留原时间
  const withNew = mod.trackRunningStartedAt(initial, ["s1", "s3"], 9999);
  assert.equal(withNew.get("s1"), 1000);
  assert.equal(withNew.get("s3"), 9999);

  // 消失的 s2 移除；再出现的 s2 重新记时（非保留旧时间）
  const afterGone = mod.trackRunningStartedAt(withNew, ["s1"], 10_000);
  assert.equal(afterGone.has("s2"), false);
  const back = mod.trackRunningStartedAt(afterGone, ["s1", "s2"], 11_000);
  assert.equal(back.get("s2"), 11_000);
  assert.equal(back.get("s1"), 1000, "持续运行中的会话保留首次见到时间");
});

test("trackRunningStartedAt：空集合清空记录", () => {
  const initial = new Map([["s1", 1000]]);
  const cleared = mod.trackRunningStartedAt(initial, [], 5000);
  assert.equal(cleared.size, 0);
});

test("mergeRunningStartedAt：服务端发送时间覆盖 first-seen", () => {
  const initial = new Map([["s1", 1000]]);
  const server = new Map([["s1", 400]]);
  const merged = mod.mergeRunningStartedAt(initial, ["s1"], server, 9999);
  assert.equal(merged.get("s1"), 400);
  const same = mod.mergeRunningStartedAt(merged, ["s1"], server, 10_000);
  assert.equal(same, merged);
});

test("mergeRunningStartedAt：无服务端值时 first-seen 兜底，离开集合则移除", () => {
  const initial = new Map([["s1", 1000]]);
  const withNew = mod.mergeRunningStartedAt(initial, ["s1", "s2"], new Map(), 2000);
  assert.equal(withNew.get("s1"), 1000);
  assert.equal(withNew.get("s2"), 2000);
  const gone = mod.mergeRunningStartedAt(withNew, [], new Map(), 3000);
  assert.equal(gone.size, 0);
});
