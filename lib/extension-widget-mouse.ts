"use client";

/**
 * widget 组件（`ctx.ui.setWidget` 的工厂形式）的鼠标事件换算。
 *
 * pi-tui 的鼠标事件用**字符单元格坐标**（不是像素），并且是**局部坐标**：
 * 原点在插件组件自己的渲染区左上角。Web 侧要给出同样的坐标，插件里的
 * `handleMouse`（例如 pi-subagents fleet widget 的「第 0 行左键点击」）才能命中。
 *
 * 换算基准必须与「服务端按 renderWidth 列渲染这些行」一致：字节宽字体里
 * 1 列 = 1 个字符 = `measureCharWidth()` 那么多像素，1 行 = `measureLineHeight()`。
 * 量不出就**不转发**这次点击（宁可这一次不生效，也不给插件送错坐标 —— 与
 * `ExtensionCustomPanel` 的 `toPanelMouseEvent` 同一口径）。
 *
 * 这里只放纯函数：DOM 取值在调用方，换算与判定在这里，便于单测覆盖边界。
 */

/** 长按判定时间：超过它仍未抬起、未移动，算长按（→ 右键）。 */
export const WIDGET_LONG_PRESS_MS = 500;
/** 手指移动超过这么多像素就当成滚动，取消长按、也不派发点击。 */
export const WIDGET_LONG_PRESS_MOVE_PX = 10;

export interface WidgetCellPoint {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetBodyMetrics {
  /** 点击位置相对正文区**内容**左上角的像素偏移（已含滚动位移、已扣 padding）。 */
  offsetX: number;
  offsetY: number;
  /** 正文字符宽（px）。量不出时传 null。 */
  charWidth: number | null;
  /** 正文行高（px）。量不出时传 null。 */
  lineHeight: number | null;
  /** 正文区**内容**盒像素宽高（已扣 padding）。 */
  bodyWidth: number;
  bodyHeight: number;
}

/**
 * 像素偏移 → 单元格坐标。任一度量量不出（未布局、字体探针失败）返回 null。
 *
 * 夹到 >= 0：`clientX` 在 padding 区（或负滚动）时算出来是负数，而 pi-tui 的
 * 坐标没有负数概念 —— 负数会被插件的 `y === 0` 一类判断当成「不在区域内」而漏掉。
 */
export function widgetCellFromMetrics(metrics: WidgetBodyMetrics): WidgetCellPoint | null {
  const { offsetX, offsetY, charWidth, lineHeight, bodyWidth, bodyHeight } = metrics;
  if (!(typeof charWidth === "number" && charWidth > 0)) return null;
  if (!(typeof lineHeight === "number" && lineHeight > 0)) return null;
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return null;
  return {
    x: Math.max(0, Math.floor(offsetX / charWidth)),
    y: Math.max(0, Math.floor(offsetY / lineHeight)),
    width: Math.max(1, Math.floor(bodyWidth / charWidth)),
    height: Math.max(1, Math.floor(bodyHeight / lineHeight)),
  };
}

export interface WidgetClickModifiers {
  button: "left" | "middle" | "right";
  clickCount: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/**
 * 组装给插件的 `TuiMouseEvent` 形状（只做 click：不转 move / drag / wheel）。
 *
 * `screenX/screenY` 在 TUI 里是全屏坐标，Web 侧没有终端屏，给与局部坐标相同的值
 * （已装插件只看 `type` / `button` / `y` 与修饰键）。
 */
export function buildWidgetClickEvent(
  point: WidgetCellPoint,
  modifiers: WidgetClickModifiers,
): Record<string, unknown> {
  return {
    type: "click",
    button: modifiers.button,
    x: point.x,
    y: point.y,
    screenX: point.x,
    screenY: point.y,
    width: point.width,
    height: point.height,
    shift: modifiers.shift,
    alt: modifiers.alt,
    ctrl: modifiers.ctrl,
    clickCount: modifiers.clickCount,
  };
}

/** DOM 的 `MouseEvent.button` 数值 → pi-tui 的按钮名。 */
export function mouseButtonName(button: number): "left" | "middle" | "right" {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  return "right";
}

/**
 * 触摸手势判定。
 *
 * 手指在可滚动区域上滑动必须是滚动，不能被当成点击；长按则映射成右键
 * （pi-tui 里右键常用于「上下文/次级操作」，触摸设备没有右键）。
 * 浏览器在滑动后**不会**派发 click，所以 tap 用普通 click 事件即可，
 * 只有长按需要我们自己计时，并吃掉紧随其后的那次 click。
 */
export interface WidgetTouchState {
  /** 手指是否仍按在正文区上。 */
  pressing: boolean;
  /** 这次触摸已经作为长按（右键）派发过。 */
  longPressFired: boolean;
}

export const INITIAL_WIDGET_TOUCH_STATE: WidgetTouchState = { pressing: false, longPressFired: false };

export function touchStart(): WidgetTouchState {
  return { pressing: true, longPressFired: false };
}

/** 移动超过阈值 → 判定为滚动，长按作废（状态回到「没有在按」）。 */
export function touchMove(state: WidgetTouchState, dx: number, dy: number): WidgetTouchState {
  if (!state.pressing) return state;
  if (!isScrollGesture(dx, dy)) return state;
  return { pressing: false, longPressFired: false };
}

export function touchEnd(state: WidgetTouchState): WidgetTouchState {
  if (!state.pressing) return state;
  return { pressing: false, longPressFired: state.longPressFired };
}

/** 手指位移是否已构成滚动手势。 */
export function isScrollGesture(dx: number, dy: number): boolean {
  return Math.abs(dx) > WIDGET_LONG_PRESS_MOVE_PX || Math.abs(dy) > WIDGET_LONG_PRESS_MOVE_PX;
}

/** 长按是否成立：仍在同一处按着、且已经超过阈值时间。 */
export function shouldFireLongPress(state: WidgetTouchState, pressedMs: number): boolean {
  return state.pressing && !state.longPressFired && pressedMs >= WIDGET_LONG_PRESS_MS;
}

/** 长按派发后把状态标记成已派发（再超时也不会重复派发）。 */
export function markLongPressFired(state: WidgetTouchState): WidgetTouchState {
  return { pressing: state.pressing, longPressFired: true };
}

/**
 * 这次 click 要不要转发。
 *
 * 长按之后浏览器仍会补发一次 click，那次必须吃掉并清零标记；没有长按标记时
 * （真 tap、鼠标点击）正常转发。
 */
export function consumeTapClick(state: WidgetTouchState): { state: WidgetTouchState; send: boolean } {
  if (state.longPressFired) return { state: INITIAL_WIDGET_TOUCH_STATE, send: false };
  return { state, send: true };
}
