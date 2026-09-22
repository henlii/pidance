/**
 * 会话区（消息列 / 输入栏 / 扩展面板 / widget / todo / 底栏）共享的布局常量。
 *
 * 单一口径：这些区域必须同宽同中心线，否则视觉上会明显错位（例如消息列 760、
 * 输入区 820）。左右边距由两侧的 18px 竖条（MessageNavRail / ChatMinimap）充当，
 * 它们是 DOM 里的真实占位元素，因此会话列不再额外加左右内边距。
 */

/**
 * 会话内容区宽度的**兜底**上限（px）。真实宽度见下面的「宽度模型」：由比例算出、
 * 夹在 [MIN, MAX] 之间；这个常量同时充当 CSS 变量缺省值（SSR / 变量未写入时）。
 * 取整百便于阅读与对齐：原 820 的 1.5 倍为 1230，按要求再收 ~10% → 1100。
 */
export const CHAT_COLUMN_MAX_WIDTH = 1100;

/**
 * 会话内容区（消息列 / 输入栏 / 扩展面板 / widget / todo / 底栏）**宽度模型**。
 *
 * 口径（2026-09-22 产品决定，可拖拽调节、用**比例**记忆）：
 * 宽度 = **内容区可用宽度** × 比例，再夹到 [MIN, MAX]；可用宽度不够时由 CSS 的
 * `100%` 兜住。基准取「可用宽度」（视口扣掉侧栏、工作区图标栏与两侧竖条）而不是
 * 视口：否则 1080p 开侧栏时可用宽度只有约 1540，比例算出来的空白全被侧栏吃掉，
 * 「内容与空白等比例缩小」这条根本看不出来。
 *
 * | 可用宽度 | 内容宽 | 两侧空白合计 |
 * |----------|--------|--------------|
 * | 1920 | 1600（正好到上限） | 320 |
 * | 3840 | 1600（不再变宽） | 2240 ← 只长空白 |
 * | 1200 | 1000（正好到下限） | 200 ← 与内容等比例缩小 |
 * | 1000 | 1000 | 0 ← 只缩空白 |
 * | 800  | 800  | 0 ← 空白已归零，内容跟着缩 |
 *
 * 存**比例**而不是像素：窗口大小变了自动自适应（这是这条产品要求的初衷）。
 */
export const CHAT_COLUMN_WIDTH_MIN = 1000;
export const CHAT_COLUMN_WIDTH_MAX = 1600;
/** 默认比例 5/6：1920 视口恰好落在上限 1600（与上表一致）。 */
export const CHAT_COLUMN_WIDTH_DEFAULT_RATIO = CHAT_COLUMN_WIDTH_MAX / 1920;
/** 比例下限：再小也只会被 MIN 夹住，留个下界避免退化成 0。 */
export const CHAT_COLUMN_WIDTH_MIN_RATIO = 0.2;

/** 夹到 [MIN, MAX]；非法值回落默认上限。 */
export function clampChatColumnWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CHAT_COLUMN_WIDTH_MAX;
  return Math.min(CHAT_COLUMN_WIDTH_MAX, Math.max(CHAT_COLUMN_WIDTH_MIN, Math.round(value)));
}

/** 夹到 [MIN_RATIO, 1]；非法值回落默认比例。 */
export function clampChatColumnRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return CHAT_COLUMN_WIDTH_DEFAULT_RATIO;
  return Math.min(1, Math.max(CHAT_COLUMN_WIDTH_MIN_RATIO, value));
}

/**
 * 内容区可用宽度 = 会话区容器宽 - 两侧竖条（桌面 18px、移动 16px，与渲染侧同一常量口径）。
 * 侧栏/右侧工作区图标栏不在这个容器里，因此天然被扣掉。
 */
export function chatColumnAvailableWidth(containerWidth: number, isMobile: boolean): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 0;
  const side = isMobile ? CHAT_COLUMN_MOBILE_SIDE_PADDING : CHAT_GUTTER;
  return Math.max(0, containerWidth - side * 2);
}

/** 由可用宽度与比例算出内容区宽度（px）。 */
export function resolveChatColumnWidth(input: { availableWidth: number; ratio: number }): number {
  const ratio = clampChatColumnRatio(input.ratio);
  const availableWidth = input.availableWidth;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return CHAT_COLUMN_WIDTH_MAX;
  return clampChatColumnWidth(availableWidth * ratio);
}

/** 拖拽得到的像素宽度反推比例（比例是唯一持久化的量）。 */
export function chatColumnRatioFromWidth(input: { width: number; availableWidth: number }): number {
  const availableWidth = input.availableWidth;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return CHAT_COLUMN_WIDTH_DEFAULT_RATIO;
  return clampChatColumnRatio(clampChatColumnWidth(input.width) / availableWidth);
}

/**
 * 内容区宽度的 CSS 变量名：**一处设置**（AppShell 这个布局 owner），
 * 所有「同宽同中心线」的区域共用，避免逐组件传参走偏。
 */
export const CHAT_COLUMN_WIDTH_CSS_VAR = "--pidance-chat-column-width";

/** 各同宽区域的 `max-width` 表达式：变量（带兜底）再由 `100%` 兜住窄窗口。 */
export const CHAT_COLUMN_MAX_WIDTH_CSS = `min(var(${CHAT_COLUMN_WIDTH_CSS_VAR}, ${CHAT_COLUMN_MAX_WIDTH}px), 100%)`;

/** 两侧竖条（左侧用户消息导航条 / 右侧消息概览条）宽度。 */
export const CHAT_GUTTER = 18;

/** 移动端会话列左右内边距（与 ChatWindow 的 CHAT_INPUT_SIDE_PADDING_MOBILE 同口径）。 */
export const CHAT_COLUMN_MOBILE_SIDE_PADDING = 16;

/** 消息概览条宽度（与左侧导航条同宽，保持对称）。 */
export const CHAT_MINIMAP_WIDTH = CHAT_GUTTER;

/**
 * 块内内容限高：思考块 / 工具输出 / 扩展 widget 共用同一口径。
 * 超出在块内滚动，避免超长内容把输入区顶出可视区（实测 80 行 widget 会顶掉输入框）。
 */
export const CHAT_BLOCK_MAX_HEIGHT = "min(320px, 45vh)";
export const CHAT_BLOCK_MAX_HEIGHT_MOBILE = "min(240px, 32vh)";
