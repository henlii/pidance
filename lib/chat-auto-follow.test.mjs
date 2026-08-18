import assert from "node:assert/strict";
import test from "node:test";
import {
  ENTRY_STICK_MAX_MS,
  ENTRY_STICK_QUIET_MS,
  MIN_OVERFLOW_FOR_JUMP_BUTTON_PX,
  canNestedScrollerConsumeUp,
  MOBILE_REAL_BOTTOM_TOLERANCE_PX,
  MOBILE_TOUCH_UP_INTENT_PX,
  REAL_BOTTOM_TOLERANCE_PX,
  TOUCH_UP_INTENT_PX,
  getBottomSpacerHeight,
  getBottomZoneSize,
  getDistanceFromBottom,
  getRealBottomTolerance,
  getScrollDirection,
  getTouchUpIntentThreshold,
  isAtRealBottom,
  isEntryStickActive,
  isLayoutDrivenScroll,
  reduceAutoFollow,
  shouldShowJumpButton,
} from "./chat-auto-follow.ts";

test("getDistanceFromBottom：基本几何与负值钳位", () => {
  assert.equal(getDistanceFromBottom(1000, 500, 300), 200);
  assert.equal(getDistanceFromBottom(1000, 700, 300), 0);
  // scrollTop 超过最大值（竞争写入）时钳到 0，不出现负距离
  assert.equal(getDistanceFromBottom(1000, 900, 300), 0);
  // 无溢出时距离为 0
  assert.equal(getDistanceFromBottom(300, 0, 300), 0);
});

test("getBottomZoneSize：桌面 max(48, 10% 视口)，移动 40", () => {
  assert.equal(getBottomZoneSize(300, false), 48); // 10% = 30，取下限 48
  assert.equal(getBottomZoneSize(480, false), 48); // 恰好在下限
  assert.equal(getBottomZoneSize(900, false), 90);
  assert.equal(getBottomZoneSize(900, true), 40);
  assert.equal(getBottomZoneSize(300, true), 40);
});

test("getBottomSpacerHeight：与 CSS 公式一致（桌面 10vh / 移动 40）", () => {
  assert.equal(getBottomSpacerHeight(900, false), 90);
  assert.equal(getBottomSpacerHeight(437, false), 44);
  assert.equal(getBottomSpacerHeight(900, true), 40);
});

test("isAtRealBottom：默认 1px 容差，可覆盖", () => {
  assert.equal(isAtRealBottom(0), true);
  assert.equal(isAtRealBottom(0.5), true);
  assert.equal(isAtRealBottom(1), true);
  assert.equal(isAtRealBottom(1.5), false);
  assert.equal(isAtRealBottom(10, MOBILE_REAL_BOTTOM_TOLERANCE_PX), true);
  assert.equal(isAtRealBottom(16, MOBILE_REAL_BOTTOM_TOLERANCE_PX), true);
  assert.equal(isAtRealBottom(16.5, MOBILE_REAL_BOTTOM_TOLERANCE_PX), false);
});

test("getRealBottomTolerance / getTouchUpIntentThreshold：移动端更宽", () => {
  assert.equal(getRealBottomTolerance(false), REAL_BOTTOM_TOLERANCE_PX);
  assert.equal(getRealBottomTolerance(true), MOBILE_REAL_BOTTOM_TOLERANCE_PX);
  assert.equal(getTouchUpIntentThreshold(false), TOUCH_UP_INTENT_PX);
  assert.equal(getTouchUpIntentThreshold(true), MOBILE_TOUCH_UP_INTENT_PX);
});

test("isLayoutDrivenScroll：高度变化是布局，未采样不挡首次滚动", () => {
  // 思考/工具块展开：内容变高，浏览器可能顺带把 scrollTop 上移
  assert.equal(
    isLayoutDrivenScroll({
      previousScrollHeight: 5000,
      nextScrollHeight: 5320,
      previousClientHeight: 300,
      nextClientHeight: 300,
    }),
    true,
  );
  // 思考块折叠 / 流式结束收缩
  assert.equal(
    isLayoutDrivenScroll({
      previousScrollHeight: 5320,
      nextScrollHeight: 5000,
      previousClientHeight: 300,
      nextClientHeight: 300,
    }),
    true,
  );
  // 输入框变高、软键盘、地址栏：视口变了
  assert.equal(
    isLayoutDrivenScroll({
      previousScrollHeight: 5000,
      nextScrollHeight: 5000,
      previousClientHeight: 300,
      nextClientHeight: 240,
    }),
    true,
  );
  // 高度稳定：用户拖滚动条
  assert.equal(
    isLayoutDrivenScroll({
      previousScrollHeight: 5320,
      nextScrollHeight: 5320,
      previousClientHeight: 300,
      nextClientHeight: 300,
    }),
    false,
  );
  // 尚未采样：不把首次 scroll 当成布局变化（否则打开会话立刻上翻会被吞）
  assert.equal(
    isLayoutDrivenScroll({
      previousScrollHeight: 0,
      nextScrollHeight: 5000,
      previousClientHeight: 0,
      nextClientHeight: 300,
    }),
    false,
  );
});

test("getScrollDirection", () => {
  assert.equal(getScrollDirection(100, 90), "up");
  assert.equal(getScrollDirection(100, 110), "down");
  assert.equal(getScrollDirection(100, 100), "none");
});

test("send / reset / jump-button：无论此前状态都回到 following", () => {
  for (const kind of ["send", "reset", "jump-button"]) {
    assert.equal(reduceAutoFollow("released", { kind }), "following");
    assert.equal(reduceAutoFollow("following", { kind }), "following");
  }
});

test("up-intent：立即 released，即使仍在底部区域内", () => {
  assert.equal(reduceAutoFollow("following", { kind: "up-intent" }), "released");
  assert.equal(reduceAutoFollow("released", { kind: "up-intent" }), "released");
});

test("scroll：following 中出现向上位移即 released（滚动条拖拽 / minimap 上拖）", () => {
  const zone = getBottomZoneSize(900, false); // 90
  // 小幅向上、位移后仍在区域内：同样释放，向上意图不看区域
  assert.equal(
    reduceAutoFollow("following", { kind: "scroll", distance: 20, direction: "up", zoneSize: zone }),
    "released",
  );
  // 大幅向上远离底部
  assert.equal(
    reduceAutoFollow("following", { kind: "scroll", distance: 400, direction: "up", zoneSize: zone }),
    "released",
  );
});

test("scroll：向上位移后落在真实底部不误判 released（移动端容器收缩钳位）", () => {
  const zone = getBottomZoneSize(900, false);
  // 容器收缩把 scrollTop 向上钳位，钳完正好在真实底部：规则顺序保证仍 following
  assert.equal(
    reduceAutoFollow("following", { kind: "scroll", distance: 0, direction: "up", zoneSize: zone }),
    "following",
  );
  assert.equal(
    reduceAutoFollow("following", { kind: "scroll", distance: 0.5, direction: "up", zoneSize: zone }),
    "following",
  );
});

test("scroll：移动端钉底后 10px 回弹仍 following；桌面 1px 容差仍会释放", () => {
  const zone = getBottomZoneSize(900, true);
  assert.equal(
    reduceAutoFollow("following", {
      kind: "scroll",
      distance: 10,
      direction: "up",
      zoneSize: zone,
      bottomTolerance: getRealBottomTolerance(true),
    }),
    "following",
  );
  assert.equal(
    reduceAutoFollow("following", {
      kind: "scroll",
      distance: 10,
      direction: "up",
      zoneSize: getBottomZoneSize(900, false),
    }),
    "released",
  );
});

test("scroll：released 向下但未进入末端区域，不恢复（不被吸回）", () => {
  const zone = getBottomZoneSize(900, false); // 90
  assert.equal(
    reduceAutoFollow("released", { kind: "scroll", distance: 200, direction: "down", zoneSize: zone }),
    "released",
  );
  // 恰好在区域外 1px
  assert.equal(
    reduceAutoFollow("released", { kind: "scroll", distance: zone + 1, direction: "down", zoneSize: zone }),
    "released",
  );
});

test("scroll：released 向下进入末端区域恢复 following", () => {
  const zone = getBottomZoneSize(900, false); // 90
  assert.equal(
    reduceAutoFollow("released", { kind: "scroll", distance: zone, direction: "down", zoneSize: zone }),
    "following",
  );
  assert.equal(
    reduceAutoFollow("released", { kind: "scroll", distance: 30, direction: "down", zoneSize: zone }),
    "following",
  );
});

test("scroll：released 到达真实底部恢复 following（任意方向）", () => {
  const zone = getBottomZoneSize(900, false);
  assert.equal(
    reduceAutoFollow("released", { kind: "scroll", distance: 0, direction: "down", zoneSize: zone }),
    "following",
  );
  // 内容增长把用户「推」到真实底部的情况不存在（增长不改 scrollTop），
  // 但 minimap 拖到最底是 direction=none/down 的真实路径
  assert.equal(
    reduceAutoFollow("released", { kind: "scroll", distance: 1, direction: "none", zoneSize: zone }),
    "following",
  );
});

test("scroll：released 中向上滚动保持 released（刚开始向上不被底部区域吸回）", () => {
  const zone = getBottomZoneSize(900, false);
  assert.equal(
    reduceAutoFollow("released", { kind: "scroll", distance: 10, direction: "up", zoneSize: zone }),
    "released",
  );
  assert.equal(
    reduceAutoFollow("released", { kind: "scroll", distance: 500, direction: "up", zoneSize: zone }),
    "released",
  );
});

test("scroll：following 中方向 none 且不在底部，保持 following（等 RO 钉底）", () => {
  const zone = getBottomZoneSize(900, false);
  // 内容增长不触发 scroll 事件；万一出现 none 位移事件，不改变状态
  assert.equal(
    reduceAutoFollow("following", { kind: "scroll", distance: 200, direction: "none", zoneSize: zone }),
    "following",
  );
});

test("shouldShowJumpButton：可滚动 + released + 在末端区域外", () => {
  const zone = getBottomZoneSize(900, false); // 90
  const overflow = 500;
  // 完整条件
  assert.equal(shouldShowJumpButton("released", overflow, 200, zone), true);
  // following 不显示
  assert.equal(shouldShowJumpButton("following", overflow, 200, zone), false);
  // 在末端区域内不显示（此时向下即恢复 following，按钮是冗余的）
  assert.equal(shouldShowJumpButton("released", overflow, zone, zone), false);
  assert.equal(shouldShowJumpButton("released", overflow, 0, zone), false);
  // 几乎不可滚动不显示
  assert.equal(shouldShowJumpButton("released", MIN_OVERFLOW_FOR_JUMP_BUTTON_PX, 10, 40), false);
  assert.equal(shouldShowJumpButton("released", 0, 0, 40), false);
});

test("canNestedScrollerConsumeUp：溢出且已下滚的嵌套区优先消费", () => {
  assert.equal(canNestedScrollerConsumeUp({ scrollTop: 50, scrollHeight: 500, clientHeight: 200 }), true);
  // 已到嵌套区顶部：不能再向上，外层应接管（返回 false）
  assert.equal(canNestedScrollerConsumeUp({ scrollTop: 0, scrollHeight: 500, clientHeight: 200 }), false);
  // 无溢出：不是滚动区
  assert.equal(canNestedScrollerConsumeUp({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 }), false);
  // 1px 以内的溢出视为不可滚
  assert.equal(canNestedScrollerConsumeUp({ scrollTop: 0, scrollHeight: 201, clientHeight: 200 }), false);
});

test("isEntryStickActive：静止窗口与硬上限", () => {
  const armedAt = 10_000;
  // 未启动
  assert.equal(isEntryStickActive(armedAt + 100, null, armedAt), false);
  // 启动后立即：活跃
  assert.equal(isEntryStickActive(armedAt + 100, armedAt, armedAt), true);
  // 内容持续增长：刷新静止计时，仍活跃
  const grownAt = armedAt + 500;
  assert.equal(isEntryStickActive(grownAt + ENTRY_STICK_QUIET_MS - 1, armedAt, grownAt), true);
  // 静止超过窗口：结束
  assert.equal(isEntryStickActive(grownAt + ENTRY_STICK_QUIET_MS + 1, armedAt, grownAt), false);
  // 持续增长撞硬上限：结束
  const lateGrowth = armedAt + ENTRY_STICK_MAX_MS - 10;
  assert.equal(isEntryStickActive(armedAt + ENTRY_STICK_MAX_MS + 1, armedAt, lateGrowth), false);
  // 边界：恰好在上限时刻仍活跃
  assert.equal(isEntryStickActive(armedAt + ENTRY_STICK_MAX_MS, armedAt, lateGrowth), true);
});
