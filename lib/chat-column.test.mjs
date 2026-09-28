import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  CHAT_COLUMN_WIDTH_MIN,
  CHAT_COLUMN_WIDTH_REFERENCE,
  CHAT_COLUMN_WIDTH_DEFAULT_RATIO,
  CHAT_COLUMN_WIDTH_CSS_VAR,
  CHAT_CONTENT_SIDE_GAP,
  CHAT_RESIZE_HANDLE_WIDTH,
  CHAT_SIDE_BAND,
  CHAT_COLUMN_MAX_WIDTH,
  CHAT_COLUMN_MAX_WIDTH_CSS,
  chatColumnAvailableWidth,
  clampChatColumnWidth,
  clampChatColumnRatio,
  resolveChatColumnWidth,
  maxChatColumnWidthFor,
} = await jiti.import("./chat-column.ts");

/**
 * 会话区实际显示宽度 = AppShell 里那两步的组合：先按设定值解析，再被「可用宽度 − 两侧带宽」封顶。
 * 这里复刻同一口径，避免测试只测一半而漏掉「先缩空白再缩会话区」这条要求。
 */
const applied = (stored, available) =>
  Math.min(resolveChatColumnWidth({ availableWidth: available, ratio: stored }), maxChatColumnWidthFor(available));

test("宽度模型：下限 600、参照宽度 1600、默认比例 5/6，固定上限已取消", () => {
  assert.equal(CHAT_COLUMN_WIDTH_MIN, 600);
  assert.equal(CHAT_COLUMN_WIDTH_REFERENCE, 1600);
  assert.ok(Math.abs(CHAT_COLUMN_WIDTH_DEFAULT_RATIO - 5 / 6) < 1e-9);
  // 上限由窗口可用宽度决定（见 maxChatColumnWidthFor），固定常量不再存在
});

test("设定值是像素：窗口变化不改写它（窗口回来就恢复原宽度）", () => {
  // 用户例子：中间区 2000 时把会话区拖到 1500 → 中间区缩到 1000 只是显示受限，设定仍是 1500
  assert.equal(resolveChatColumnWidth({ availableWidth: 2400, ratio: 1500 }), 1500);
  assert.equal(resolveChatColumnWidth({ availableWidth: 1000, ratio: 1500 }), 1500);
  assert.equal(resolveChatColumnWidth({ availableWidth: 2400, ratio: 1500 }), 1500);
});

test("空间不足时先缩两侧空白，空白吃完才缩会话区（每侧带宽 22）", () => {
  assert.equal(CHAT_SIDE_BAND, CHAT_RESIZE_HANDLE_WIDTH + CHAT_CONTENT_SIDE_GAP);
  assert.equal(CHAT_SIDE_BAND, 22);
  // 可用 1200：设定 1000 完整放得下（上限 1156）→ 显示 1000，两侧空白 200
  assert.equal(applied(1000, 1200), 1000);
  // 可用 1044：正好到边界 → 显示 1000，空白归零
  assert.equal(applied(1000, 1044), 1000);
  // 再小就跟着缩（空白已经为零）：1044 → 1000-44 = 956
  assert.equal(applied(1000, 1000), 956);
  // 极窄：上限趋零，但不为负
  assert.equal(maxChatColumnWidthFor(0), CHAT_COLUMN_WIDTH_REFERENCE);
  assert.equal(maxChatColumnWidthFor(30), 0);
});

test("旧比例存储按当前可用宽度换算一次（用户设置不丢）", () => {
  // 遗留的 5/6 → 1920 可用宽度下算成 1600 px
  assert.equal(resolveChatColumnWidth({ availableWidth: 1920, ratio: 5 / 6 }), 1600);
  // 已经迁移过的像素值原样保留（> 1 视作像素）
  assert.equal(resolveChatColumnWidth({ availableWidth: 1920, ratio: 1400 }), 1400);
});

test("可用宽度换算：容器宽扣掉两侧竖条（桌面 18 / 移动 16）", () => {
  assert.equal(chatColumnAvailableWidth(936, false), 900);
  assert.equal(chatColumnAvailableWidth(390, true), 358);
  assert.equal(chatColumnAvailableWidth(0, false), 0);
  assert.equal(chatColumnAvailableWidth(Number.NaN, false), 0);
});

test("越界与脏数据：像素只夹下限 600，非法值回落参照宽度；比例仍夹 [0.2, 1]", () => {
  assert.equal(clampChatColumnWidth(50), CHAT_COLUMN_WIDTH_MIN);
  assert.equal(clampChatColumnWidth(99999), 99999, "上限已取消，只受窗口限制");
  assert.equal(clampChatColumnWidth("x"), CHAT_COLUMN_WIDTH_REFERENCE);
  assert.equal(clampChatColumnWidth(Number.NaN), CHAT_COLUMN_WIDTH_REFERENCE);
  assert.equal(clampChatColumnRatio(0), CHAT_COLUMN_WIDTH_DEFAULT_RATIO);
  assert.equal(clampChatColumnRatio(-1), CHAT_COLUMN_WIDTH_DEFAULT_RATIO);
  assert.equal(clampChatColumnRatio(5), 1);
  assert.equal(clampChatColumnRatio(undefined), CHAT_COLUMN_WIDTH_DEFAULT_RATIO);
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
  // 兜底表达式：变量缺省 = 兜底上限，再由 100% 兜住窄窗口
  assert.ok(CHAT_COLUMN_MAX_WIDTH_CSS.includes(`${CHAT_COLUMN_MAX_WIDTH}px`));
  assert.ok(CHAT_COLUMN_MAX_WIDTH_CSS.includes("100%"));
});

test("把手契约：role=separator + aria 值 + 双击复位 + 过窄不渲染", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const shell = readFileSync(fileURLToPath(new URL("../components/AppShell.tsx", import.meta.url)), "utf8");
  assert.ok(shell.includes('role="separator"'));
  // 宽度是取整后的像素；上限报的是「可用宽度」，与显示宽度是两个量
  assert.ok(shell.includes("aria-valuenow={Math.round(chatColumnWidth)}"));
  assert.ok(shell.includes("aria-valuemin={CHAT_COLUMN_WIDTH_MIN}"));
  assert.ok(shell.includes("aria-valuemax={Math.round(chatColumnAvailable)}"));
  assert.ok(shell.includes("onDoubleClick={handleChatColumnResizeReset}"));
  assert.ok(shell.includes("setPointerCapture"), "拖拽应使用 pointer capture（与侧栏一致）");
  // 移动端不渲染把手，且会话区比可调下限还窄时也不渲染
  assert.ok(shell.includes("!isMobile"));
  assert.ok(shell.includes("CHAT_SIDE_BAND * 2"), "过窄判据应基于带宽");
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
