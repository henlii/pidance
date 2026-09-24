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

import { useCallback, useEffect, useRef, useState, RefObject } from "react";
import { resolveActiveOutlineEntry, type UserMessageOutlineItem } from "@/lib/session-outline";
import { useI18n } from "@/lib/i18n";
import { CHAT_GUTTER } from "@/lib/chat-column";
import type { MessageJumpRailHandle } from "@/hooks/useMessageJump";
import { getBottomZoneSize } from "@/lib/chat-auto-follow";

interface Props {
  /**
   * 渲染批次标识（消息数 + 已加载 entryId 数）。
   * 只在它变化时重新收集 `[data-message-entry-id]` 元素 —— 滚动事件每帧都会到，
   * 不能每次都做全量 DOM 查询（长会话几百个元素，是滚动卡顿的主因）。
   */
  renderKey: string;
  scrollContainer: RefObject<HTMLDivElement | null>;
  /** 会话全部用户消息大纲（服务端只读投影；空 = 尚未取到） */
  outline: UserMessageOutlineItem[];
  /** 已加载消息的 entryId 列表（与 messages 平行同序；来自 useAgentSession） */
  entryIds: string[];
  /**
   * 跳转实现（`hooks/useMessageJump`）。
   *
   * 为什么从外面传进来：定位请求由会话外发起（全文搜索命中），而本组件在手机端
   * 不挂载、没有提问时也返回 null —— 消费逻辑留在本组件里就会漏掉这些场景。
   * 机制归 ChatWindow（始终挂载），本组件只做交互与视觉。
   */
  jumpTo: (entryId: string) => Promise<boolean>;
  /** 正在跳转的目标（视觉态，由 useMessageJump 持有） */
  jumpingTo: string | null;
  /** 跳转期间的钉住目标：syncActive 读它，跳过按旧视口改写高亮 */
  jumpPinRef: RefObject<string | null>;
  /** 把本导航条的 syncActive 与「即刻设当前项」注册给 useMessageJump */
  railHandleRef: RefObject<MessageJumpRailHandle | null>;
  /** 当前窗口是否就是最新一段（用于「窗口内没有提问」时判定当前提问） */
  isAtLiveTail: boolean;
}

/** 短横线：12×2，圆角 1 —— 与设计稿一致（浅灰；当前项深色）。 */
const DASH_WIDTH = 12;
const DASH_HEIGHT = 2;
/** 相邻短横线间距（列表整体上下居中）；比初版减半，长会话更紧凑。 */
const DASH_GAP = 4;
/** 列表最大高度：超出后内部滚动（横线再多也够得到）。 */
const LIST_MAX_HEIGHT_PX = 320;
/** 横线相对轨道左侧的内缩：贴边太紧，视觉上像被裁掉。 */
const DASH_LEFT_INSET_PX = 4;
/** 上下滚动指示器：小三角尺寸（宽 8 × 高 5）。 */
const SCROLL_HINT_HALF_WIDTH = 4;
const SCROLL_HINT_HEIGHT = 5;
/** 轨道太矮（横线挤在一起）则整条隐藏。 */
const MIN_USABLE_HEIGHT_PX = 120;
/** 信息卡最大宽高：超出省略号截断，避免长消息把卡片撑爆。 */
const CARD_MAX_WIDTH = 340;
const CARD_MAX_HEIGHT = 180;
const CARD_EDGE_MARGIN = 8;

export function MessageNavRail({
  renderKey,
  scrollContainer,
  outline,
  entryIds,
  jumpTo,
  jumpingTo,
  jumpPinRef,
  railHandleRef,
  isAtLiveTail,
}: Props) {
  const { t } = useI18n();
  const [railHeight, setRailHeight] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  /** 当前高亮：滚动位置对应的「最后一条已滚过」用户消息 entryId */
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  /** 已加载 entryId 列表与「还有更早历史」的 ref 镜像：jump 循环里读最新值 */
  const entryIdsRef = useRef<string[]>(entryIds);
  entryIdsRef.current = entryIds;
  const railRef = useRef<HTMLDivElement>(null);
  const dashRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /**
   * 更新「当前在哪条提问」。
   *
   * 只渲染末尾若干条计划项，长会话里大多数提问（含视口所在那条）可能都没渲染，
   * 所以不能只看用户消息元素：先找「视口内最靠上的已渲染消息」（任意角色，
   * 带 data-message-entry-id），再用它在加载窗口中的位置推导大纲里对应的提问。
   * 判定不出来时保持原值（不清空，避免高亮闪没）。
   */
  /**
   * 当前所在提问的锚点测量。
   *
   * 性能约定（滚动事件每帧都会到，这里是热点）：
   * - 元素列表按「渲染批次」缓存，不在每次滚动时重新 querySelectorAll；
   * - 只对「可能与视口相交」的元素取 getBoundingClientRect —— 通过缓存的
   *   偏移区间先做一次廉价筛选，避免对几百个消息元素逐个强制同步布局。
   */
  const renderedElsRef = useRef<HTMLElement[]>([]);
  /** 内层纵向滚动容器：长会话里导航条自身也要跟着当前项滚。 */
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 轨道能否向上/向下滚动（上下指示器据此显隐）。 */
  const [railScroll, setRailScroll] = useState({ up: false, down: false });
  /** 系统是否要求减少动画（滚动动画、长度/淡入过渡均据此降级）。 */
  const [reducedMotion, setReducedMotion] = useState(() => prefersReducedMotion());
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);
  const syncRailScrollHints = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const next = railScrollHints({
      scrollTop: list.scrollTop,
      viewportHeight: list.clientHeight,
      contentHeight: list.scrollHeight,
    });
    // 不变则保留旧对象，避免无意义重渲染（滚动事件每帧可能触发）
    setRailScroll((prev) => (prev.up === next.up && prev.down === next.down ? prev : next));
  }, []);
  const renderedCacheKeyRef = useRef("");
  const measureOffsetRef = useRef(0);

  /**
   * 跳转进行中「钉住」的目标：期间 syncActive 不得按旧视口改写当前项。
   *
   * 现象（用户实测）：点击导航点后，导航条先跳到目标，随后跟随内容滚动回到原位置，
   * 再滚回目标。成因是跳转需要「替换时间线 → 等渲染 → 平滑滚动到位」好几拍，
   * 期间 scroll 事件/定时器会按**当时的旧视口**解析出旧当前项并将高亮改回去。
   * 钉住期间跳过解析，跳转结束时（stopWatching）解除。
   *
   * ref 归 useMessageJump 持有（跳转机制在那里），本组件只读它。
   */

  const syncActive = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    // 跳转进行中：当前项由点击意图决定，不按中途视口改写
    if (jumpPinRef.current !== null) return;
    const viewportTop = scrollEl.getBoundingClientRect().top;
    const viewportBottom = viewportTop + scrollEl.clientHeight;
    // 缓存失效条件：渲染批次变化（内容变了才重新收集元素）
    if (renderedCacheKeyRef.current !== renderKey) {
      renderedCacheKeyRef.current = renderKey;
      renderedElsRef.current = Array.from(
        scrollEl.querySelectorAll<HTMLElement>("[data-message-entry-id]"),
      );
    }
    const rendered = renderedElsRef.current;
    measureOffsetRef.current += 1;
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
        nearestAboveTop = top;
        nearestAboveEntryId = entryId;
      }
    }
    const resolved = resolveActiveOutlineEntry({
      outline,
      loadedEntryIds: entryIds,
      topVisibleEntryId: topVisibleEntryId ?? nearestAboveEntryId,
      isAtLiveTail,
      // 贴底（与回到底部/恢复跟随同一区域）：当前提问就是最后一条。
      // 不这样判的话，末轮很短时视口顶部落在更早的轮次里，导航条会停在倒数第二格。
      isAtScrollBottom:
        scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight
        <= getBottomZoneSize(scrollEl.clientHeight, false),
    });
    if (resolved !== null) setActiveEntryId(resolved);
  }, [entryIds, isAtLiveTail, outline, renderKey, scrollContainer, jumpPinRef]);

  /**
   * 总是拿到「最新一次渲染」的 syncActive。
   *
   * jumpTo 是异步流程：等待期间时间线会被换成新窗口并重渲染，而流程末尾若直接调用
   * 当初捕获的 syncActive，它闭包里还是旧的 entryIds/outline —— 会按旧窗口解析出旧
   * 的高亮（实测：跳转后仍高亮跳转前那条，手动滚动一下才正常，因为滚动事件用的是
   * 最新闭包）。
   */
  // 注册给跳转机制（hooks/useMessageJump）：它跑在 ChatWindow 侧（三端都在），
  // 需要本组件的高亮状态与重算能力。导航条不挂载时 ref 为空，跳转流程不依赖它。
  railHandleRef.current = { setActive: setActiveEntryId, syncActive };
  // 卸载时注销：否则 stale 的 setActive/syncActive 会继续被跳转流程调用
  useEffect(() => () => { railHandleRef.current = null; }, [railHandleRef]);

  /** 供滚动效果读取：避免把 reducedMotion 写进回调依赖而重建滚动逻辑。 */
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  /** 正在运行的导航条滚动动画（rAF）；新动画开始或卸载时必须取消。 */
  const railTweenRef = useRef<number | null>(null);
  /** 当前动画的目标位置：动画进行中重复请求同一目标要跳过，不能每帧重启动画。 */
  const railTweenTargetRef = useRef<number | null>(null);
  const cancelRailTween = useCallback(() => {
    if (railTweenRef.current !== null) {
      cancelAnimationFrame(railTweenRef.current);
      railTweenRef.current = null;
    }
    railTweenTargetRef.current = null;
  }, []);

  /**
   * 滚到目标位置：自控时长与缓动（原生 smooth 时长不可调）。
   * 小位移与 reduced-motion 直接瞬时到位，不做动画。
   */
  const scrollRailTo = useCallback((list: HTMLElement, targetTop: number) => {
    cancelRailTween();
    railTweenTargetRef.current = targetTop;
    const from = list.scrollTop;
    const behavior = railScrollBehavior({
      reducedMotion: reducedMotionRef.current,
      currentTop: from,
      targetTop,
    });
    if (behavior === "auto") {
      list.scrollTop = targetTop;
      railTweenTargetRef.current = null;
      return;
    }
    const delta = targetTop - from;
    const startedAt = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / RAIL_SCROLL_DURATION_MS);
      list.scrollTop = from + delta * easeInOutCubic(progress);
      if (progress < 1) {
        railTweenRef.current = requestAnimationFrame(step);
        return;
      }
      railTweenRef.current = null;
      railTweenTargetRef.current = null;
    };
    railTweenRef.current = requestAnimationFrame(step);
  }, [cancelRailTween]);

  useEffect(() => cancelRailTween, [cancelRailTween]);
  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    // 滚动事件每帧可能触发多次：用 rAF 合并成「一帧最多测一次」。
    let frame: number | null = null;
    const onScroll = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        syncActive();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // 布局变化同样合并到帧（ResizeObserver 在内容增删时会连续触发）
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    syncActive();
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [scrollContainer, syncActive]);
  useEffect(() => {
    const timer = setTimeout(syncActive, 60);
    return () => clearTimeout(timer);
  }, [renderKey, outline.length, syncActive]);

  // 让当前项始终停在轨道中部（长会话里导航条自己也会溢出）。
  // 用即时定位而非平滑动画：它是对滚动的跟随，不是一次性跳转。
  //
  // 用 ref 读「最新值」而不是闭包捕获：这一步要能被布局观察者（内容/尺寸变化）
  // 重复调用，不能只靠 props 身份变化。之前只在 activeEntryId/outline 身份变时跑，
  // 首帧列表还没布局（或格子还没挂上）就再也没有第二次 —— 导航条便停在旧位置，
  // 直到某次偶然的大纲重取才补上（用户报的「有时候不会自动滚到最后一条」）。
  const activeEntryIdRef = useRef<string | null>(null);
  activeEntryIdRef.current = activeEntryId;
  const outlineRef = useRef(outline);
  outlineRef.current = outline;
  /** 首帧未布局时的一次性补测（rAF），同一个 key 只补一次，不无限重试。 */
  const followRetryRef = useRef<number | null>(null);
  const followAttemptKeyRef = useRef<string>("");
  const centerActiveInRail = useCallback(() => {
    const list = listRef.current;
    const currentOutline = outlineRef.current;
    const active = activeEntryIdRef.current;
    const position = active === null ? -1 : currentOutline.findIndex((item) => item.entryId === active);
    const el = position >= 0 ? dashRefs.current[position] ?? null : null;
    const plan = railFollowPlan({
      hasActive: position >= 0,
      hasItem: el !== null,
      clientHeight: list?.clientHeight ?? 0,
      contentHeight: list?.scrollHeight ?? 0,
    });
    if (plan === "skip") return;
    if (plan === "retry") {
      const key = `${active ?? ""}|${position}|${currentOutline.length}`;
      if (followAttemptKeyRef.current === key) return;
      followAttemptKeyRef.current = key;
      if (followRetryRef.current === null) {
        followRetryRef.current = requestAnimationFrame(() => {
          followRetryRef.current = null;
          centerActiveInRail();
        });
      }
      return;
    }
    if (!list || !el) return;
    const listRect = list.getBoundingClientRect();
    const itemRect = el.getBoundingClientRect();
    const next = centeredRailScrollTop({
      scrollTop: list.scrollTop,
      viewportHeight: list.clientHeight,
      contentHeight: list.scrollHeight,
      itemTop: itemRect.top - listRect.top + list.scrollTop,
      itemHeight: itemRect.height,
    });
    if (Math.abs(next - list.scrollTop) < 1) return;
    // 动画进行中且目标未变：不能重启（每帧重启动画会让它永远走不到位）。
    if (
      railTweenRef.current !== null
      && railTweenTargetRef.current !== null
      && Math.abs(railTweenTargetRef.current - next) < 1
    ) {
      return;
    }
    // 自己插值而不是用原生 smooth：后者的时长不可控且偏快。
    // 大位移→动画；跟随的微小校正 / reduced-motion→瞬时。
    scrollRailTo(list, next);
    // 居中后滚动位置变了，指示器需同步（scroll 事件也会到，这里保证首帧就对）
    syncRailScrollHints();
  }, [scrollRailTo, syncRailScrollHints]);

  useEffect(() => {
    centerActiveInRail();
  }, [activeEntryId, outline, railHeight, centerActiveInRail]);

  useEffect(() => () => {
    if (followRetryRef.current !== null) cancelAnimationFrame(followRetryRef.current);
  }, []);

  // 上下指示器的显隐跟随轨道的实际可滚状态（内容高度变化 / 尺寸变化）；
  // 同时是「补上跟随」的第二个入口：列表内容/尺寸变了就重新居中一次。
  // 注意：**不在列表 scroll 事件里重居中** —— 重居中自身会写 scrollTop，
  // 那会每帧取消并重启动画（实测永远走不到位）。
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onScroll = () => syncRailScrollHints();
    const onResize = () => {
      syncRailScrollHints();
      centerActiveInRail();
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(onResize);
    ro.observe(list);
    if (list.firstElementChild) ro.observe(list.firstElementChild);
    onResize();
    return () => {
      list.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [syncRailScrollHints, centerActiveInRail, outline.length, railHeight]);

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
      {/* 短横线：整体在轨道内上下居中，条间固定间距（不随数量拉伸铺满）。
          分两层是为了「纵向可滚 + 横向永不裁」：外层只做垂直居中与限高（overflow 保持
          visible，否则会把相邻的 overflowX 强制成 auto 而裁掉悬浮加长部分），
          内层才是真正的纵向滚动容器。 */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          transform: "translateY(-50%)",
          left: DASH_LEFT_INSET_PX,
          maxHeight: `min(${LIST_MAX_HEIGHT_PX}px, 100%)`,
          display: "flex",
          flexDirection: "column",
        }}
      >
      {/* 上下指示器：轨道内容高于自身时才有意义；颜色与未选中的导航点一致。
          绝对定位在「垂直居中包裹层」的上下方，因此不影响横线的居中与限高。
          始终挂载、用 opacity 淡入淡出（条件挂载无法做过渡）；装饰性且不可交互。 */}
      <span
        aria-hidden="true"
        data-nav-scroll-hint="up"
        style={{
          position: "absolute",
          top: -(SCROLL_HINT_HEIGHT + 4),
          left: (DASH_WIDTH - SCROLL_HINT_HALF_WIDTH * 2) / 2,
          width: 0,
          height: 0,
          borderLeft: `${SCROLL_HINT_HALF_WIDTH}px solid transparent`,
          borderRight: `${SCROLL_HINT_HALF_WIDTH}px solid transparent`,
          borderBottom: `${SCROLL_HINT_HEIGHT}px solid var(--border)`,
          opacity: railScroll.up ? 1 : 0,
          transition: reducedMotion ? "none" : "opacity 0.18s ease",
          pointerEvents: "none",
        }}
      />
      <div
        ref={listRef}
        style={{
          display: "flex",
          flexDirection: "column",
          // 悬浮加长（12 → 24px）比轨道宽：靠左对齐，加长部分向右伸出而不被裁
          alignItems: "flex-start",
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
                // 按钮定宽 = 悬浮加长后的宽度：加长时不会撑出横向滚动，也不会被裁
                width: DASH_WIDTH * 2,
                height: 14,
                flexShrink: 0,
                padding: 0,
                border: "none",
                background: "none",
                cursor: isJumping ? "progress" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "block",
                  // 悬浮或当前项：变长（DASH_WIDTH → 2×）便于指哪打哪。
                  // 当前项长度翻倍是刻意的：长会话里它是唯一需要「随时看见」的项。
                  width: isHovered || isActive ? DASH_WIDTH * 2 : DASH_WIDTH,
                  height: DASH_HEIGHT,
                  borderRadius: DASH_HEIGHT / 2,
                  background: isHovered ? "var(--text)" : isActive ? "var(--text-dim)" : "var(--border)",
                  // 长度/颜色过渡：比 0.1s 稍长并缓动，当前项换位时更柔和。
                  transition: reducedMotion ? "none" : "width 0.18s ease, background 0.18s ease",
                }}
              />
            </button>
          );
        })}
      </div>
      <span
        aria-hidden="true"
        data-nav-scroll-hint="down"
        style={{
          position: "absolute",
          bottom: -(SCROLL_HINT_HEIGHT + 4),
          left: (DASH_WIDTH - SCROLL_HINT_HALF_WIDTH * 2) / 2,
          width: 0,
          height: 0,
          borderLeft: `${SCROLL_HINT_HALF_WIDTH}px solid transparent`,
          borderRight: `${SCROLL_HINT_HALF_WIDTH}px solid transparent`,
          borderTop: `${SCROLL_HINT_HEIGHT}px solid var(--border)`,
          opacity: railScroll.down ? 1 : 0,
          transition: reducedMotion ? "none" : "opacity 0.18s ease",
          pointerEvents: "none",
        }}
      />
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

/** 同步读取系统「减少动画」偏好（SSR/老环境安全返回 false）。 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 缓动：两端慢、中间快。
 *
 * 原生 scrollTo({behavior:"smooth"}) 的时长由浏览器决定且不可调（实测偏快），
 * 所以要自己插值。
 */
export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** 导航条滚动动画时长（ms）：比浏览器原生 smooth 慢一点，观感更稳。 */
export const RAIL_SCROLL_DURATION_MS = 420;

/**
 * 「钉住当前项」的看门狗上限（ms）。
 * 滚动链正常在秒级内以 stopWatching 收尾；超出即视为异常，强制解除，
 * 避免导航条永久不再跟随。
 */
/**
 * 导航条跟随/跳转时的滚动行为。
 *
 * 两个约束：
 * - 尊重系统「减少动画」：置 reduce 时一律瞬时（无障碍要求，不做动画）。
 * - 小位移不启动画：跟随聊天滚动时 active 会高频变化，每帧重启一个平滑动画会
 *   「追不上」而发飘；微小校正直接瞬时更跟手。
 */
export function railScrollBehavior(
  input: { reducedMotion: boolean; currentTop: number; targetTop: number },
  smallDeltaPx = 24,
): ScrollBehavior {
  if (input.reducedMotion) return "auto";
  return Math.abs(input.targetTop - input.currentTop) < smallDeltaPx ? "auto" : "smooth";
}

/**
 * 轨道还能向哪边滚动（决定上下指示器是否显示）。
 *
 * 容差 1px：滚动位置与内容高度都是小数（浏览器缩放/缩放系数），
 * 用严格 0/相等判断会让指示器在贴边时闪烁。
 */
export function railScrollHints(input: {
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
}): { up: boolean; down: boolean } {
  const max = Math.max(0, input.contentHeight - input.viewportHeight);
  if (max <= 1) return { up: false, down: false };
  return { up: input.scrollTop > 1, down: input.scrollTop < max - 1 };
}

/**
 * 导航条自身跟随当前格的决策。
 *
 * - `skip`：没有当前项（或已高亮但找不到位置），不动。
 * - `retry`：格子还没挂上 / 轨道还没布局（首帧 clientHeight 为 0），
 *   下一帧再测一次；调用方必须限定「同一个 key 只补一次」，否则会变成无限重试。
 * - `scroll`：可测量，直接居中。
 */
export function railFollowPlan(input: {
  hasActive: boolean;
  hasItem: boolean;
  clientHeight: number;
  contentHeight: number;
}): "scroll" | "retry" | "skip" {
  if (!input.hasActive) return "skip";
  if (!input.hasItem) return "retry";
  if (!(input.clientHeight > 0) || !(input.contentHeight > 0)) return "retry";
  return "scroll";
}

/**
 * 导航条自身的 scrollTop，使当前项落在轨道中部。
 *
 * 存在的理由：长会话里轨道内容比自己高，而 activeEntryId 只驱动颜色与宽度，
 * 没人滚动导航条本身 —— 于是滚到很早的消息时，导航条里对应的横线早已滚出可视区，
 * 看不出「当前在哪」。
 *
 * @param itemTop 项相对内容顶部的偏移（调用方用 rect 差值 + scrollTop 换算）
 * @returns 落在 [0, 最大可滚范围] 内的目标 scrollTop（内容未溢出时恒为 0）
 */
export function centeredRailScrollTop(input: {
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
  itemTop: number;
  itemHeight: number;
}): number {
  const { scrollTop, viewportHeight, contentHeight, itemTop, itemHeight } = input;
  const max = Math.max(0, contentHeight - viewportHeight);
  if (max === 0) return 0;
  const target = itemTop + itemHeight / 2 - viewportHeight / 2;
  if (!Number.isFinite(target)) return scrollTop;
  return Math.min(max, Math.max(0, target));
}
