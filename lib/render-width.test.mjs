/**
 * 渲染宽度换算：像素 → 列数。抽出来测是因为它决定服务端按多少列排版，
 * 算错会让插件界面（方框/表格）在视口里对不齐。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { columnsFromPixels, rowsFromPixels } = await jiti.import("./render-width.ts");

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

// ---------------------------------------------------------------------------
// 行数：与列数同源（同一个宿主、同一套字体度量）。行数错了的后果不是「不好看」，
// 而是按 rows 裁切的插件真把内容丢掉（裁掉的行不在输出里）。
// ---------------------------------------------------------------------------

test("按行高换算行数", () => {
  // 20px/行，800px → 40 行
  assert.equal(rowsFromPixels(800, 20), 40);
  // 取整（不足一行丢掉，宁可少一行不错位）
  assert.equal(rowsFromPixels(819, 20), 40);
});

test("夹到 [10, 200] —— 与服务端 SdkSessionHost.RENDER_ROWS_* 一致", () => {
  assert.equal(rowsFromPixels(40, 20), 10, "太矮会让插件只剩几行可显示，兜到 10");
  assert.equal(rowsFromPixels(100000, 20), 200, "太高没有意义，封到 200");
});

test("行数量不出时返回 null，调用方不上报", () => {
  assert.equal(rowsFromPixels(0, 20), null);
  assert.equal(rowsFromPixels(-5, 20), null);
  assert.equal(rowsFromPixels(800, 0), null);
  assert.equal(rowsFromPixels(Number.NaN, 20), null);
});
