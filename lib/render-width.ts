/**
 * 渲染尺寸测量：把「按等宽字体能放多少列、多少行」算出来，交给服务端让插件组件按它排版。
 *
 * 只做像素→列数/行数的换算，不涉及 wcwidth —— pi-tui 自己保证每行不超过 width 列，
 * 前提是前端给的是等宽字体的列数。所以必须在等宽字体容器里量（用 `ch`/行高探针）。
 *
 * 两个维度必须同源：`tui.terminal` 的 `columns` 与 `rows` 都是「可用的渲染盒」，
 * 一真一假会让插件按真实宽度排版、却按假的视口高度裁切（pi-subagents 的详情视口
 * 就是按 `rows` 裁的，裁掉的行不在输出里）。
 *
 * 口径（issue #70 审查后明确）：量的是**宿主这个渲染盒**的行列数——用宿主元素自己的
 * 字体上下文换算，而不是插件文本实际渲染时用的字号。插件输出落在 `.extension-panel-ansi`
 * （等宽 13px / 行高 1.5）或 widget 的 pre（等宽 12px / 1.5）里，与宿主（消息滚动区，
 * 无衬线 14px）不是同一套字体，所以 rows 与「插件那一行能放几行」可能差 ±1 行；
 * 方向上是偏保守（少报一行 = 插件少显示一行），不会把内容截断成不可见。
 * 选宿主而不是插件容器，是因为插件输出没有唯一的宿主元素（面板、widget 各一处），
 * 而 columns 一直就是这个宿主——两个维度同源比各自精确更重要。
 *
 * 量不到就不报：探针/尺寸量不出时返回 null，绝不回退成假的行高/字符宽（假值一旦
 * 进了缓存，之后每次上报都会带着它，而按 rows 裁切的插件会真的丢内容）。
 */

/** 与服务端 SdkSessionHost.RENDER_WIDTH_* 保持一致。 */
const MIN_COLUMNS = 40;
const MAX_COLUMNS = 240;

/** 与服务端 SdkSessionHost.RENDER_ROWS_* 保持一致。 */
const MIN_ROWS = 10;
const MAX_ROWS = 200;

/** 字体度量缓存：键是字体上下文（见 fontMetricKey），字体变了要重新量。 */
const fontMetrics = new Map<string, number>();

/**
 * 字体上下文的缓存键。
 *
 * 不能只用元素身份做键：字号是可配置的（聊天字号设置），字体一变，
 * 缓存里的字符宽/行高就过期了，换算出来的列数行数会一直错到刷新页面。
 */
export function fontMetricKey(styles: {
  fontFamily?: string;
  fontSize?: string;
  lineHeight?: string;
}): string {
  return [styles.fontFamily ?? "", styles.fontSize ?? "", styles.lineHeight ?? ""].join("|");
}

/**
 * 带缓存的字体度量：**只缓存量到的值**。
 *
 * 量不到（0 / NaN / 负数）返回 null 且不入缓存 —— 之前这里是 `|| 8` / `|| 20` 的兜底，
 * 探针在未布局时量出 0 会被缓存成假的字符宽/行高，之后每次上报都带着它。
 */
export function cachedFontMetric(
  cache: Map<string, number>,
  key: string,
  measure: () => number,
): number | null {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const measured = measure();
  if (!Number.isFinite(measured) || measured <= 0) return null;
  cache.set(key, measured);
  return measured;
}

/** 在宿主里量一个隐藏探针的尺寸（px）；未布局时浏览器给 0，交给调用方判空。 */
function measureProbe(host: HTMLElement, text: string, axis: "width" | "height"): number {
  const probe = document.createElement("span");
  probe.textContent = text;
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  host.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  const px = axis === "width" ? rect.width / 100 : rect.height;
  probe.remove();
  return px;
}

/**
 * 该对哪个节点量行高 / 字符宽。
 *
 * 图片块的**包装节点**带 `lineHeight: 0`（避免 inline-block 在行内留基线空隙），
 * 探针插进它会继承 0、量出 0 而放弃，于是高度只能退化成 `rows em`；而正文行高是 1.5，
 * 图会比应占的行矮约三分之一，下面的文字被抬上来（issue #104 审查 P1）。
 * 所以量之前先上跳到父级 —— 那才是承载正文行高的容器。
 */
export function measurementHostFor<T extends { parentElement?: T | null }>(host: T | null | undefined): T | null {
  if (!host) return null;
  return host.parentElement ?? host;
}

/**
 * 等宽字符宽度（px）：`ch` 就是等宽字体的字符宽，用探针量一次后按字体上下文缓存。
 * 量不出时返回 null。
 */
export function measureCharWidth(host: HTMLElement): number | null {
  const styles = window.getComputedStyle(host);
  return cachedFontMetric(fontMetrics, `ch|${fontMetricKey(styles)}`, () => measureProbe(host, "0".repeat(100), "width"));
}

/**
 * 等宽行高（px）：用探针量一次后按字体上下文缓存。量不出时返回 null。
 *
 * 不读 `getComputedStyle(host).lineHeight`：它可能是 `normal`，不是像素值时换算不了。
 * 探针量与字符宽同一套办法，保证两个维度用的是同一个字体上下文。
 */
export function measureLineHeight(host: HTMLElement): number | null {
  const styles = window.getComputedStyle(host);
  return cachedFontMetric(fontMetrics, `lh|${fontMetricKey(styles)}`, () => measureProbe(host, "0", "height"));
}

/**
 * 像素→列数（夹到 [MIN_COLUMNS, MAX_COLUMNS]）。量不出时返回 null。
 * 抽成纯函数是为了能直接测换算与边界，不用 DOM。
 */
export function columnsFromPixels(availablePx: number, charWidthPx: number): number | null {
  if (!(availablePx > 0) || !(charWidthPx > 0)) return null;
  return Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.floor(availablePx / charWidthPx)));
}

/**
 * 宿主可用宽度能放多少列。量不出（未布局、宽度为 0、字体探针量不到）时返回 null，调用方不报。
 * 减掉左右 padding：`clientWidth` 含 padding，不减会把列数算大。
 */
export function measureRenderColumns(host: HTMLElement): number | null {
  const styles = window.getComputedStyle(host);
  const padding =
    (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0);
  const charWidth = measureCharWidth(host);
  if (charWidth === null) return null;
  return columnsFromPixels(host.clientWidth - padding, charWidth);
}

/**
 * 像素→行数（夹到 [MIN_ROWS, MAX_ROWS]）。量不出时返回 null。
 * 抽成纯函数是为了能直接测换算与边界，不用 DOM。
 */
export function rowsFromPixels(availablePx: number, lineHeightPx: number): number | null {
  if (!(availablePx > 0) || !(lineHeightPx > 0)) return null;
  return Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(availablePx / lineHeightPx)));
}

/**
 * 宿主可用高度能放多少行。量不出（未布局、高度为 0、行高探针量不到）时返回 null，调用方不报。
 * 与列数同源：同一个宿主元素、同一套字体度量。
 */
export function measureRenderRows(host: HTMLElement): number | null {
  const styles = window.getComputedStyle(host);
  const padding =
    (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0);
  const lineHeight = measureLineHeight(host);
  if (lineHeight === null) return null;
  return rowsFromPixels(host.clientHeight - padding, lineHeight);
}
