import type { CSSProperties } from "react";
import { CHAT_COLUMN_MAX_WIDTH_CSS } from "./chat-column";
import type { ExtensionUiCustomLayout } from "./types";

/**
 * 插件 overlay 面板的布局映射：终端语义（锚点 + 行/列尺寸）→ CSS。
 *
 * pi-tui 的 overlay 是把它合成到字符画布的某个矩形里；Web 上不需要那一步，
 * 面板是独立 DOM 层，所以只要把尺寸和锚点翻译成 flex 对齐与 CSS 尺寸即可。
 *
 * 有两处不能照搬终端语义：
 *   - 终端列数（如 88 列）在窄屏上会超出容器，被父级 overflow 直接裁掉 → 一律封顶到 100%；
 *   - 终端行数不是 CSS 长度 → 按 1 行 ≈ 1.5em 近似。
 */

/** pi-tui 的九个 overlay 锚点 → 容器 flex 对齐（容器本身是 row 方向的 display:flex）。 */
export const ANCHOR_ALIGNMENT: Record<string, { alignItems: string; justifyContent: string }> = {
  center: { alignItems: "center", justifyContent: "center" },
  "top-left": { alignItems: "flex-start", justifyContent: "flex-start" },
  "top-center": { alignItems: "flex-start", justifyContent: "center" },
  "top-right": { alignItems: "flex-start", justifyContent: "flex-end" },
  "bottom-left": { alignItems: "flex-end", justifyContent: "flex-start" },
  "bottom-center": { alignItems: "flex-end", justifyContent: "center" },
  "bottom-right": { alignItems: "flex-end", justifyContent: "flex-end" },
  "left-center": { alignItems: "center", justifyContent: "flex-start" },
  "right-center": { alignItems: "center", justifyContent: "flex-end" },
};

/** 终端尺寸值 → CSS 长度：数字按列数（ch），字符串（百分比）原样。 */
export function sizeToCss(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? `${value}ch` : value;
}

/**
 * 宽度类值 → CSS 长度。
 * 百分比本身就以容器为基准，不必再包一层；列数（ch）在窄屏上会溢出，封顶到 100%。
 */
function clampWidth(value: number | string | undefined): string | undefined {
  const css = sizeToCss(value);
  if (css === undefined) return undefined;
  return css.endsWith("%") ? css : `min(${css}, 100%)`;
}

/** 高度类值 → CSS 长度：数字按终端行数近似，同样封顶到 100%。 */
function clampHeight(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const css = typeof value === "number" ? `${value * 1.5}em` : value;
  return css.endsWith("%") ? css : `min(${css}, 100%)`;
}

/**
 * margin（终端行/列）→ 容器 padding，竖向 em、横向 ch。
 *
 * 每边与 `env(safe-area-inset-*)` 取 max：插件可以用 `margin: 0` 要求贴边，
 * 但刘海/底部手势条那部分留白不能被贴边吃掉。未给 margin 时返回 undefined，
 * 容器保持 CSS 里的默认内边距。
 */
export function marginToPadding(margin: ExtensionUiCustomLayout["margin"]): string | undefined {
  if (margin === undefined) return undefined;
  const sides =
    typeof margin === "number"
      ? { top: margin, right: margin, bottom: margin, left: margin }
      : margin;
  if (
    sides.top === undefined &&
    sides.right === undefined &&
    sides.bottom === undefined &&
    sides.left === undefined
  ) {
    return undefined;
  }
  const row = (value: number | undefined) => `${value ?? 0}em`;
  const col = (value: number | undefined) => `${value ?? 0}ch`;
  return [
    `max(${row(sides.top)}, env(safe-area-inset-top, 0px))`,
    `max(${col(sides.right)}, env(safe-area-inset-right, 0px))`,
    `max(${row(sides.bottom)}, env(safe-area-inset-bottom, 0px))`,
    `max(${col(sides.left)}, env(safe-area-inset-left, 0px))`,
  ].join(" ");
}

/**
 * overlay layout → 容器与面板两处的 CSS。
 * 没有 layout（插件没声明 overlay）时返回 undefined，调用方按默认宽度铺满内容列 ——
 * 插槽位置对两种 custom 是一样的（见 components/ChatWindow.tsx 的插槽注释）。
 * 未知锚点回退 center（与 pi-tui 的默认一致），不抛错。
 */
/**
 * 面板正文的宽度（列数）。数值宽度按「字符列」理解：容器用 fit-content 包住正文，
 * 正文自己用 Nch 定宽 —— 因为 ch 必须由**等宽正文**量（容器是正文字体，量出来偏小），
 * 而且正文还有内边距；两者叠加会让插件恰好画满 N 列时也冒出横向滚动条。
 */
function bodyWidthCh(value: number | string | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}

export function buildExtensionOverlayStyle(
  layout: ExtensionUiCustomLayout | undefined,
): { containerStyle: CSSProperties; panelStyle: CSSProperties; bodyWidthCh?: number } | undefined {
  if (!layout) return undefined;
  const padding = marginToPadding(layout.margin);
  const cols = bodyWidthCh(layout.width);
  return {
    containerStyle: {
      ...(ANCHOR_ALIGNMENT[layout.anchor] ?? ANCHOR_ALIGNMENT.center),
      ...(padding ? { padding } : {}),
    },
    panelStyle: {
      width: cols === undefined ? (clampWidth(layout.width) ?? CHAT_COLUMN_MAX_WIDTH_CSS) : "fit-content",
      ...(cols === undefined ? {} : { maxWidth: "100%" }),
      minWidth: layout.minWidth === undefined ? undefined : `min(${layout.minWidth}ch, 100%)`,
      maxHeight: clampHeight(layout.maxHeight),
    },
    // 只有数值宽度这条路才动 maxWidth：字符串/缺省宽度保持原有字节一致的行为。
    ...(cols === undefined ? {} : { bodyWidthCh: cols }),
  };
}
