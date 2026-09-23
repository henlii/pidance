/**
 * 渲染宽度测量：把「按等宽字体能放多少列」算出来，交给服务端让插件组件按它排版。
 *
 * 只做像素→列数的换算，不涉及 wcwidth —— pi-tui 自己保证每行不超过 width 列，
 * 前提是前端给的是等宽字体的列数。所以必须在等宽字体容器里量（用 `ch` 探针）。
 */

/** 与服务端 SdkSessionHost.RENDER_WIDTH_* 保持一致。 */
const MIN_COLUMNS = 40;
const MAX_COLUMNS = 240;

let cachedCharWidth: number | null = null;

/** 等宽字符宽度（px）：`ch` 就是等宽字体的字符宽，用探针量一次后缓存。 */
export function measureCharWidth(host: HTMLElement): number {
  if (cachedCharWidth !== null) return cachedCharWidth;
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(100);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  host.appendChild(probe);
  cachedCharWidth = probe.getBoundingClientRect().width / 100 || 8;
  probe.remove();
  return cachedCharWidth;
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
 * 宿主可用宽度能放多少列。量不出（未布局、宽度为 0）时返回 null，调用方不报。
 * 减掉左右 padding：`clientWidth` 含 padding，不减会把列数算大。
 */
export function measureRenderColumns(host: HTMLElement): number | null {
  const styles = window.getComputedStyle(host);
  const padding =
    (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0);
  return columnsFromPixels(host.clientWidth - padding, measureCharWidth(host));
}
