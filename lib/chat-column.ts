/**
 * 会话区（消息列 / 输入栏 / 扩展面板 / widget / todo / 底栏）共享的布局常量。
 *
 * 单一口径：这些区域必须同宽同中心线，否则视觉上会明显错位（例如消息列 760、
 * 输入区 820）。左右边距由两侧的 18px 竖条（MessageNavRail / ChatMinimap）充当，
 * 它们是 DOM 里的真实占位元素，因此会话列不再额外加左右内边距。
 */

/** 会话区最大宽度（含消息列、输入栏、扩展面板、widget、todo、底栏）。 */
export const CHAT_COLUMN_MAX_WIDTH = 1230;

/** 两侧竖条（左侧用户消息导航条 / 右侧消息概览条）宽度。 */
export const CHAT_GUTTER = 18;

/** 消息概览条宽度（与左侧导航条同宽，保持对称）。 */
export const CHAT_MINIMAP_WIDTH = CHAT_GUTTER;

/**
 * 块内内容限高：思考块 / 工具输出 / 扩展 widget 共用同一口径。
 * 超出在块内滚动，避免超长内容把输入区顶出可视区（实测 80 行 widget 会顶掉输入框）。
 */
export const CHAT_BLOCK_MAX_HEIGHT = "min(320px, 45vh)";
export const CHAT_BLOCK_MAX_HEIGHT_MOBILE = "min(240px, 32vh)";
