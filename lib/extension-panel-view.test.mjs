import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  isBorderRow,
  isHeadingRow,
  detectPanelOptionList,
  buildPanelView,
  shouldRenderPanelWebView,
  optionStepKeys,
  planOptionClick,
  verifyOptionCursor,
} = await jiti.import("./extension-panel-view.ts");

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const BG = "\x1b[48;2;60;60;90m";

/** 仿 ask-user 问卷：边框 + 标题 + 两个选项（❯ 在第一项） */
const questionnaire = [
  "┌──────────────────────┐",
  `│ ${BOLD}水果${RESET}                 │`,
  "│                      │",
  `│ ❯ 1. 苹果${RESET}            │`,
  "│   2. 香蕉            │",
  "└──────────────────────┘",
];

test("边框行识别：整行制表符才算，混了文字就不算", () => {
  assert.equal(isBorderRow("┌──────────┐"), true);
  assert.equal(isBorderRow("├──┼──┤"), true);
  assert.equal(isBorderRow("│ 1. 苹果  │"), false, "含文字的框线行不是边框行");
  assert.equal(isBorderRow(""), false);
  assert.equal(isBorderRow("   "), false);
  assert.equal(isBorderRow("普通文本"), false);
});

test("标题行识别：加粗且短；长加粗行与边框行不算", () => {
  assert.equal(isHeadingRow(`${BOLD}水果${RESET}`), true);
  assert.equal(isHeadingRow(`${BOLD}${"很长的标题".repeat(12)}${RESET}`), false);
  assert.equal(isHeadingRow("水果"), false, "没加粗就不是标题");
  assert.equal(isHeadingRow(`${BOLD}──────${RESET}`), false);
});

test("选项识别（带框线）：有边框行就整块不猜", () => {
  // 问卷是「框里放选项」，按保守规则这里判否 —— 交给原样渲染，宁可不识别
  assert.equal(detectPanelOptionList(questionnaire), null);
});

test("选项识别（无框线）：编号 + 恰好一个 ❯ 光标 → 识别成列表", () => {
  const lines = ["请选择一项", "❯ 1. 苹果", "  2. 香蕉", "  3. 梨"];
  const list = detectPanelOptionList(lines);
  assert.ok(list, "应识别出选项列表");
  assert.equal(list.items.length, 3);
  assert.deepEqual(list.items.map((i) => i.label), ["1. 苹果", "2. 香蕉", "3. 梨"]);
  assert.deepEqual(list.items.map((i) => i.cursor), [true, false, false]);
  assert.equal(list.cursorIndex, 0);
});

test("选项识别：反显光标（无 ❯）也能认出当前项", () => {
  const lines = ["请选择", `${BG}1. 苹果${RESET}`, "2. 香蕉"];
  const list = detectPanelOptionList(lines);
  assert.ok(list, "背景色光标也应识别");
  assert.equal(list.cursorIndex, 0);
});

test("不猜的情况：没有光标、只有一个候选、缩进不齐、含边框 → 一律 null", () => {
  assert.equal(detectPanelOptionList(["1. 苹果", "2. 香蕉"]), null, "没有光标标记");
  assert.equal(detectPanelOptionList(["❯ 1. 苹果"]), null, "只有一项");
  assert.equal(detectPanelOptionList(["❯ 1. 苹果", "      2. 香蕉"]), null, "缩进差异过大");
  assert.equal(detectPanelOptionList(["┌────┐", "❯ 1. 苹果", "  2. 香蕉"]), null, "含边框");
});

test("像表格的面板按原样渲染：不能被当成选项列表", () => {
  const table = ["名称    数量    单价", "苹果    2       3.5", "香蕉    1       2.0"];
  assert.equal(detectPanelOptionList(table), null);
  assert.equal(shouldRenderPanelWebView(buildPanelView(table)), false, "纯正文不换样式");
});

test("块切分保持原文顺序与行数（内容一行不少）", () => {
  const view = buildPanelView(["标题行", "┌──┐", "正文 A", "正文 B", "└──┘"]);
  assert.deepEqual(view.blocks.map((b) => b.kind), ["text", "border", "text", "border"]);
  const flat = view.blocks.flatMap((b) => b.plainLines);
  assert.equal(flat.length, 5);
  assert.deepEqual(flat, ["标题行", "┌──┐", "正文 A", "正文 B", "└──┘"]);
});

test("网页化开关：识别出选项/标题/边框才换样式", () => {
  assert.equal(shouldRenderPanelWebView(buildPanelView(["❯ 1. 甲", "  2. 乙"])), true);
  assert.equal(shouldRenderPanelWebView(buildPanelView(["┌──┐", "└──┘"])), true);
  assert.equal(shouldRenderPanelWebView(buildPanelView([`${BOLD}标题${RESET}`, "正文"])), true);
  assert.equal(shouldRenderPanelWebView(buildPanelView(["正文一", "正文二"])), false);
});

test("合成按键步数：向下的差值、向上的差值、无位移时返回空数组", () => {
  assert.deepEqual(optionStepKeys(0, 2, 3), ["\x1b[B", "\x1b[B"]);
  assert.deepEqual(optionStepKeys(2, 0, 3), ["\x1b[A", "\x1b[A"]);
  assert.deepEqual(optionStepKeys(1, 1, 3), []);
  // 越界/非法一律 null（调用方按原样处理，不乱按键）
  assert.equal(optionStepKeys(0, 5, 3), null);
  assert.equal(optionStepKeys(-1, 1, 3), null);
  assert.equal(optionStepKeys(0, 1, 1), null);
});

test("点击自校验：面板在发键前没变 → 按差值发方向键", () => {
  const seen = ["请选择", "❯ 1. 甲", "  2. 乙", "  3. 丙"];
  const plan = planOptionClick(seen, seen, 2);
  assert.equal(plan.kind, "send");
  assert.deepEqual(plan.keys, ["\x1b[B", "\x1b[B"]);
});

test("点击自校验：面板重渲染过（选项变了）→ 让位，不按键", () => {
  const seen = ["请选择", "❯ 1. 甲", "  2. 乙"];
  const changed = ["请选择", "❯ 1. 甲", "  2. 丙"];
  const plan = planOptionClick(seen, changed, 1);
  assert.equal(plan.kind, "give-up");
  assert.deepEqual(plan.keys, []);
  assert.equal(planOptionClick(seen, ["请选择", "❯ 1. 甲"], 0).kind, "give-up");
  assert.equal(planOptionClick(seen, ["表格  A  B"], 0).kind, "give-up");
});

test("发完方向键后确认光标到位才允许回车", () => {
  const moved = ["请选择", "  1. 甲", "❯ 2. 乙"];
  assert.equal(verifyOptionCursor(moved, 1), true);
  assert.equal(verifyOptionCursor(moved, 0), false, "光标没到目标项时不得确认");
  assert.equal(verifyOptionCursor(["没有列表"], 0), false);
});
