"use client";

/**
 * 会话区左侧的用户消息导航条（对齐 codex app 的左侧用户消息导航）：
 * - 每条用户消息一个**短横线**，沿轨道等距排布（不是按比例的小地图）；
 * - 鼠标悬浮显示信息卡：消息正文，卡片有最大宽高，超出省略号截断；
 * - 当前所在位置的那条渲染为深色（其余浅灰）；点击跳到该消息顶部。
 *
 * 与右侧 ChatMinimap 的分工：minimap 是整轮对话总览（用户+助手+视口框+拖拽滚动），
 * 本导航条只列用户消息，用于「快速跳到第 N 条提问」。
 *
 * 数据源与 minimap 相同：ChatWindow 传入的统一渲染计划（live 与磁盘消息同序），
 * 消息 DOM 引用经 messageRefs 复用（同一套可见消息槽位）。
 * 布局：本组件宽 CHAT_GUTTER px（与右侧 ChatMinimap 等宽），是会话列两侧的对称竖条。
 */

import { useCallback, useEffect, useMemo, useRef, useState, RefObject } from "react";
import type { AgentMessage } from "@/lib/types";
import { getChatPlanLiveMessage, trailingLiveUserStart, type ChatRenderPlanItem } from "@/lib/chat-compositor";
import { useI18n } from "@/lib/i18n";
import { CHAT_GUTTER } from "@/lib/chat-column";

interface Props {
  messages: AgentMessage[];
  /** 统一渲染计划（含 live slot）：与 ChatMinimap 共用同一顺序 */
  plan: ChatRenderPlanItem[];
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
}

/** 轨道上下内缩：首尾横线不贴边。 */
const NAV_INSET_PX = 12;
/** 短横线：12×2，圆角 1 —— 与设计稿一致（浅灰；当前项深色）。 */
const DASH_WIDTH = 12;
const DASH_HEIGHT = 2;
/** 相邻短横线间距（列表整体上下居中）。 */
const DASH_GAP = 9;
/** 轨道太矮（横线挤在一起）则整条隐藏。 */
const MIN_USABLE_HEIGHT_PX = 120;
/** 信息卡最大宽高：超出省略号截断，避免长消息把卡片撑爆。 */
const CARD_MAX_WIDTH = 340;
const CARD_MAX_HEIGHT = 180;
const CARD_EDGE_MARGIN = 8;

export interface MessageNavNode {
  /** 在 allMessages 中的下标（定位 + 点击跳转） */
  index: number;
  /** 滚动内容中的相对位置 0–1 */
  topRatio: number;
  /** 完整消息文本（悬浮预览） */
  text: string;
  /** 消息 DOM 引用下标（可见消息序列） */
  refIndex: number;
}

/** 用户消息纯文本：字符串或 text 块拼接（与渲染层同样的取值语义）。 */
export function userMessageText(message: AgentMessage | Partial<AgentMessage>): string {
  if (message.role !== "user") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as { type: string; text?: string }[])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
  }
  return "";
}

/** 预览单行化（仅用于 aria-label：悬浮信息卡展示原文）。 */
export function messageNavPreview(text: string, maxLength = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

/**
 * 按 DOM 引用测量每个用户消息在滚动内容中的相对位置（读 DOM，不含状态）。
 *
 * ref 槽位编号必须与 ChatWindow 完全一致：ChatWindow 先按**消息顺序**给可见消息
 * （user/assistant）编号（visibleRefIndexByMessage），再在按**计划顺序**渲染时用
 * 该编号取槽位。因此这里不能按计划顺序自己累加（process group 会让两者错位），
 * 而是通过 slotOf 查表。
 */
export function measureUserMessageNodes(input: {
  plan: ChatRenderPlanItem[];
  refs: ReadonlyArray<HTMLDivElement | null>;
  scrollEl: Pick<HTMLElement, "scrollHeight" | "getBoundingClientRect" | "scrollTop">;
  /** 消息下标 → ref 槽位（仅可见消息 user/assistant 有槽位）；与 ChatWindow 同判据 */
  slotOf: (messageIndex: number) => number | undefined;
  isUserMessage: (index: number) => boolean;
  textOf: (index: number) => string;
}): MessageNavNode[] {
  const { plan, refs, scrollEl, slotOf, isUserMessage, textOf } = input;
  const totalH = scrollEl.scrollHeight;
  if (!totalH || totalH <= 0) return [];
  const containerTop = scrollEl.getBoundingClientRect().top;
  const out: MessageNavNode[] = [];

  /** 计划项代表的消息下标：message 项看自身，processGroup 看它的代表消息。 */
  const targetOf = (item: ChatRenderPlanItem): number | undefined => {
    if (item.kind === "message") {
      if (!item.attachRef) return undefined;
      const index = item.messageIndex as number | null | undefined;
      return index === null || index === undefined ? undefined : index;
    }
    return item.attachRefMessageIndex;
  };

  for (const item of plan) {
    const target = targetOf(item);
    if (target === undefined || !isUserMessage(target)) continue;
    const slot = slotOf(target);
    if (slot === undefined) continue;
    const el = refs[slot];
    if (!el) continue;
    const top = el.getBoundingClientRect().top - containerTop + scrollEl.scrollTop;
    out.push({
      index: target,
      refIndex: slot,
      topRatio: Math.max(0, Math.min(1, top / totalH)),
      text: textOf(target),
    });
  }
  return out;
}

export function MessageNavRail({ messages, plan, scrollContainer, messageRefs }: Props) {
  const { t } = useI18n();
  const [nodes, setNodes] = useState<MessageNavNode[]>([]);
  const [viewport, setViewport] = useState({ top: 0, height: 1 });
  const [hovered, setHovered] = useState<number | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  /** 每条横线的 DOM（悬浮卡按其实际位置定位，避免等距数学与实际布局漂移） */
  const dashRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const measureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;
  // plan 由父组件每次渲染重建（composeChatPlan 未 memo）：只经 ref 读取，
  // 避免 measure 身份变化导致节流定时器被反复清空、测量永不执行。
  const planRef = useRef(plan);
  planRef.current = plan;

  const measure = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const messages = allMessagesRef.current;
    // 与 ChatWindow 同判据：可见消息按消息顺序编号（下标即槽位）
    const slotOf = (index: number) => {
      const role = messages[index]?.role;
      if (role !== "user" && role !== "assistant") return undefined;
      let slot = 0;
      for (let i = 0; i < index; i += 1) {
        const r = messages[i]?.role;
        if (r === "user" || r === "assistant") slot += 1;
      }
      return slot;
    };
    const measured = measureUserMessageNodes({
      plan: planRef.current,
      refs: messageRefs.current ?? [],
      scrollEl,
      slotOf,
      isUserMessage: (index) => messages[index]?.role === "user",
      textOf: (index) => userMessageText(messages[index] ?? {}),
    });
    setNodes(measured);
    const scrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
    setViewport({
      top: scrollable > 0 ? scrollEl.scrollTop / scrollEl.scrollHeight : 0,
      height: scrollEl.scrollHeight > 0 ? scrollEl.clientHeight / scrollEl.scrollHeight : 1,
    });
  }, [scrollContainer, messageRefs]);

  /**
   * 节流测量（尾随）：流式期间 DOM 高度持续变化，150ms 足够跟手且不引发布局抖动。
   * 关键：突发期间的后续事件必须记下来，否则首帧测量会落在「消息 DOM 还没挂完」
   * 的时刻并且不再补测 —— 表现为导航条时有时无（实测只测到 1 条用户消息）。
   */
  const pendingMeasureRef = useRef(false);
  const scheduleMeasure = useCallback(() => {
    if (measureTimerRef.current) {
      pendingMeasureRef.current = true;
      return;
    }
    measureTimerRef.current = setTimeout(() => {
      measureTimerRef.current = null;
      measure();
      if (pendingMeasureRef.current) {
        pendingMeasureRef.current = false;
        scheduleMeasure();
      }
    }, 150);
  }, [measure]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    el.addEventListener("scroll", scheduleMeasure, { passive: true });
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    scheduleMeasure();
    return () => {
      el.removeEventListener("scroll", scheduleMeasure);
      ro.disconnect();
      if (measureTimerRef.current) {
        clearTimeout(measureTimerRef.current);
        measureTimerRef.current = null;
      }
    };
  }, [scrollContainer, scheduleMeasure]);

  // 消息/计划变化后补测几次：ref 挂载发生在 React 提交之后，单次延迟测不准。
  useEffect(() => {
    const timers = [0, 120, 400].map((delay) => setTimeout(measure, delay));
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, [messages.length, plan.length, measure]);

  // 轨道高度用于把比例换算成像素（节点定位的前提）。
  // 首帧 nodes 为空 → 组件返回 null → railRef 尚未挂载，故依赖 nodes.length 重跑。
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    const update = () => setRailHeight(el.clientHeight);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => ro.disconnect();
  }, [nodes.length]);

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

  const jumpTo = useCallback((index: number) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const node = nodes.find((item) => item.index === index);
    const target = node ? messageRefs.current?.[node.refIndex] : null;
    if (!target) return;
    const top = target.getBoundingClientRect().top
      - scrollEl.getBoundingClientRect().top
      + scrollEl.scrollTop;
    scrollEl.scrollTo({ top, behavior: "smooth" });
  }, [nodes, scrollContainer, messageRefs]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = hovered ?? 0;
    const next = event.key === "ArrowDown"
      ? Math.min(nodes.length - 1, current + 1)
      : Math.max(0, current - 1);
    setHovered(next);
  }, [hovered, nodes.length]);

  // 无用户消息、或轨道太矮（横线会挤在一起）时整条隐藏。
  if (nodes.length === 0 || (railHeight > 0 && railHeight < MIN_USABLE_HEIGHT_PX)) return null;

  // 当前项：视口内最靠下的一条用户消息（滚到底时即最后一条 → 渲染为深色）。
  // topRatio 与 viewport 都是「占滚动内容高度的比例」，可直接比较。
  const viewportBottomRatio = viewport.top + viewport.height;
  let activeIndex: number | null = null;
  nodes.forEach((node, position) => {
    if (node.topRatio <= viewportBottomRatio) activeIndex = position;
  });
  const hoveredPosition = hovered === null ? null : nodes.findIndex((node) => node.index === hovered);

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
          top: NAV_INSET_PX,
          bottom: NAV_INSET_PX,
          left: 0,
          right: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: DASH_GAP,
          overflow: "hidden",
        }}
      >
        {nodes.map((node, position) => {
          const isHovered = hovered === node.index;
          const isActive = activeIndex === position;
          return (
            <button
              key={node.index}
              type="button"
              data-nav-index={node.index}
              ref={(el) => {
                dashRefs.current[position] = el;
              }}
              aria-label={messageNavPreview(node.text) || t("nav_userMessages")}
              aria-current={isActive ? "true" : undefined}
              onClick={() => jumpTo(node.index)}
              onMouseEnter={() => setHovered(node.index)}
              onFocus={() => setHovered(node.index)}
              style={{
                width: DASH_WIDTH + 6,
                height: 14,
                flexShrink: 0,
                padding: 0,
                border: "none",
                background: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "block",
                  width: DASH_WIDTH,
                  height: DASH_HEIGHT,
                  borderRadius: DASH_HEIGHT / 2,
                  background: isActive || isHovered ? "var(--text)" : "var(--border)",
                  transition: "background 0.1s",
                }}
              />
            </button>
          );
        })}
      </div>

      {/* 悬浮信息卡：有最大宽高，超出省略号截断；贴着轨道右侧、按需上下收敛 */}
      {hoveredPosition !== null && nodes[hoveredPosition] && (
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
          {nodes[hoveredPosition].text.trim() || t("nav_userMessages")}
        </div>
      )}
    </div>
  );
}
