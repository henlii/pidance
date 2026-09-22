import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { messageNavPreview, centeredRailScrollTop, railFollowPlan, railScrollHints, railScrollBehavior, easeInOutCubic, RAIL_SCROLL_DURATION_MS, railListLayout } = await jiti.import("./MessageNavRail.tsx");

// 说明：导航条改为「服务端完整大纲 + 懒加载跳转」后，节点不再由 DOM 测量得出
// （见 lib/session-outline.ts 与 MessageNavRail 的 outline 驱动）。
// 这里只保留组件自身的纯函数契约。

// ---------------------------------------------------------------------------
// 用户反馈：进长会话时「导航条选中的不是最下面的」—— 旧版整条居中、限高 320px，
// 贴底时当前横线落在屏幕中部，看不出「当前在哪」与「会话到哪」的关系。
// 改为：能排开就铺满轨道（位置对应提问先后），排不下才退回旧行为。
// ---------------------------------------------------------------------------

test("railListLayout：能排开时铺满轨道，贴底时最后一条在最下面", () => {
  const layout = railListLayout({ count: 52, availableHeight: 729 });
  assert.equal(layout.mode, "spread");
  // 52 格均分 729px：格子首尾相接正好排满，末格底边落在轨道底部
  assert.ok(Math.abs(layout.pitch - 729 / 52) < 1e-9);
  assert.equal(52 * layout.pitch, layout.height, "格子必须正好排满整条轨道");
  const lastTop = (52 - 1) * layout.pitch;
  assert.ok(lastTop + layout.pitch === layout.height, "最后一条的底边 = 轨道底部");
});

test("railListLayout：数量多到行距不足时退回限高滚动（旧行为）", () => {
  // 729 / 8px 每格 ≈ 91 条为上限；再密就点不中，退回内部滚动
  assert.equal(railListLayout({ count: 90, availableHeight: 729 }).mode, "spread");
  assert.equal(railListLayout({ count: 92, availableHeight: 729 }).mode, "scroll");
  assert.equal(railListLayout({ count: 200, availableHeight: 729 }).mode, "scroll");
  assert.equal(railListLayout({ count: 500, availableHeight: 729 }).mode, "scroll");
});

test("railListLayout：单条与无可用高度都退回旧行为（居中/不铺）", () => {
  assert.equal(railListLayout({ count: 1, availableHeight: 729 }).mode, "scroll");
  assert.equal(railListLayout({ count: 0, availableHeight: 729 }).mode, "scroll");
  assert.equal(railListLayout({ count: 52, availableHeight: 0 }).mode, "scroll");
  assert.equal(railListLayout({ count: 52, availableHeight: Number.NaN }).mode, "scroll");
});

test("源码契约：铺满模式用 space-between 且不再限高，退回模式才允许内部滚动", () => {
  const source = readFileSync(fileURLToPath(new URL("./MessageNavRail.tsx", import.meta.url)), "utf8");
  assert.match(source, /justifyContent: spreading \? "space-between"/);
  assert.match(source, /gap: spreading \? 0 : DASH_GAP/);
  assert.match(source, /height: spreading \? listLayout\.pitch : 14/);
  assert.match(source, /overflowY: spreading \? "visible" : "auto"/);
  assert.match(source, /maxHeight: spreading \? undefined : `min\(\$\{LIST_MAX_HEIGHT_PX\}px, 100%\)`/);
});

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
// Bug：导航条不跟随当前项 —— 首帧未布局/格子未挂载时再也不补测
// ---------------------------------------------------------------------------

test("railFollowPlan：没有当前项不动，未布局或格子未挂载则下一帧补测", () => {
  assert.equal(
    railFollowPlan({ hasActive: false, hasItem: false, clientHeight: 0, contentHeight: 0 }),
    "skip",
  );
  // 格子还没挂上（大纲刚换、列表同帧重建）
  assert.equal(
    railFollowPlan({ hasActive: true, hasItem: false, clientHeight: 320, contentHeight: 1076 }),
    "retry",
  );
  // 首帧还没布局：clientHeight 为 0，此时算出的目标是错的
  assert.equal(
    railFollowPlan({ hasActive: true, hasItem: true, clientHeight: 0, contentHeight: 0 }),
    "retry",
  );
  assert.equal(
    railFollowPlan({ hasActive: true, hasItem: true, clientHeight: 320, contentHeight: 1076 }),
    "scroll",
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


// ---------------------------------------------------------------------------
// 平滑动画：自控时长与缓动（原生 smooth 时长不可调且偏快，用户反馈“有点快”）
// ---------------------------------------------------------------------------

test("easeInOutCubic：端点与中点固定，且单调不减", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  let previous = -1;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const value = easeInOutCubic(t);
    assert.ok(value >= previous, `t=${t.toFixed(2)} 处应单调不减`);
    previous = value;
  }
});

test("easeInOutCubic：越界输入被夹到 [0,1]", () => {
  assert.equal(easeInOutCubic(-1), 0);
  assert.equal(easeInOutCubic(2), 1);
});

test("easeInOutCubic：两端比线性慢（缓入缓出，不是机械线性）", () => {
  // 前 10% 只走不到 1% 的距离：起步柔和
  assert.ok(easeInOutCubic(0.1) < 0.1, "起步应慢于线性");
  // 后 10% 同理
  assert.ok(easeInOutCubic(0.9) > 0.9, "收尾应慢于线性");
});

test("RAIL_SCROLL_DURATION_MS：明显慢于浏览器原生 smooth（用户反馈偏快）", () => {
  assert.ok(RAIL_SCROLL_DURATION_MS >= 350, `期望 >= 350ms，实际 ${RAIL_SCROLL_DURATION_MS}`);
});
