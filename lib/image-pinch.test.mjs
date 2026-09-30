// 图片查看器的双指缩放：按两指间距比例变倍、夹在上下限内、坏基线不跳变。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { pinchZoom } = await jiti.import("../lib/image-pinch.ts");

test("捏合按两指间距的比例变倍（不是按绝对位移）", () => {
  assert.equal(pinchZoom({ distance: 100, zoom: 1 }, 200, 1, 8), 2, "间距翻倍 → 倍数翻倍");
  assert.equal(pinchZoom({ distance: 200, zoom: 2 }, 100, 1, 8), 1, "间距减半 → 倍数减半");
  // 同样的移动量（+50px），起点间距越小时放得越大 —— 这正是「按比例」的含义
  assert.ok(
    pinchZoom({ distance: 50, zoom: 1 }, 100, 1, 8) > pinchZoom({ distance: 200, zoom: 1 }, 250, 1, 8),
    "间距越小，同样位移应放大得越多",
  );
});

test("捏合倍数夹在上下限内，坏基线不跳变", () => {
  assert.equal(pinchZoom({ distance: 100, zoom: 4 }, 1000, 1, 8), 8, "超过上限时夹到上限");
  assert.equal(pinchZoom({ distance: 100, zoom: 1 }, 1, 1, 8), 1, "低于下限时夹到下限");
  assert.equal(pinchZoom({ distance: 0, zoom: 2 }, 100, 1, 8), 2, "零间距基线应原样返回");
  assert.equal(pinchZoom({ distance: -5, zoom: 2 }, 100, 1, 8), 2, "负间距基线应原样返回");
  assert.equal(pinchZoom({ distance: 100, zoom: 2 }, Number.NaN, 1, 8), 2, "NaN 间距应原样返回");
});
