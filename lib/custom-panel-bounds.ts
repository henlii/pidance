/**
 * custom 面板的几何：pi-tui `OverlayBounds` 在 Web 上的投影。
 *
 * 终端里 overlay 的 bounds 是「合进字符画布的那个矩形」（行/列 + 字符宽高），
 * 插件拿它做命中测试或在自己的坐标系里对齐。Web 上面板是独立 DOM 层，没有字符画布，
 * 所以这份数据只能**由客户端量出来再上报**：
 *
 *   - 单位仍是**字符单元格**（不是 CSS 像素）—— 插件按终端坐标写逻辑，给像素没有意义；
 *   - 原点取**会话滚动区**（聊天列）的左上角，而不是窗口或面板自身：
 *     面板自身的原点是 (0,0)（毫无信息量），窗口原点在手机上会把浏览器 UI 算进去；
 *   - 面板本体（画 ANSI 的那块 `<pre>`）而不是整张卡片：鼠标事件用的也是这块
 *     （见 components/ExtensionCustomPanel.tsx 的 toPanelMouseEvent），
 *     两处同源，插件才可能把 bounds 与点击坐标对上。
 *
 * 量不出就返回 null（未布局 / 字体探针失败 / 尺寸为 0），调用方**不上报**：
 * 报一个编出来的 0 比不报更糟（插件会按 0 行 0 列排版）。
 */
import type { CustomPanelBounds } from "./types";

/** 只取换算需要的字段，方便单测直接构造矩形（不依赖 DOMRect）。 */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 像素矩形 → 字符单元格 bounds。
 *
 * `containerRect` 是原点容器（滚动区）的位置，只需 left/top。
 * 任一度量不可用（null / 非有限 / ≤ 0）→ null，不猜。
 */
export function customPanelBoundsFromRects(input: {
  bodyRect: RectLike;
  containerRect: { left: number; top: number };
  charWidth: number | null;
  lineHeight: number | null;
}): CustomPanelBounds | null {
  const { bodyRect, containerRect, charWidth, lineHeight } = input;
  const positive = (value: number | null): number | null =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  const char = positive(charWidth);
  const line = positive(lineHeight);
  if (char === null || line === null) return null;
  if (!Number.isFinite(bodyRect.width) || !Number.isFinite(bodyRect.height)) return null;
  if (!Number.isFinite(bodyRect.left) || !Number.isFinite(bodyRect.top)) return null;
  if (!Number.isFinite(containerRect.left) || !Number.isFinite(containerRect.top)) return null;
  if (bodyRect.width <= 0 || bodyRect.height <= 0) return null;
  return {
    // 面板可能在滚动区之外（滚动到一半）：坐标不夹到 0 —— 夹了会把「在上方」说成「在顶部」。
    // 负坐标是合法信息（pi-tui 的 bounds 也允许部分在画布外）。
    row: Math.floor((bodyRect.top - containerRect.top) / line),
    col: Math.floor((bodyRect.left - containerRect.left) / char),
    width: Math.max(1, Math.floor(bodyRect.width / char)),
    height: Math.max(1, Math.floor(bodyRect.height / line)),
  };
}

/**
 * 这次测量该不该上报。
 *
 * - 标签不可见（后台 / 最小化 / bfcache 恢复前）→ **不上报**：后台标签的布局不可信，
 *   而且它的尺寸往往已经被浏览器按 0 处理，报上去会把插件刚用过的正确值覆盖掉。
 *   恢复可见时前端会重挂观察者，那一次自然会补报。
 * - 量不出（next 为 null）→ 不上报（见文件头：不报编出来的值）。
 * - 与上次**上报值**完全相同 → 不上报（ResizeObserver 会为无关变化反复回调）。
 */
export function shouldReportCustomPanelBounds(
  previous: CustomPanelBounds | null,
  next: CustomPanelBounds | null,
  visible: boolean,
): boolean {
  if (!visible) return false;
  if (next === null) return false;
  if (previous === null) return true;
  return (
    previous.row !== next.row ||
    previous.col !== next.col ||
    previous.width !== next.width ||
    previous.height !== next.height
  );
}
