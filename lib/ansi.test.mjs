import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./ansi.ts");
}

test("strips ANSI escape sequences", async () => {
  const { stripAnsi } = await loadSubject();

  assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
  assert.equal(stripAnsi("answer\x1b_pi:c\x07"), "answer");
});

test("normalizes boxed custom panel lines while preserving ANSI codes", async () => {
  const { normalizeCustomPanelLines, stripAnsi } = await loadSubject();
  const lines = [
    "┌──────┐",
    "│ \x1b[32mOK\x1b[0m   │",
    "└──────┘",
  ];

  const normalized = normalizeCustomPanelLines(lines);

  assert.equal(normalized.length, 1);
  assert.equal(stripAnsi(normalized[0]), "OK");
  assert.match(normalized[0], /\x1b\[32m/);
});

test("/btw custom 面板缺 lines 时不得抛错（页面崩溃回归）", async () => {
  const { normalizeCustomPanelLines } = await loadSubject();
  assert.deepEqual(normalizeCustomPanelLines(undefined), []);
  assert.deepEqual(normalizeCustomPanelLines(null), []);
  assert.deepEqual(normalizeCustomPanelLines([1, "ok"]), ["ok"]);
});

test("removes pi-tui cursor markers from custom panel output", async () => {
  const { normalizeCustomPanelLines } = await loadSubject();

  assert.deepEqual(normalizeCustomPanelLines(["> value\x1b_pi:c\x07"]), ["> value"]);
});

test("parses ANSI style segments and reset codes", async () => {
  const { parseAnsiLine } = await loadSubject();

  assert.deepEqual(parseAnsiLine("\x1b[31;1mhot\x1b[0m cold"), [
    { text: "hot", style: { color: "#dc2626", fontWeight: 700 } },
    { text: " cold", style: {} },
  ]);
});

test("maps 256-color SGR codes", async () => {
  const { ansi256Color, parseAnsiLine } = await loadSubject();

  assert.equal(ansi256Color(196), "rgb(255, 0, 0)");
  assert.deepEqual(parseAnsiLine("\x1b[38;5;196mred"), [
    { text: "red", style: { color: "rgb(255, 0, 0)" } },
  ]);
});

// issue #104 审查 P0-3：归一化会删行，所以必须能给出「这行来自原文哪一行」的映射，
// 并且能保护图片锚点（摘图后它是空行，被裁掉图就静默消失）。
test("#104 归一化带索引映射：删掉框线后行号跟着前移", async () => {
  const { normalizeCustomPanelLinesWithIndex } = await loadSubject();
  const result = normalizeCustomPanelLinesWithIndex(["┌───┐", "│ hi │", "└───┘"]);
  assert.deepEqual(result.lines, ["hi"], "框线被删、左右竖边被剥掉");
  assert.deepEqual(result.sourceIndex, [1], "剩下这行来自原文第 1 行");
});

test("#104 归一化：keep 保护的空行不会被首尾裁剪丢掉", async () => {
  const { normalizeCustomPanelLinesWithIndex } = await loadSubject();
  const result = normalizeCustomPanelLinesWithIndex(["标题", "", ""], { keep: new Set([1]) });
  assert.deepEqual(result.lines, ["标题", ""], "第 1 行是图片锚点必须留下；末尾那行仍可裁");
  assert.deepEqual(result.sourceIndex, [0, 1]);
});

test("#104 归一化：没有 keep 时保持旧行为（裁首尾空白行）", async () => {
  const { normalizeCustomPanelLinesWithIndex } = await loadSubject();
  const result = normalizeCustomPanelLinesWithIndex(["标题", "", ""]);
  assert.deepEqual(result.lines, ["标题"]);
  assert.deepEqual(result.sourceIndex, [0]);
});

test("#104 归一化：全空时退回原文，索引是恒等映射", async () => {
  const { normalizeCustomPanelLinesWithIndex } = await loadSubject();
  const result = normalizeCustomPanelLinesWithIndex(["", "  "]);
  assert.deepEqual(result.lines, ["", "  "], "旧行为：全空退回原文");
  assert.deepEqual(result.sourceIndex, [0, 1]);
});
