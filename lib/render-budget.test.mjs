/**
 * 渲染开销预算（2026-10-07 事故的根治项）。
 *
 * 决策是纯函数式的，所以这里测行为；接线（真的被用在两条限流路径上）另用守卫断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { createRenderBudget, RENDER_DUTY_CYCLE } = await jiti.import("./render-budget.ts");

test("没量到开销时就是基础间隔（正常情况下行为与改动前一致）", () => {
  const budget = createRenderBudget({ baseMs: 100 });
  assert.equal(budget.minIntervalMs(), 100);
  assert.equal(budget.overloaded(), false);
});

test("渲染开销小：仍取基础间隔，不因为一次 20ms 的渲染就变慢", () => {
  const budget = createRenderBudget({ baseMs: 100 });
  budget.record(20);
  assert.equal(budget.minIntervalMs(), 100);
  assert.equal(budget.overloaded(), false);
});

test("渲染开销超过基础间隔：间隔按占空比放大，且随开销线性变长", () => {
  assert.equal(RENDER_DUTY_CYCLE, 0.25, "占空比写死在这里：改常量要连带确认这条断言");
  const budget = createRenderBudget({ baseMs: 100 });
  budget.record(200);
  assert.equal(budget.minIntervalMs(), 800, "200ms 的渲染 → 每 800ms 才准再渲一次（1/4 占空）");
  assert.equal(budget.overloaded(), true);
  budget.record(262);
  assert.equal(budget.minIntervalMs(), 1048, "实测 55 万字符 ≈ 262ms 的渲染对应这个间隔");
});

test("占空比可调；非法占空比回落到默认值", () => {
  const half = createRenderBudget({ baseMs: 100, dutyCycle: 0.5 });
  half.record(200);
  assert.equal(half.minIntervalMs(), 400);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const budget = createRenderBudget({ baseMs: 100, dutyCycle: bad });
    budget.record(400);
    assert.equal(budget.minIntervalMs(), 1600, `占空比 ${String(bad)} 应回落到默认`);
  }
  const capped = createRenderBudget({ baseMs: 100, dutyCycle: 2 });
  capped.record(100);
  assert.equal(capped.minIntervalMs(), 100, "占空比夹到 ≤1");
});

test("非法开销不改判定（量不出来就当没量到）", () => {
  const budget = createRenderBudget({ baseMs: 100 });
  budget.record(200);
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    budget.record(bad);
    assert.equal(budget.minIntervalMs(), 800, `开销 ${String(bad)} 不该改判定`);
  }
  budget.record(0);
  assert.equal(budget.minIntervalMs(), 100, "真的量到 0ms 要如实回落");
});

test("接线：宿主在唯一的重渲入口记开销，两条限流路径都读预算，宽度变化也走限频", () => {
  const source = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(source, /createRenderBudget\(\{\s*baseMs: SdkSessionHost\.PARTIAL_RENDER_MIN_INTERVAL_MS,?\s*\}\)/, "宿主没建预算");
  assert.match(source, /this\.renderBudget\.record\(Date\.now\(\) - startedAt\)/, "重渲没记实际开销（预算就永远停在基础间隔）");
  assert.match(source, /now - entry\.lastPartialRenderAt < this\.renderBudget\.minIntervalMs\(\)/, "partial 限流没用预算");
  assert.match(source, /minIntervalMs: \(\) => this\.renderBudget\.minIntervalMs\(\)/, "插件 invalidate 限流没用预算");
  // 宽度变化在拖动窗口时并不低频：必须回到限频路径，否则拖着窗口就能把事件循环打满
  assert.match(source, /private rerenderToolLines\(\): void \{\s*\n\s*for \(const key of this\.toolRenderStates\.keys\(\)\) this\.toolRenderScheduler\.request\(key\);/, "宽度变化仍在无预算地立即重渲");
});
