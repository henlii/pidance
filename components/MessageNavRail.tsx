"use client";

/**
 * 会话区左侧的用户消息导航条（对齐 codex app 的左侧用户消息导航）：
 * - **列出全部用户消息**：大纲来自服务端 `/api/sessions/:id/outline`（只读完整 entry
 *   列表），因此不受首屏懒加载窗口限制；DOM 里没加载的提问同样会列出。
 * - 每条用户消息一个**短横线**，整体上下居中；悬浮显示信息卡（最大宽高、超出省略）；
 *   当前所在的一条为深色；点击跳到该消息。
 * - 跳转：目标已在 DOM 里就直接滚动；否则连续分页加载更旧历史，直到该条出现后再滚。
 *
 * 与右侧 ChatMinimap 的分工：minimap 是整轮对话总览（用户+助手+视口框+拖拽滚动），
 * 本导航条只列提问，用于「快速跳到第 N 条提问」。
 * 布局：本组件宽 CHAT_GUTTER px（与右侧 ChatMinimap 等宽），是会话列两侧的对称竖条。
 */

import { useCallback, useEffect, useMemo, useRef, useState, RefObject } from "react";
import type { AgentMessage } from "@/lib/types";
import { getChatPlanLiveMessage, trailingLiveUserStart, type ChatRenderPlanItem } from "@/lib/chat-compositor";
import { resolveActiveOutlineEntry, type UserMessageOutlineItem } from "@/lib/session-outline";
import { useI18n } from "@/lib/i18n";
import { CHAT_GUTTER } from "@/lib/chat-column";

interface Props {
  messages: AgentMessage[];
  /** 统一渲染计划（含 live slot）：与 ChatMinimap 共用同一顺序 */
  plan: ChatRenderPlanItem[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  /** 会话全部用户消息大纲（服务端只读投影；空 = 尚未取到） */
  outline: UserMessageOutlineItem[];
  /** 已加载消息的 entryId 列表（与 messages 平行同序；来自 useAgentSession） */
  entryIds: string[];
  /** entryId → 已渲染的消息元素（由 ChatWindow 提供；槽位映射归渲染层所有） */
  resolveMessageElementRef: RefObject<((entryId: string) => HTMLElement | null) | null>;
  /** 把渲染窗口扩到包含该 entry（只渲染末 N 条，目标可能已加载但未渲染） */
  expandRenderWindowToEntryRef: RefObject<((entryId: string) => boolean) | null>;
  /**
   * 按 entryId 跳到历史某条：服务端返回该条附近窗口并整体替换时间线（一次到位）。
   * 返回是否成功；成功后调用方再滚到目标。
   */
  jumpToEntry: (entryId: string) => Promise<boolean>;
  /** 当前窗口是否就是最新一段（用于「窗口内没有提问」时判定当前提问） */
  isAtLiveTail: boolean;
}

/** 轨道上下内缩：首尾横线不贴边。 */
const NAV_INSET_PX = 12;
/** 短横线：12×2，圆角 1 —— 与设计稿一致（浅灰；当前项深色）。 */
const DASH_WIDTH = 12;
const DASH_HEIGHT = 2;
/** 相邻短横线间距（列表整体上下居中）；比初版减半，长会话更紧凑。 */
const DASH_GAP = 4;
/** 列表最大高度：超出后内部滚动（横线再多也够得到）。 */
const LIST_MAX_HEIGHT_PX = 320;
/** 轨道太矮（横线挤在一起）则整条隐藏。 */
const MIN_USABLE_HEIGHT_PX = 120;
/** 信息卡最大宽高：超出省略号截断，避免长消息把卡片撑爆。 */
const CARD_MAX_WIDTH = 340;
const CARD_MAX_HEIGHT = 180;
const CARD_EDGE_MARGIN = 8;

export function MessageNavRail({
  messages,
  plan,
  scrollContainer,
  outline,
  entryIds,
  resolveMessageElementRef,
  expandRenderWindowToEntryRef,
  jumpToEntry,
  isAtLiveTail,
}: Props) {
  const { t } = useI18n();
  const [railHeight, setRailHeight] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [jumpingTo, setJumpingTo] = useState<string | null>(null);
  /** 当前高亮：滚动位置对应的「最后一条已滚过」用户消息 entryId */
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  /** 已加载 entryId 列表与「还有更早历史」的 ref 镜像：jump 循环里读最新值 */
  const entryIdsRef = useRef<string[]>(entryIds);
  entryIdsRef.current = entryIds;
  const railRef = useRef<HTMLDivElement>(null);
  const dashRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // 与 ChatMinimap 同一套消息顺序：live（流式）插到尾部用户消息之前。
  const allMessages = useMemo(() => {
    const live = getChatPlanLiveMessage(plan);
    const split = trailingLiveUserStart(messages, live != null);
    return [
      ...messages.slice(0, split),
      ...(live ? [live] : []),
      ...messages.slice(split),
    ] as Array<AgentMessage | Partial<AgentMessage>>;
  }, [plan, messages]);

  /**
   * 更新「当前在哪条提问」。
   *
   * 只渲染末尾若干条计划项，长会话里大多数提问（含视口所在那条）可能都没渲染，
   * 所以不能只看用户消息元素：先找「视口内最靠上的已渲染消息」（任意角色，
   * 带 data-message-entry-id），再用它在加载窗口中的位置推导大纲里对应的提问。
   * 判定不出来时保持原值（不清空，避免高亮闪没）。
   */
  const syncActive = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const viewportTop = scrollEl.getBoundingClientRect().top;
    const viewportBottom = viewportTop + scrollEl.clientHeight;
    const rendered = scrollEl.querySelectorAll<HTMLElement>("[data-message-entry-id]");
    // 取「真正最靠上」的可见消息：不能取 DOM 顺序里的第一个（计划顺序≠几何顺序，
    // 会整体差一条提问），按 top 比较才与滚动位置严格对应。
    let topVisibleEntryId: string | null = null;
    let topVisibleTop = Number.POSITIVE_INFINITY;
    let nearestAboveEntryId: string | null = null;
    let nearestAboveTop = Number.NEGATIVE_INFINITY;
    for (const el of rendered) {
      const entryId = el.getAttribute("data-message-entry-id");
      if (!entryId) continue;
      const top = el.getBoundingClientRect().top;
      if (top >= viewportTop && top <= viewportBottom) {
        if (top < topVisibleTop) {
          topVisibleTop = top;
          topVisibleEntryId = entryId;
        }
      } else if (top < viewportTop && top > nearestAboveTop) {
        // 视口上方最近的一条：视口内没有任何消息时用它当锚点
        nearestAboveTop = top;
        nearestAboveEntryId = entryId;
      }
    }
    const resolved = resolveActiveOutlineEntry({
      outline,
      loadedEntryIds: entryIds,
      topVisibleEntryId: topVisibleEntryId ?? nearestAboveEntryId,
      isAtLiveTail,
    });
    if (resolved !== null) setActiveEntryId(resolved);
  }, [entryIds, isAtLiveTail, outline, scrollContainer]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    el.addEventListener("scroll", syncActive, { passive: true });
    const ro = new ResizeObserver(syncActive);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    syncActive();
    return () => {
      el.removeEventListener("scroll", syncActive);
      ro.disconnect();
    };
  }, [scrollContainer, syncActive]);
  useEffect(() => {
    const timer = setTimeout(syncActive, 60);
    return () => clearTimeout(timer);
  }, [messages.length, outline.length, syncActive]);

  // 轨道高度用于把横线换算成像素（悬浮卡定位的前提）
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const update = () => setRailHeight(el.clientHeight);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, [outline.length]);

  /** 悬浮卡顶边：贴着对应横线的实际位置，并夹在轨道可视范围内。 */
  const cardTop = useCallback((position: number): number => {
    const rail = railRef.current;
    const dash = dashRefs.current[position];
    const railBox = rail?.getBoundingClientRect();
    const dashBox = dash?.getBoundingClientRect();
    const anchor = railBox && dashBox
      ? dashBox.top - railBox.top + dashBox.height / 2
      : railHeight / 2;
    const maxTop = Math.max(CARD_EDGE_MARGIN, railHeight - CARD_MAX_HEIGHT - CARD_EDGE_MARGIN);
    return Math.max(CARD_EDGE_MARGIN, Math.min(maxTop, anchor - CARD_MAX_HEIGHT / 2));
  }, [railHeight]);

  /**
   * 跳到某条提问。
   *
   * 顺序刻意是「先加载、后滚动」：定位会整体替换时间线（目标 → 最新整段），
   * 若先滚动再让内容陆续加载，滚动位置会被后续布局不断顶掉，而且运行中会话的
   * 尾部流式输出会跟着抖动。所以：
   * 1) 已在渲染窗口内 → 直接滚动（无网络往返）；
   * 2) 否则请求服务端按 entryId 定位（窗口一直取到最新，保留尾部流式段），
   *    等目标真正渲染出来再**瞬时**滚动（smooth 会被持续追加的内容打断）；
   * 3) 服务端失败 → 退回「撑开渲染窗口」的本地兜底。
   */
  const jumpTo = useCallback(async (entryId: string) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl || jumpingTo) return;
    const findTarget = (): HTMLElement | null =>
      resolveMessageElementRef.current?.(entryId) ?? null;
    /**
     * 把目标滚到视口顶部：等一帧布局稳定后瞬时定位一次，再校正一次。
     * （定位会整体替换时间线，跟随几帧内还会因图片/折叠块改变高度。）
     */
    const scrollToTarget = (el: HTMLElement) => {
      const place = () => {
        if (!el.isConnected) return;
        const top = el.getBoundingClientRect().top
          - scrollEl.getBoundingClientRect().top
          + scrollEl.scrollTop;
        scrollEl.scrollTo({ top, behavior: "auto" });
      };
      requestAnimationFrame(() => {
        place();
        // 高亮交给 syncActive 统一推导（它会看到目标已在视口内）
        syncActive();
        // 布局二次稳定后校正一次（只校正，不再循环抢滚）
        window.setTimeout(() => {
          place();
          syncActive();
        }, 250);
      });
    };

    // 等目标进入 DOM（服务端定位后需要一拍渲染）
    const waitForTarget = async (): Promise<HTMLElement | null> => {
      for (let i = 0; i < 10; i += 1) {
        const target = findTarget() ?? (expandRenderWindowToEntryRef.current?.(entryId) ? findTarget() : null);
        if (target) return target;
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
      return null;
    };

    const immediate = await waitForTarget();
    if (immediate) {
      scrollToTarget(immediate);
      return;
    }
    setJumpingTo(entryId);
    try {
      const located = await jumpToEntry(entryId);
      if (!located) return;
      const target = await waitForTarget();
      if (target) scrollToTarget(target);
    } finally {
      setJumpingTo(null);
    }
  }, [expandRenderWindowToEntryRef, jumpToEntry, jumpingTo, resolveMessageElementRef, scrollContainer, syncActive]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = hovered === null ? 0 : outline.findIndex((item) => item.ordinal === hovered);
    const next = event.key === "ArrowDown"
      ? Math.min(outline.length - 1, current + 1)
      : Math.max(0, current - 1);
    const item = outline[next];
    if (!item) return;
    setHovered(item.ordinal);
    void jumpTo(item.entryId);
  }, [hovered, outline, jumpTo]);

  // 无提问、或轨道太矮（横线会挤在一起）时整条隐藏。
  if (outline.length === 0 || (railHeight > 0 && railHeight < MIN_USABLE_HEIGHT_PX)) return null;

  // 横线数量 × 间距 超出轨道高度 → 允许滚动（否则首尾被裁掉、点不到）
  const listHeight = outline.length * (14 + DASH_GAP) - DASH_GAP;
  const listOverflows = listHeight > LIST_MAX_HEIGHT_PX;
  const hoveredPosition = hovered === null ? null : outline.findIndex((item) => item.ordinal === hovered);
  const activePosition = activeEntryId === null
    ? -1
    : outline.findIndex((item) => item.entryId === activeEntryId);

  return (
    <div
      ref={railRef}
      data-message-nav="true"
      role="navigation"
      aria-label={t("nav_userMessages")}
      onKeyDown={onKeyDown}
      onMouseLeave={() => setHovered(null)}
      style={{
        width: CHAT_GUTTER,
        height: "100%",
        position: "relative",
        userSelect: "none",
      }}
    >
      {/* 短横线：整体在轨道内上下居中，条间固定间距（不随数量拉伸铺满） */}
      <div
        style={{
          position: "absolute",
          // 垂直居中，并限制最大高度：超出后列表内部滚动
          top: "50%",
          transform: "translateY(-50%)",
          left: 0,
          right: 0,
          maxHeight: `min(${LIST_MAX_HEIGHT_PX}px, 100%)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: listOverflows ? "flex-start" : "center",
          gap: DASH_GAP,
          overflowY: "auto",
          scrollbarWidth: "none",
        }}
      >
        {outline.map((item, position) => {
          const isHovered = hovered === item.ordinal;
          const isActive = activePosition === position;
          const isJumping = jumpingTo === item.entryId;
          return (
            <button
              key={item.entryId}
              type="button"
              data-nav-index={item.ordinal}
              data-nav-entry={item.entryId}
              ref={(el) => {
                dashRefs.current[position] = el;
              }}
              aria-label={messageNavPreview(item.text) || t("nav_userMessages")}
              aria-current={isActive ? "true" : undefined}
              disabled={isJumping}
              onClick={() => void jumpTo(item.entryId)}
              onMouseEnter={() => setHovered(item.ordinal)}
              onFocus={() => setHovered(item.ordinal)}
              style={{
                width: DASH_WIDTH + 6,
                height: 14,
                flexShrink: 0,
                padding: 0,
                border: "none",
                background: "none",
                cursor: isJumping ? "progress" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "block",
                  // 悬浮：变黑（--text 最深）且长度翻倍，便于指哪打哪
                  width: isHovered ? DASH_WIDTH * 2 : DASH_WIDTH,
                  height: DASH_HEIGHT,
                  borderRadius: DASH_HEIGHT / 2,
                  background: isHovered ? "var(--text)" : isActive ? "var(--text-dim)" : "var(--border)",
                  transition: "width 0.1s, background 0.1s",
                }}
              />
            </button>
          );
        })}
      </div>

      {/* 悬浮信息卡：有最大宽高，超出省略号截断；贴着轨道右侧、按需上下收敛 */}
      {hoveredPosition !== null && outline[hoveredPosition] && (
        <div
          role="tooltip"
          data-nav-preview="true"
          style={{
            position: "absolute",
            left: "100%",
            top: cardTop(hoveredPosition),
            width: CARD_MAX_WIDTH,
            maxWidth: CARD_MAX_WIDTH,
            maxHeight: CARD_MAX_HEIGHT,
            overflow: "hidden",
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            boxShadow: "0 6px 24px rgba(0,0,0,0.16)",
            color: "var(--text)",
            fontSize: 12,
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            display: "-webkit-box",
            WebkitLineClamp: 10,
            WebkitBoxOrient: "vertical",
            pointerEvents: "none",
            zIndex: 60,
          }}
        >
          {outline[hoveredPosition].text.trim() || t("nav_userMessages")}
        </div>
      )}
    </div>
  );
}

/** 预览单行化（用于 aria-label：悬浮信息卡展示原文）。 */
export function messageNavPreview(text: string, maxLength = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}
