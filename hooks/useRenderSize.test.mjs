/**
 * 尺寸上报的决策（issue #70 审查后补）。
 *
 * 为什么单拎出来测：上报决策错了不会有报错，只会让插件的 columns/rows 停在默认值 ——
 * 而按 `rows` 裁切的插件（pi-subagents 的 fleet 详情）会**真把行丢掉**。
 * 决策是纯函数，所以这里测行为；接线部分再用一条守卫断言，保证判断真的被用上。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { shouldReportRenderSize, RENDER_ROWS_STABLE_BAND } = await jiti.import("./useRenderSize.ts");

const report = (sessionId, width, rows) => ({ sessionId, width, rows });

test("没上报过就报", () => {
  assert.equal(shouldReportRenderSize(null, report("s1", 100, 40)), true);
});

test("同一会话、尺寸没变 → 不报（避免重复命令）", () => {
  assert.equal(shouldReportRenderSize(report("s1", 100, 40), report("s1", 100, 40)), false);
});

test("换了会话、像素尺寸完全相同 → 必须报", () => {
  // 这是审查发现的缺口：新 host 的 columns/rows 还是默认值，而两棵会话的滚动区
  // 像素尺寸通常一样，只比尺寸会把它整条漏掉。
  assert.equal(shouldReportRenderSize(report("s1", 100, 40), report("s2", 100, 40)), true);
});

test("宽度变了 → 报（插件按列排版，列错了方框/表格就错位）", () => {
  assert.equal(shouldReportRenderSize(report("s1", 100, 40), report("s1", 99, 40)), true);
  assert.equal(shouldReportRenderSize(report("s1", 100, 40), report("s1", 101, 40)), true);
});

test("行数在稳定带内不报，累积超过带宽再报", () => {
  assert.equal(RENDER_ROWS_STABLE_BAND, 1, "稳定带写死在这里：改常量要连带确认这条断言");
  assert.equal(shouldReportRenderSize(report("s1", 100, 40), report("s1", 100, 41)), false);
  assert.equal(shouldReportRenderSize(report("s1", 100, 40), report("s1", 100, 39)), false);
  assert.equal(shouldReportRenderSize(report("s1", 100, 40), report("s1", 100, 42)), true);
  // 比较的是**上次上报值**：连续 +1 会累积到 42 再报，变化不会被丢掉。
  assert.equal(shouldReportRenderSize(report("s1", 100, 40), report("s1", 100, 43)), true);
});

test("接线：换会话作废上次记录，且两个维度一起发", () => {
  const source = readFileSync(new URL("./useRenderSize.ts", import.meta.url), "utf8");
  assert.match(source, /shouldReportRenderSize\(lastSentRef\.current, next\)/, "决策函数没被用上");
  assert.match(source, /type: "set_render_size", width, rows/, "两个维度必须一起发");
  assert.match(source, /lastSentRef\.current = null;/, "换会话要作废上次上报记录");
  assert.match(source, /RENDER_SIZE_MAX_RETRIES/, "上报失败要有有界重试");
  assert.match(source, /ResizeObserver/, "尺寸变化要靠观察者跟");
});
