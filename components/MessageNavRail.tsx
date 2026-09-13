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

/** 短横线：12×2，圆角 1 —— 与设计稿一致（浅灰；当前项深色）。 */
const DASH_WIDTH = 12;
const DASH_HEIGHT = 2;
/** 相邻短横线间距（列表整体上下居中）；比初版减半，长会话更紧凑。 */
const DASH_GAP = 4;
/** 列表最大高度：超出后内部滚动（横线再多也够得到）。 */
const LIST_MAX_HEIGHT_PX = 320;
/** 横线相对轨道左侧的内缩：贴边太紧，视觉上像被裁掉。 */
const DASH_LEFT_INSET_PX = 4;
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
  resolveMessageElementRef,
  expandRenderWindowToEntryRef,
  jumpToEntry,
  isAtLiveTail,
}: Props) {
  const { t } = useI18n();
  const [railHeight, setRailHeight] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [jumpingTo, setJumpingTo] = useState<string | null>(null);
  /**
   * 跳转代次：连续跳转（或快速连点）时，旧的平滑滚动与收尾校正必须整体失效，
   * 否则两次跳转互相抢滚动位置（实测中间条落点偏 523px）。
   */
  const jumpSeqRef = useRef(0);
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
  const renderedCacheKeyRef = useRef("");
  const measureOffsetRef = useRef(0);

  const syncActive = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
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
    });
    if (resolved !== null) setActiveEntryId(resolved);
  }, [entryIds, isAtLiveTail, outline, renderKey, scrollContainer]);

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
   * 顺序刻意是「先加载、后滚动」：定位会整体替换时间线，若先滚动再让内容陆续加载，
   * 滚动位置会被后续布局不断顶掉。所以：
   * 1) 已在渲染窗口内 → 直接滚动（无网络往返）；
   * 2) 否则请求服务端按 entryId 定位（只取锚点附近一页，避免时间线膨胀到上千条），
   *    等目标渲染出来、布局稳定后再平滑滚动到位；
   * 3) 服务端失败 → 退回「撑开渲染窗口」的本地兜底。
   */
  const jumpTo = useCallback(async (entryId: string) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const seq = ++jumpSeqRef.current;
    const isCurrent = () => jumpSeqRef.current === seq;
    const findTarget = (): HTMLElement | null =>
      resolveMessageElementRef.current?.(entryId) ?? null;
    /**
     * 快速滚动到目标（平滑动画，不是瞬时跳转）。
     *
     * 定位会整体替换时间线，随后几帧里图片/折叠块还会改变高度；此时立刻发滚动，
     * 目标偏移会算在旧布局上，落点整体偏掉（实测 topRel 2842px）。所以：
     * 先等布局稳定（连续两帧位置一致）→ 平滑滚动 → 动画结束后再校正一次。
     */
    const scrollToTarget = (el: HTMLElement) => {
      const measure = () => el.getBoundingClientRect().top
        - scrollEl.getBoundingClientRect().top
        + scrollEl.scrollTop;
      // 用户一动滚轮/拖滚动条（pointerdown 含触摸）/键盘就放弃后续校正，不跟用户抢滚动
      let interrupted = false;
      const onInterrupt = () => { interrupted = true; };
      const stopWatching = () => {
        scrollEl.removeEventListener("wheel", onInterrupt);
        scrollEl.removeEventListener("pointerdown", onInterrupt);
        scrollEl.removeEventListener("keydown", onInterrupt);
      };
      scrollEl.addEventListener("wheel", onInterrupt, { passive: true });
      scrollEl.addEventListener("pointerdown", onInterrupt, { passive: true });
      scrollEl.addEventListener("keydown", onInterrupt);

      const drift = () => el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;

      /**
       * 落地后有界收敛：目标不再偏离视口顶就停，最多 12 次 × 100ms。
       *
       * 为什么不能只校正一次：滚动容器是 overflow-anchor:none（钉底自动跟随需要，
       * 见 ChatWindow），浏览器不会替我们补偿上方内容的晚挂载。跳转后视口附近的过程块
       * 仍会陆续挂载/卸载，上方高度一变，目标就被整体推走 —— 实测最后一次校正后又被
       * 推偏 613px（中间位置则稳定在 0）。
       */
      const converge = (stableCount: number, attempt: number) => {
        if (interrupted || !isCurrent() || !el.isConnected) { stopWatching(); return; }
        if (Math.abs(drift()) > 2) {
          if (attempt >= 12) { stopWatching(); syncActive(); return; }
          scrollEl.scrollTo({ top: measure(), behavior: "auto" });
          window.setTimeout(() => converge(0, attempt + 1), 100);
          return;
        }
        if (stableCount >= 3) { stopWatching(); syncActive(); return; }
        window.setTimeout(() => converge(stableCount + 1, attempt + 1), 100);
      };

      const settleThenScroll = (attempt = 0, last = Number.NaN, stable = 0) => {
        if (!isCurrent() || !el.isConnected || interrupted) { stopWatching(); return; }
        const top = measure();
        const nextStable = Math.abs(top - last) < 2 ? stable + 1 : 0;
        if (nextStable >= 2 || attempt > 20) {
          scrollEl.scrollTo({ top, behavior: "smooth" });
          // 等平滑动画真正停下（连续三次 scrollTop 不变）再进收敛：
          // 固定 450ms 太早，会在动画中段就判「偏离」并把视口定在中途
          // （实测：目标停在视口上方 214px，而它本可以贴顶）。
          const watch = (lastTop: number, idleFrames: number) => {
            if (interrupted || !isCurrent() || !el.isConnected) { stopWatching(); return; }
            const now = scrollEl.scrollTop;
            if (idleFrames >= 3) { converge(0, 0); return; }
            window.setTimeout(
              () => watch(now, Math.abs(now - lastTop) < 1 ? idleFrames + 1 : 0),
              60,
            );
          };
          window.setTimeout(() => watch(scrollEl.scrollTop, 0), 60);
          return;
        }
        requestAnimationFrame(() => settleThenScroll(attempt + 1, top, nextStable));
      };
      requestAnimationFrame(() => settleThenScroll());
    };

    // 等目标进入 DOM（服务端定位后需要一拍渲染）
    const waitForTarget = async (): Promise<HTMLElement | null> => {
      for (let i = 0; i < 10; i += 1) {
        if (!isCurrent()) return null;
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
      if (!located || !isCurrent()) return;
      const target = await waitForTarget();
      if (target && isCurrent()) scrollToTarget(target);
    } finally {
      if (isCurrent()) setJumpingTo(null);
    }
  }, [expandRenderWindowToEntryRef, jumpToEntry, resolveMessageElementRef, scrollContainer, syncActive]);

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
      <div
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
