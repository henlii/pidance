/**
 * 视口锚点：把「当前显示的那条消息 + 它相对容器顶的偏移」记下来，内容变化后贴回去。
 *
 * 只服务显式跳转（MessageNavRail 按 entryId 定位到历史）。
 * 日常向上加载更旧历史不再用它 —— 阅读态的 `overflow-anchor` 已交给浏览器
 * （见 ChatWindow 滚动容器），手写补偿与「猜高度」一起删掉了。
 */

export interface ViewportScrollAnchor {
  entryId: string;
  offset: number;
}

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/**
 * Record the message currently at (or just above) the container's top edge,
 * plus its offset relative to that edge.
 */
export function captureViewportScrollAnchor(container: HTMLElement): ViewportScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  let first: ViewportScrollAnchor | null = null;
  let best: ViewportScrollAnchor | null = null;
  for (const el of container.querySelectorAll<HTMLElement>("[data-chat-anchor], [data-message-entry-id]")) {
    const entryId = el.getAttribute("data-chat-anchor") || el.getAttribute("data-message-entry-id");
    if (!entryId) continue;
    const offset = el.getBoundingClientRect().top - containerTop;
    first ??= { entryId, offset };
    if (offset > 1) break;
    best = { entryId, offset };
  }
  return best ?? first;
}

export function scrollTopForAnchorOffset(input: {
  elementTop: number;
  containerTop: number;
  scrollTop: number;
  offset: number;
}): number {
  return input.elementTop - input.containerTop + input.scrollTop - input.offset;
}

export function findChatAnchorElement(container: HTMLElement, id: string): HTMLElement | null {
  const escaped = escapeAttrValue(id);
  const direct = container.querySelector<HTMLElement>(`[data-chat-anchor="${escaped}"]`);
  if (direct) return direct;
  const colon = id.indexOf(":");
  const bare = colon >= 0 ? escapeAttrValue(id.slice(colon + 1)) : escaped;
  return container.querySelector<HTMLElement>(`[data-message-entry-id="${bare}"]`);
}

export function applyViewportScrollAnchor(
  container: HTMLElement,
  anchor: ViewportScrollAnchor,
  resolveElement?: (entryId: string) => HTMLElement | null,
): boolean {
  const el = resolveElement?.(anchor.entryId)
    ?? findChatAnchorElement(container, anchor.entryId);
  if (!el || !el.isConnected) return false;
  container.scrollTop = scrollTopForAnchorOffset({
    elementTop: el.getBoundingClientRect().top,
    containerTop: container.getBoundingClientRect().top,
    scrollTop: container.scrollTop,
    offset: anchor.offset,
  });
  return true;
}
