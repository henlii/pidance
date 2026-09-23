/**
 * 渲染宽度换算：像素 → 列数。抽出来测是因为它决定服务端按多少列排版，
 * 算错会让插件界面（方框/表格）在视口里对不齐。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { columnsFromPixels } = await jiti.import("./render-width.ts");

test("按字符宽换算列数", () => {
  // 8px/字符，800px → 100 列
  assert.equal(columnsFromPixels(800, 8), 100);
  // 取整（不足一列的部分丢掉，宁可窄一点不错位）
  assert.equal(columnsFromPixels(807, 8), 100);
});

test("夹到 [40, 240] —— 与服务端 SdkSessionHost.RENDER_WIDTH_* 一致", () => {
  assert.equal(columnsFromPixels(100, 8), 40, "太窄会压烂插件界面，兜到 40");
  assert.equal(columnsFromPixels(100000, 8), 240, "太宽没有意义，封到 240");
});

test("量不出（宽度或字符宽非正）时返回 null，调用方不上报", () => {
  assert.equal(columnsFromPixels(0, 8), null);
  assert.equal(columnsFromPixels(-5, 8), null);
  assert.equal(columnsFromPixels(800, 0), null);
  assert.equal(columnsFromPixels(Number.NaN, 8), null);
});
