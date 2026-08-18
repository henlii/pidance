/**
 * OpenChamber 风格会话自动跟随的纯逻辑（无 DOM / 无 React 依赖，node:test 可直接测）。
 *
 * 语义对齐 openchamber/openchamber 的 useChatAutoFollow，但只保留 Deck 需要的两态核心：
 *
 *   following → 内容增长时由 ResizeObserver 在 paint 前 instant 钉底；
 *   released  → 绝不因流式增长、工具块重排或懒加载 prepend 被拉回底部。
 *
 * 状态迁移只来自四类触发：
 *   1. send / reset / jump-button → 立即回到 following（由调用方负责随后的 instant pin）；
 *   2. up-intent（wheel 向上、触摸下拉、ArrowUp/PageUp/Home）→ 立即 released，
 *      即使此时仍在底部区域内——向上意图优先于任何区域判定；
 *   3. scroll 事件按几何判定：到真实底部恢复；向下进入末端区域恢复；
 *      following 中出现向上位移即 released（内容高度未变时，向上位移只可能
 *      来自用户：滚动条拖拽、minimap 上拖等）；
 *   4. released 中的其余滚动一律保持 released，不被吸回。
 *
 * 调用方必须在 scrollHeight / clientHeight 变化时忽略 scroll 状态判定：
 * 思考/工具块自动展开、流式增高、折叠收缩、输入框变高都会改高度，
 * 浏览器可能顺带把 scrollTop 上移（clamp / 移动端抖动），那不是用户松手。
 */

export type AutoFollowMode = "following" | "released";
export type ScrollDirection = "up" | "down" | "none";

/** 距底部多少 px 以内视为「真实底部」（包容小数像素与钳位误差）。 */
export const REAL_BOTTOM_TOLERANCE_PX = 1;
/** 移动端钉底后的亚像素 / 橡皮筋回弹，1px 会把 following 误判成 released。 */
export const MOBILE_REAL_BOTTOM_TOLERANCE_PX = 16;
/** 桌面触摸板/精确指针：超过 4px 的下拉即视为向上阅读。 */
export const TOUCH_UP_INTENT_PX = 4;
/** 移动端手指抖动与展开跳变，4px 太容易误释放。 */
export const MOBILE_TOUCH_UP_INTENT_PX = 12;
/** 初次打开会话后，内容静止这么久就结束 entry-stick。 */
export const ENTRY_STICK_QUIET_MS = 600;
/** entry-stick 硬上限：再慢的资源也不无限钉底。 */
export const ENTRY_STICK_MAX_MS = 8_000;
/** agent/bash 结束后仍允许钉底的收尾窗口（覆盖 process group 重排、流式槽卸除、高亮/图片等滞后布局）。 */
export const RUN_SETTLE_MS = 1_500;
/** 平滑程序化滚动（扩展卡片、回到底部）期间，scroll 事件不参与状态判定。 */
export const PROGRAMMATIC_SMOOTH_IGNORE_MS = 700;
/** 内容高度超出视口这么多才算「可滚动」，小于此不显示回到底部按钮。 */
export const MIN_OVERFLOW_FOR_JUMP_BUTTON_PX = 20;

export function getDistanceFromBottom(scrollHeight: number, scrollTop: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

/** 末端区域：桌面 max(48px, 10% 视口高)，移动 40px。进入该区域且方向向下才恢复跟随。 */
export function getBottomZoneSize(clientHeight: number, isMobile: boolean): number {
  if (isMobile) return 40;
  return Math.max(48, Math.round(clientHeight * 0.1));
}

/** 底部常驻 spacer：桌面 10vh、移动 40px（渲染侧用 CSS 单位表达，此处供测试对齐公式）。 */
export function getBottomSpacerHeight(viewportHeight: number, isMobile: boolean): number {
  return isMobile ? 40 : Math.round(viewportHeight * 0.1);
}

export function getRealBottomTolerance(isMobile: boolean): number {
  return isMobile ? MOBILE_REAL_BOTTOM_TOLERANCE_PX : REAL_BOTTOM_TOLERANCE_PX;
}

export function getTouchUpIntentThreshold(isMobile: boolean): number {
  return isMobile ? MOBILE_TOUCH_UP_INTENT_PX : TOUCH_UP_INTENT_PX;
}

export function isAtRealBottom(distance: number, tolerance: number = REAL_BOTTOM_TOLERANCE_PX): boolean {
  return distance <= tolerance;
}

/**
 * 容器或内容尺寸变了：这次 scroll 是布局结果，不是用户滚动。
 * previous 为 0 视为尚未采样，不挡首次真实滚动。
 */
export function isLayoutDrivenScroll(input: {
  previousScrollHeight: number;
  nextScrollHeight: number;
  previousClientHeight: number;
  nextClientHeight: number;
}): boolean {
  if (input.previousClientHeight > 0 && input.nextClientHeight !== input.previousClientHeight) return true;
  if (input.previousScrollHeight > 0 && input.nextScrollHeight !== input.previousScrollHeight) return true;
  return false;
}

export function getScrollDirection(previousTop: number, nextTop: number): ScrollDirection {
  if (nextTop < previousTop) return "up";
  if (nextTop > previousTop) return "down";
  return "none";
}

export type AutoFollowTrigger =
  /** 用户发送消息：无论此前状态如何，立即回到 following */
  | { kind: "send" }
  /** 初次打开 / 切换会话：following + instant 到底 */
  | { kind: "reset" }
  /** 回到底部按钮点击 */
  | { kind: "jump-button" }
  /** 真实用户向上意图：wheel deltaY<0、触摸下拉、ArrowUp/PageUp/Home */
  | { kind: "up-intent" }
  /** 滚动位置变化（已排除程序化写入窗口） */
  | { kind: "scroll"; distance: number; direction: ScrollDirection; zoneSize: number; bottomTolerance?: number };

export function reduceAutoFollow(mode: AutoFollowMode, trigger: AutoFollowTrigger): AutoFollowMode {
  switch (trigger.kind) {
    case "send":
    case "reset":
    case "jump-button":
      return "following";
    case "up-intent":
      return "released";
    case "scroll": {
      // 先到真实底部：任何路径都恢复跟随。这条必须放在「向上即释放」之前——
      // 移动端键盘弹出导致容器收缩时，浏览器会把 scrollTop 向上钳位，
      // 钳位后正好落在真实底部，不应误判为用户释放。
      if (isAtRealBottom(trigger.distance, trigger.bottomTolerance ?? REAL_BOTTOM_TOLERANCE_PX)) return "following";
      // 用户向下滚进末端区域：恢复跟随。
      if (trigger.direction === "down" && trigger.distance <= trigger.zoneSize) return "following";
      // following 中出现向上位移即释放。高度变化引起的 scroll 已由调用方
      // 按 isLayoutDrivenScroll 排除；平滑程序化滚动也有时间窗。剩下的向上位移来自用户。
      if (trigger.direction === "up" && mode === "following") return "released";
      // 其余一律保持现状：released 不被吸回；刚开始向上、仍在底部区域内也不被重新捕获。
      return mode;
    }
  }
}

/** 回到底部按钮：仅「可滚动 + released + 不在末端区域」时显示。 */
export function shouldShowJumpButton(
  mode: AutoFollowMode,
  overflowPx: number,
  distance: number,
  zoneSize: number,
): boolean {
  return mode === "released" && overflowPx > MIN_OVERFLOW_FOR_JUMP_BUTTON_PX && distance > zoneSize;
}

/**
 * 嵌套滚动区能否继续向上消费滚动。wheel/touch 的向上意图若发生在这样的
 * 区域内（代码块、工具输出等），应让嵌套区优先消费，外层不 release。
 */
export function canNestedScrollerConsumeUp(scroller: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return scroller.scrollHeight - scroller.clientHeight > 1 && scroller.scrollTop > 0;
}

/**
 * entry-stick：初次打开会话的 instant pin 之后，内容可能还在异步重排
 * （图片、代码高亮）。静止 ENTRY_STICK_QUIET_MS 即结束，硬上限 ENTRY_STICK_MAX_MS。
 * armedAt 为 null 表示未启动；任何真实用户向上意图由调用方直接解除（released 后不再查询）。
 */
export function isEntryStickActive(now: number, armedAt: number | null, lastGrowthAt: number): boolean {
  if (armedAt === null) return false;
  return now - armedAt <= ENTRY_STICK_MAX_MS && now - lastGrowthAt <= ENTRY_STICK_QUIET_MS;
}
