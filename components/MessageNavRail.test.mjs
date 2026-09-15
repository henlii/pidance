import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { messageNavPreview, centeredRailScrollTop, railScrollHints, railScrollBehavior } = await jiti.import("./MessageNavRail.tsx");

// 说明：导航条改为「服务端完整大纲 + 懒加载跳转」后，节点不再由 DOM 测量得出
// （见 lib/session-outline.ts 与 MessageNavRail 的 outline 驱动）。
// 这里只保留组件自身的纯函数契约。

test("messageNavPreview：单行化并截断（aria-label 用）", () => {
  assert.equal(messageNavPreview("  多行\n文本   带空格  "), "多行 文本 带空格");
  assert.equal(messageNavPreview(""), "");
  const long = "x".repeat(200);
  assert.equal(messageNavPreview(long).length, 121);
  assert.ok(messageNavPreview(long).endsWith("…"));
});


// ---------------------------------------------------------------------------
// Bug：导航条不跟随当前项（长会话滚到靠前消息时，导航条仍停在原处）
// ---------------------------------------------------------------------------

test("centeredRailScrollTop：把当前项滚到轨道中部", () => {
  // 视口 200、内容 1000、项在内容 500 处（高 14）→ 500+7-100 = 407
  assert.equal(
    centeredRailScrollTop({ scrollTop: 0, viewportHeight: 200, contentHeight: 1000, itemTop: 500, itemHeight: 14 }),
    407,
  );
});

test("centeredRailScrollTop：首尾项夹在可滚范围内（不出现空白）", () => {
  assert.equal(
    centeredRailScrollTop({ scrollTop: 300, viewportHeight: 200, contentHeight: 1000, itemTop: 0, itemHeight: 14 }),
    0,
  );
  assert.equal(
    centeredRailScrollTop({ scrollTop: 0, viewportHeight: 200, contentHeight: 1000, itemTop: 986, itemHeight: 14 }),
    800,
  );
});

test("centeredRailScrollTop：内容未溢出时恒为 0", () => {
  assert.equal(
    centeredRailScrollTop({ scrollTop: 0, viewportHeight: 400, contentHeight: 300, itemTop: 150, itemHeight: 14 }),
    0,
  );
});

test("centeredRailScrollTop：非法输入保持当前滚动位置", () => {
  assert.equal(
    centeredRailScrollTop({ scrollTop: 42, viewportHeight: 200, contentHeight: 1000, itemTop: Number.NaN, itemHeight: 14 }),
    42,
  );
});


// ---------------------------------------------------------------------------
// 上下滚动指示器：仅在对应方向还能滚动时显示
// ---------------------------------------------------------------------------

test("railScrollHints：顶部不显示上三角，底部不显示下三角", () => {
  // 停在顶部：还能向下 → 只显示下三角
  assert.deepEqual(
    railScrollHints({ scrollTop: 0, viewportHeight: 200, contentHeight: 1000 }),
    { up: false, down: true },
  );
  // 停在底部：还能向上 → 只显示上三角
  assert.deepEqual(
    railScrollHints({ scrollTop: 800, viewportHeight: 200, contentHeight: 1000 }),
    { up: true, down: false },
  );
  // 中间：两个都显示
  assert.deepEqual(
    railScrollHints({ scrollTop: 400, viewportHeight: 200, contentHeight: 1000 }),
    { up: true, down: true },
  );
});

test("railScrollHints：内容未溢出（含刚好等高）时都不显示", () => {
  assert.deepEqual(
    railScrollHints({ scrollTop: 0, viewportHeight: 400, contentHeight: 300 }),
    { up: false, down: false },
  );
  // 等高：没有可滚范围，不得显示指示器
  assert.deepEqual(
    railScrollHints({ scrollTop: 0, viewportHeight: 300, contentHeight: 300 }),
    { up: false, down: false },
  );
});

test("railScrollHints：1px 内视为到边（小数滚动位置不闪）", () => {
  assert.deepEqual(
    railScrollHints({ scrollTop: 0.5, viewportHeight: 200, contentHeight: 1000 }),
    { up: false, down: true },
  );
  assert.deepEqual(
    railScrollHints({ scrollTop: 799.5, viewportHeight: 200, contentHeight: 1000 }),
    { up: true, down: false },
  );
});


// ---------------------------------------------------------------------------
// 平滑效果：滚动行为的选择（含 reduced-motion 降级）
// ---------------------------------------------------------------------------

test("railScrollBehavior：减少动画时一律瞬时", () => {
  // 即使位移很大（点击跳转），系统要求减少动画也不得用平滑
  assert.equal(
    railScrollBehavior({ reducedMotion: true, currentTop: 0, targetTop: 500 }),
    "auto",
  );
  assert.equal(
    railScrollBehavior({ reducedMotion: true, currentTop: 100, targetTop: 108 }),
    "auto",
  );
});

test("railScrollBehavior：大位移用平滑（跳转）", () => {
  assert.equal(
    railScrollBehavior({ reducedMotion: false, currentTop: 0, targetTop: 500 }),
    "smooth",
  );
  // 向下跳同样平滑
  assert.equal(
    railScrollBehavior({ reducedMotion: false, currentTop: 500, targetTop: 0 }),
    "smooth",
  );
});

test("railScrollBehavior：小位移瞬时（跟随聊天滚动时不发飘）", () => {
  // 每个 item 行高 18（14 + gap 4）：跟随时相邻项位移小于阈值 → 瞬时更跟手
  assert.equal(
    railScrollBehavior({ reducedMotion: false, currentTop: 0, targetTop: 18 }),
    "auto",
  );
  // 阈值边界：恰好等于 24 视为不够小 → 平滑
  assert.equal(
    railScrollBehavior({ reducedMotion: false, currentTop: 0, targetTop: 24 }),
    "smooth",
  );
  // 可自定义阈值
  assert.equal(
    railScrollBehavior({ reducedMotion: false, currentTop: 0, targetTop: 18 }, 4),
    "smooth",
  );
});
