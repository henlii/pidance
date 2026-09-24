import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  CHAT_COLUMN_WIDTH_MIN,
  CHAT_COLUMN_WIDTH_MAX,
  CHAT_COLUMN_WIDTH_DEFAULT_RATIO,
  CHAT_COLUMN_WIDTH_CSS_VAR,
  CHAT_COLUMN_MAX_WIDTH,
  CHAT_COLUMN_MAX_WIDTH_CSS,
  chatColumnAvailableWidth,
  clampChatColumnWidth,
  clampChatColumnRatio,
  resolveChatColumnWidth,
  chatColumnRatioFromWidth,
} = await jiti.import("./chat-column.ts");

const at = (availableWidth, ratio = CHAT_COLUMN_WIDTH_DEFAULT_RATIO) => resolveChatColumnWidth({ availableWidth, ratio });

test("宽度模型：可用宽度 1920 恰好落在上限 1600（默认比例 5/6）", () => {
  assert.equal(CHAT_COLUMN_WIDTH_MAX, 1600);
  assert.equal(CHAT_COLUMN_WIDTH_MIN, 1000);
  assert.equal(at(1920), 1600);
});

test("宽度模型：可用宽度放大到 3840 后内容不再变宽（只长两侧空白）", () => {
  assert.equal(at(2400), CHAT_COLUMN_WIDTH_MAX);
  assert.equal(at(3840), CHAT_COLUMN_WIDTH_MAX);
  // 空白随可用宽度线性增长：1920 → 320、3840 → 2240（合计）
  assert.equal((3840 - at(3840)) / 2, 1120);
});

test("宽度模型：可用宽度 1920 → 1200 内容与空白等比例缩小", () => {
  // 1200 × 5/6 = 1000，正好落在下限；两侧空白合计 1200 - 1000 = 200
  assert.equal(at(1200), 1000);
  assert.equal(at(1800), 1500);
});

test("宽度模型：可用宽度 1200 → 1000 只缩两侧空白（内容固定 1000）", () => {
  assert.equal(at(1100), 1000);
  assert.equal(at(1000), 1000);
  // 到 1000 时空白归零
  assert.equal(1000 - at(1000), 0);
});

test("宽度模型：空白归零后再缩小，内容跟着缩（由 CSS 的 100% 兜住）", () => {
  // JS 侧仍给下限 1000；真实收窄由 max-width 里的 min(var, 100%) 完成
  assert.equal(at(800), 1000);
  assert.ok(CHAT_COLUMN_MAX_WIDTH_CSS.includes("100%"), "兜底表达式必须带 100%");
  assert.ok(CHAT_COLUMN_MAX_WIDTH_CSS.includes(`${CHAT_COLUMN_MAX_WIDTH}px`), "变量缺省值应为兜底上限");
});

test("可用宽度换算：容器宽扣掉两侧竖条（桌面 18 / 移动 16）", () => {
  assert.equal(chatColumnAvailableWidth(936, false), 900);
  assert.equal(chatColumnAvailableWidth(390, true), 358);
  assert.equal(chatColumnAvailableWidth(0, false), 0);
  assert.equal(chatColumnAvailableWidth(Number.NaN, false), 0);
});

test("比例是唯一持久量：像素宽度可反推回同一比例（往返一致）", () => {
  const ratio = chatColumnRatioFromWidth({ width: 1400, availableWidth: 2100 });
  assert.ok(Math.abs(ratio - 1400 / 2100) < 1e-9);
  assert.equal(resolveChatColumnWidth({ availableWidth: 2100, ratio }), 1400);
  // 窗口变了，同一比例给出成比例的新宽度（自适应）
  assert.equal(resolveChatColumnWidth({ availableWidth: 1050, ratio: 1400 / 2100 }), CHAT_COLUMN_WIDTH_MIN);
});

test("越界与脏数据：宽度夹到 [1000, 1600]，比例夹到 [0.2, 1] 且非法值回落默认", () => {
  assert.equal(clampChatColumnWidth(50), 1000);
  assert.equal(clampChatColumnWidth(99999), 1600);
  assert.equal(clampChatColumnWidth("x"), 1600);
  assert.equal(clampChatColumnWidth(Number.NaN), 1600);
  assert.equal(clampChatColumnRatio(0), CHAT_COLUMN_WIDTH_DEFAULT_RATIO);
  assert.equal(clampChatColumnRatio(-1), CHAT_COLUMN_WIDTH_DEFAULT_RATIO);
  assert.equal(clampChatColumnRatio(5), 1);
  assert.equal(clampChatColumnRatio(undefined), CHAT_COLUMN_WIDTH_DEFAULT_RATIO);
  assert.equal(resolveChatColumnWidth({ availableWidth: 0, ratio: 0.5 }), CHAT_COLUMN_WIDTH_MAX);
});

test("CSS 契约：一处变量名 + 同宽区域共用同一表达式", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
  assert.equal(CHAT_COLUMN_WIDTH_CSS_VAR, "--pidance-chat-column-width");
  // 变量只在 AppShell 写一次
  const shell = read("../components/AppShell.tsx");
  const assignments = shell.match(/\[CHAT_COLUMN_WIDTH_CSS_VAR\]:/g) ?? [];
  assert.equal(assignments.length, 1, "变量应只在 AppShell 设置一处");
  // 同宽区域都用同一表达式，不再各写常量
  for (const file of ["../components/ChatWindow.tsx", "../components/ChatInput.tsx", "../components/ExtensionPanelChrome.tsx"]) {
    const src = read(file);
    assert.ok(src.includes("CHAT_COLUMN_MAX_WIDTH_CSS"), `${file} 应使用共享宽度表达式`);
    assert.ok(!/maxWidth: CHAT_COLUMN_MAX_WIDTH\b(?!_)/.test(src), `${file} 不应再写死常量宽度`);
  }
});

test("把手契约：role=separator + aria-valuenow + 双击回默认（与侧栏同一套）", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const shell = readFileSync(fileURLToPath(new URL("../components/AppShell.tsx", import.meta.url)), "utf8");
  assert.ok(shell.includes('role="separator"'));
  assert.ok(shell.includes("aria-valuenow={chatColumnWidth}"));
  assert.ok(shell.includes("onDoubleClick={handleChatColumnResizeReset}"));
  assert.ok(shell.includes("setPointerCapture"), "拖拽应使用 pointer capture（与侧栏一致）");
  // 移动端不渲染把手
  assert.ok(shell.includes("{showChat && !isMobile && ("));
});

test("思考块展开态不限高：THINKING_BODY_STYLE 不带 maxHeight / 内部滚动", async () => {
  const jiti2 = createJiti(import.meta.url, { tsconfigPaths: true });
  const { THINKING_BODY_STYLE, CHAT_BLOCK_MAX_HEIGHT, CHAT_BLOCK_MAX_HEIGHT_MOBILE } = await jiti2.import("./chat-column.ts");

  // 用户 2026-09-24 决定：思考块展开按内容自然展开，超长思考把输入区推远是接受的代价。
  assert.equal(THINKING_BODY_STYLE.maxHeight, undefined);
  assert.equal(THINKING_BODY_STYLE.overflow, undefined);
  assert.equal(THINKING_BODY_STYLE.overflowY, undefined);
  assert.equal(THINKING_BODY_STYLE.whiteSpace, "pre-wrap");
  // 解除内滚后，卡片外壳仍是 overflow:hidden：超长无空格行必须能在正文内折行，
  // 否则会被裁切且无法横滑（审查指出）。
  assert.equal(THINKING_BODY_STYLE.overflowWrap, "anywhere");

  // 工具输出与扩展 widget 的共享限高保持不变
  assert.equal(CHAT_BLOCK_MAX_HEIGHT, "min(320px, 45vh)");
  assert.equal(CHAT_BLOCK_MAX_HEIGHT_MOBILE, "min(240px, 32vh)");
});
