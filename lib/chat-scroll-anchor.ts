/**
 * Viewport-stable scroll helpers for the chat scroller.
 *
 * The list uses overflow-anchor:none so auto-follow can pin to the bottom.
 * When the user is reading (released), content inserted above the viewport
 * must be compensated explicitly — otherwise the same message jumps.
 */

export interface ViewportScrollAnchor {
  entryId: string;
  offset: number;
}

export interface PrependCompensationPending {
  generation: number;
  sessionId: string | null;
  visibleCount: number;
  distance: number;
  renderedHeadKey: string | null;
  anchor: ViewportScrollAnchor | null;
}

function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/**
 * Record the message currently at (or just above) the container's top edge,
 * plus its offset relative to that edge. Restoring this keeps the same content
 * in view after a prepend.
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

/**
 * Pick the in-view block nearest a reading line (1/4 down the viewport).
 * Top-edge capture is for prepend; grouping inserts chrome below the last
 * user bubble, so restoring the top edge leaves process internals shifted.
 */
export function pickReadingAnchor(input: {
  items: readonly { id: string; offset: number; height: number }[];
  clientHeight: number;
}): { id: string; offset: number } | null {
  const target = Math.max(0, input.clientHeight * 0.4);
  let covering: { id: string; offset: number } | null = null;
  let best: { id: string; offset: number } | null = null;
  let bestDist = Infinity;
  for (const item of input.items) {
    const bottom = item.offset + item.height;
    if (bottom < 1 || item.offset > input.clientHeight - 1) continue;
    if (!covering && item.offset <= target && bottom > target) {
      covering = { id: item.id, offset: item.offset };
    }
    const dist = Math.abs(item.offset - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = { id: item.id, offset: item.offset };
    }
  }
  return covering ?? best;
}

export function captureReadingScrollAnchor(container: HTMLElement): ViewportScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  const items: { id: string; offset: number; height: number }[] = [];
  const seen = new Set<string>();
  for (const el of container.querySelectorAll<HTMLElement>("[data-chat-anchor], [data-message-entry-id]")) {
    const entryId = el.getAttribute("data-chat-anchor") || el.getAttribute("data-message-entry-id");
    if (!entryId || seen.has(entryId)) continue;
    seen.add(entryId);
    const box = el.getBoundingClientRect();
    items.push({ id: entryId, offset: box.top - containerTop, height: box.height });
  }
  const picked = pickReadingAnchor({ items, clientHeight: container.clientHeight });
  return picked ? { entryId: picked.id, offset: picked.offset } : null;
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
  if (id.startsWith("message:")) {
    const rest = escapeAttrValue(id.slice("message:".length));
    return container.querySelector<HTMLElement>(`[data-chat-anchor="process:${rest}"]`)
      ?? container.querySelector<HTMLElement>(`[data-chat-anchor="process-final:${rest}"]`)
      ?? container.querySelector<HTMLElement>(`[data-message-entry-id="${rest}"]`);
  }
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

/**
 * Consume a prepend snapshot only after THIS transaction's window actually
 * expanded and the rendered head aged.
 *
 * Data-only prepends (entryIds change, visibleCount still the capture value)
 * must keep the snapshot: the last-N window can shift in that commit, but the
 * matching visibleCount grow has not landed yet. A later getNextVisibleCount
 * would then prepend a second time with no snapshot.
 */
export function shouldApplyPrependCompensation(input: {
  pending: PrependCompensationPending | null;
  sessionId: string | null;
  generation: number;
  renderedHeadKey: string | null;
  visibleCount: number;
}): boolean {
  const pending = input.pending;
  if (!pending) return false;
  if (pending.generation !== input.generation) return false;
  if (pending.sessionId !== input.sessionId) return false;
  if (!pending.renderedHeadKey || !input.renderedHeadKey) return false;
  if (input.renderedHeadKey === pending.renderedHeadKey) return false;
  if (input.visibleCount <= pending.visibleCount) return false;
  return true;
}

/**
 * Height change of a box that grows/shrinks downward (top stays).
 *
 * ProcessDetailsGroup replaces a placeholder with real content: the holder's top
 * is fixed, extra height is pushed downward from the old bottom. If that top is
 * above the viewport, keep the old bottom (and everything below it) stable by
 * compensating the full delta — including when the placeholder already
 * straddles the viewport. A box whose top is already in/below the view grows
 * inside the reading window and must not be compensated.
 */
export function scrollDeltaForBoxHeightChange(input: {
  prevHeight: number;
  nextHeight: number;
  nextTop: number;
  viewportTop: number;
}): number {
  const delta = input.nextHeight - input.prevHeight;
  if (!Number.isFinite(delta) || delta === 0) return 0;
  if (input.nextTop < input.viewportTop - 1) return delta;
  return 0;
}

export const CHAT_IGNORE_RECAPTURE_ATTR = "data-pidance-ignore-recapture";

export function findChatScroller(from: Element | null): HTMLElement | null {
  if (!from) return null;
  const scroller = from.closest("[data-chat-scroller='true']");
  return scroller instanceof HTMLElement ? scroller : null;
}

/** Apply a measured height change to the chat scroller; returns the new height to store. */
export function applyBoxHeightChangeToScroller(
  el: HTMLElement,
  scroller: HTMLElement,
  prevHeight: number | null,
): number | null {
  const nextHeight = el.getBoundingClientRect().height;
  if (!(nextHeight > 0)) return prevHeight;
  if (prevHeight != null) {
    const delta = scrollDeltaForBoxHeightChange({
      prevHeight,
      nextHeight,
      nextTop: el.getBoundingClientRect().top,
      viewportTop: scroller.getBoundingClientRect().top,
    });
    if (delta !== 0) {
      scroller.setAttribute(CHAT_IGNORE_RECAPTURE_ATTR, "1");
      scroller.scrollTop += delta;
      requestAnimationFrame(() => {
        scroller.removeAttribute(CHAT_IGNORE_RECAPTURE_ATTR);
      });
    }
  }
  return nextHeight;
}
