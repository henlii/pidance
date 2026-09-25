/**
 * custom 面板几何（pi-tui OverlayBounds 的 Web 投影）的纯逻辑：
 * 像素矩形 → 字符单元格，以及「这次该不该上报」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// 与 lib/ 其他测试一致走 jiti：该模块用无扩展名相对导入引用共享类型。
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { customPanelBoundsFromRects, shouldReportCustomPanelBounds } = await jiti.import("./custom-panel-bounds.ts");

const RECT = (left, top, width, height) => ({ left, top, width, height });

test("几何换算：按字符宽/行高折算，原点取容器的左上角", () => {
  assert.deepEqual(
    customPanelBoundsFromRects({
      bodyRect: RECT(100, 50, 480, 60),
      containerRect: { left: 0, top: 0 },
      charWidth: 8,
      lineHeight: 20,
    }),
    { row: 2, col: 12, width: 60, height: 3 },
  );

  // 原点容器不在 (0,0)：坐标是相对容器的，不是相对窗口的
  assert.deepEqual(
    customPanelBoundsFromRects({
      bodyRect: RECT(100, 50, 80, 20),
      containerRect: { left: 40, top: 10 },
      charWidth: 8,
      lineHeight: 20,
    }),
    { row: 2, col: 7, width: 10, height: 1 },
  );
});

test("几何换算：不满一格向下取整，宽高至少 1", () => {
  assert.deepEqual(
    customPanelBoundsFromRects({
      bodyRect: RECT(3, 7, 20, 10),
      containerRect: { left: 0, top: 0 },
      charWidth: 8,
      lineHeight: 20,
    }),
    // col: floor(3/8) = 0；row: floor(7/20) = 0；width: floor(20/8) = 2；height: floor(10/20) = 0 → 1
    { row: 0, col: 0, width: 2, height: 1 },
  );
});

test("几何换算：面板滚出容器上方时行号可以为负（不夹到 0）", () => {
  assert.deepEqual(
    customPanelBoundsFromRects({
      bodyRect: RECT(0, 30, 80, 40),
      containerRect: { left: 0, top: 50 },
      charWidth: 8,
      lineHeight: 20,
    }),
    { row: -1, col: 0, width: 10, height: 2 },
  );
});

test("几何换算：量不出就返回 null，不编造 0", () => {
  const base = { bodyRect: RECT(0, 0, 80, 40), containerRect: { left: 0, top: 0 } };
  for (const bad of [null, 0, -8, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      customPanelBoundsFromRects({ ...base, charWidth: bad, lineHeight: 20 }),
      null,
      `charWidth=${String(bad)} 必须返回 null`,
    );
    assert.equal(
      customPanelBoundsFromRects({ ...base, charWidth: 8, lineHeight: bad }),
      null,
      `lineHeight=${String(bad)} 必须返回 null`,
    );
  }
});

test("几何换算：未布局 / 非有限矩形一律 null（不致崩）", () => {
  const ok = { containerRect: { left: 0, top: 0 }, charWidth: 8, lineHeight: 20 };
  assert.equal(customPanelBoundsFromRects({ ...ok, bodyRect: RECT(0, 0, 0, 40) }), null, "宽为 0");
  assert.equal(customPanelBoundsFromRects({ ...ok, bodyRect: RECT(0, 0, 80, 0) }), null, "高为 0");
  assert.equal(customPanelBoundsFromRects({ ...ok, bodyRect: RECT(0, 0, -80, 40) }), null, "负宽");
  assert.equal(
    customPanelBoundsFromRects({ ...ok, bodyRect: RECT(Number.NaN, 0, 80, 40) }),
    null,
    "NaN 坐标",
  );
  assert.equal(
    customPanelBoundsFromRects({ ...ok, bodyRect: RECT(0, 0, Number.POSITIVE_INFINITY, 40) }),
    null,
    "Infinity 宽",
  );
  assert.equal(
    customPanelBoundsFromRects({
      bodyRect: RECT(0, 0, 80, 40),
      containerRect: { left: Number.NaN, top: 0 },
      charWidth: 8,
      lineHeight: 20,
    }),
    null,
    "容器坐标 NaN",
  );
});

test("该不该上报：首次上报、任一分量变化都报，完全一致不报", () => {
  const bounds = { row: 1, col: 2, width: 30, height: 4 };
  assert.equal(shouldReportCustomPanelBounds(null, bounds, true), true, "首次要报");
  assert.equal(
    shouldReportCustomPanelBounds(bounds, { ...bounds }, true),
    false,
    "完全相同不重发（ResizeObserver 会反复回调）",
  );
  for (const key of ["row", "col", "width", "height"]) {
    assert.equal(
      shouldReportCustomPanelBounds(bounds, { ...bounds, [key]: bounds[key] + 1 }, true),
      true,
      `${key} 变化要报`,
    );
  }
});

test("该不该上报：后台标签一律不报；量不出也不报", () => {
  const bounds = { row: 1, col: 2, width: 30, height: 4 };
  assert.equal(shouldReportCustomPanelBounds(null, bounds, false), false, "后台标签不报（首次也不报）");
  assert.equal(
    shouldReportCustomPanelBounds(bounds, { ...bounds, row: 9 }, false),
    false,
    "后台标签即使尺寸变了也不报（布局不可信）",
  );
  assert.equal(shouldReportCustomPanelBounds(bounds, null, true), false, "量不出不报");
  assert.equal(shouldReportCustomPanelBounds(null, null, true), false, "从来量不出也不报");
});
