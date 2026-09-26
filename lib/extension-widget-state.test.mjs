/**
 * widget 状态两步纯逻辑（issue #104 审查 P0-2）。
 *
 * 核心约定：**字段缺省 = 沿用表里已有的**，**显式空数组 = 清空**。
 * 适配器图片没变时会把 `widgetImages` 省略掉，所以镜像写与投影都不能把它当「没了」——
 * 否则图会在对账/刷新之后消失，只剩被摘空的那一行（文本侧的序列已经摘走了）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { mergeWidgetFrame, projectWidgetEntries } = await jiti.import("./extension-widget-state.ts");

const image = (id) => ({ id, mime: "image/png", base64: "AAAA", cols: 4, rows: 2, lineIndex: 0 });
const fallback = (lineIndex) => ({ lineIndex, reason: "unsupported-format", text: "[image]" });

test("缺省字段沿用表里已有的 images / imageFallbacks（不能当成清空）", () => {
  const previous = { lines: ["旧"], images: [image("a")], imageFallbacks: [fallback(1)], interactive: true };
  const merged = mergeWidgetFrame(previous, { lines: ["新"] });
  assert.deepEqual(merged?.lines, ["新"]);
  assert.deepEqual(merged?.images, [image("a")], "缺省必须沿用上一帧的图");
  assert.deepEqual(merged?.imageFallbacks, [fallback(1)]);
  // interactive 每帧都带（适配器保证），所以缺省时按「没有」处理（不是沿用）
  assert.equal(merged?.interactive, false);
});

test("显式空数组 = 清空（图真的没了）", () => {
  const previous = { lines: ["旧"], images: [image("a")] };
  const merged = mergeWidgetFrame(previous, { lines: ["新"], images: [] });
  assert.deepEqual(merged?.images, [], "显式空数组要清掉");
});

test("显式新数组 = 换成新的", () => {
  const previous = { lines: ["旧"], images: [image("a")] };
  const merged = mergeWidgetFrame(previous, { lines: ["新"], images: [image("b")] });
  assert.deepEqual(merged?.images, [image("b")]);
});

test("lines 为空 = 删除该 widget", () => {
  assert.equal(mergeWidgetFrame({ lines: ["旧"], images: [image("a")] }, { lines: null }), null);
  assert.equal(mergeWidgetFrame(undefined, { lines: undefined }), null);
});

test("没有上一帧时缺省就是没有（不会凭空造出图或 interactive）", () => {
  const merged = mergeWidgetFrame(undefined, { lines: ["新"] });
  assert.equal(merged?.images, undefined);
  assert.equal(merged?.imageFallbacks, undefined);
  assert.equal(merged?.interactive, false);
});

test("投影带上 images / imageFallbacks，非法形状退成空数组", () => {
  const projected = projectWidgetEntries([
    ["a", { lines: ["l1"], images: [image("a")], imageFallbacks: [fallback(0)], placement: "belowEditor", interactive: true }],
    ["b", { lines: "不是数组", images: "坏", imageFallbacks: null }],
    ["c", null],
  ]);
  assert.deepEqual(projected[0], {
    key: "a",
    lines: ["l1"],
    images: [image("a")],
    imageFallbacks: [fallback(0)],
    placement: "belowEditor",
    interactive: true,
  });
  assert.deepEqual(projected[1], {
    key: "b",
    lines: [],
    images: [],
    imageFallbacks: [],
    placement: "aboveEditor",
    interactive: false,
  });
  assert.deepEqual(projected[2]?.images, [], "null 条目也要给出可用的空数组");
});

test("投影与镜像写串起来：第二帧省略图片时，投影里仍然有图（P0-2 的回归点）", () => {
  const table = new Map();
  const first = { lines: ["标题", ""], images: [image("a")], placement: "aboveEditor", interactive: false };
  table.set("w", mergeWidgetFrame(table.get("w"), first));
  // 第二帧：适配器图片没变 → 省略 widgetImages（几百 KB 不能每帧重发）
  table.set("w", mergeWidgetFrame(table.get("w"), { lines: ["标题", ""] }));
  const projected = projectWidgetEntries(table.entries());
  assert.equal(projected.length, 1);
  assert.equal(projected[0].images.length, 1, "省略字段的那一帧之后，图必须还在");
  assert.deepEqual(projected[0].images, [image("a")]);
});
