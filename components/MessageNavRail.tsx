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
import { getBottomZoneSize } from "@/lib/chat-auto-follow";
import {
  applyViewportScrollAnchor,
  captureViewportScrollAnchor,
} from "@/lib/chat-scroll-anchor";

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
  resolveMessageElementRef,
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
   */
  const jumpPinRef = useRef<string | null>(null);

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
  }, [entryIds, isAtLiveTail, outline, renderKey, scrollContainer]);

  /**
   * 总是拿到「最新一次渲染」的 syncActive。
   *
   * jumpTo 是异步流程：等待期间时间线会被换成新窗口并重渲染，而流程末尾若直接调用
   * 当初捕获的 syncActive，它闭包里还是旧的 entryIds/outline —— 会按旧窗口解析出旧
   * 的高亮（实测：跳转后仍高亮跳转前那条，手动滚动一下才正常，因为滚动事件用的是
   * 最新闭包）。
   */
  const syncActiveRef = useRef(syncActive);
  syncActiveRef.current = syncActive;

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
    // 点击即刻把该点设为当前项：不依赖异步流程末尾的解析结果。
    // 理由：跳转会整体替换时间线，解析需要等新窗口渲染 + 滚动稳定，这期间用户已
    // 经点过了；若末尾解析因窗口内无提问等原因返回 null（见 resolveActiveOutlineEntry），
    // 高亮会一直停在跳转前那条。同步流程末尾仍会按实际位置校正一次。
    // 点击即刻把该点设为当前项，并钉住到本次跳转结束：中间几拍不得被旧视口覆盖。
    setActiveEntryId(entryId);
    jumpPinRef.current = entryId;
    // 看门狗：滚动链应在秒级内以 stopWatching 收尾（并解除钉住）。若因异常卡住，
    // 钉住会退化成「导航条永久不再跟随」——比高亮不准严重得多，所以有界兜底。
    window.setTimeout(() => {
      if (jumpPinRef.current === entryId) jumpPinRef.current = null;
    }, JUMP_PIN_WATCHDOG_MS);
    const seq = ++jumpSeqRef.current;
    const isCurrent = () => jumpSeqRef.current === seq;
    const findTarget = (): HTMLElement | null =>
      resolveMessageElementRef.current?.(entryId) ?? null;
    /**
     * 把锚点消息放回加载前相对容器顶的同一偏移（瞬时）。
     * 锚点不在当前 DOM（不在新窗口 / 已卸载）返回 false，不做任何移动。
     */
    const applyAnchorOffset = (anchor: { entryId: string; offset: number }) =>
      applyViewportScrollAnchor(scrollEl, anchor, (id) => resolveMessageElementRef.current?.(id) ?? null);

    /**
     * 快速滚动到目标（平滑动画，不是瞬时跳转）。
     *
     * 定位会整体替换时间线，随后几帧里图片/折叠块还会改变高度；此时立刻发滚动，
     * 目标偏移会算在旧布局上，落点整体偏掉（实测 topRel 2842px）。所以：
     * 先等布局稳定（连续两帧位置一致）→ 平滑滚动 → 动画结束后再校正一次。
     */
    const scrollToTarget = (el: HTMLElement, options?: {
      instantAtTarget?: boolean;
      /** 换窗锚点：填充期间钉回加载前的视口内容 */
      anchor?: { entryId: string; offset: number } | null;
    }) => {
      const measure = () => el.getBoundingClientRect().top
        - scrollEl.getBoundingClientRect().top
        + scrollEl.scrollTop;
      // 用户一动滚轮/拖滚动条（pointerdown 含触摸）/键盘就放弃后续校正，不跟用户抢滚动
      let interrupted = false;
      const onInterrupt = () => { interrupted = true; };
      const watchInterrupts = () => {
        scrollEl.addEventListener("wheel", onInterrupt, { passive: true });
        scrollEl.addEventListener("pointerdown", onInterrupt, { passive: true });
        scrollEl.addEventListener("keydown", onInterrupt);
      };
      const stopWatching = () => {
        scrollEl.removeEventListener("wheel", onInterrupt);
        scrollEl.removeEventListener("pointerdown", onInterrupt);
        scrollEl.removeEventListener("keydown", onInterrupt);
        // 所有退出路径（完成/被打断/目标移除）都经过这里：解除「钉住当前项」，
        // 让导航条恢复跟随实际视口（否则会一直停在跳转目标上）。
        // 只在仍属于本次跳转时清：旧的清理链不得抹掉新一次跳转的钉住。
        if (jumpPinRef.current === entryId) jumpPinRef.current = null;
      };

      const drift = () => el.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;

      /**
       * 换窗填充期持续把锚点钉回原位（无锚点时无事发生）。
       *
       * 为什么不能只还原一次：定位后新加载的一页是分批挂载的，锚点上方内容变高
       * 就会把它整体推走 —— 一次性还原只挡住第一帧，之后仍漂 1695px。所以填充期间
       * 每帧重钉，直到平滑滚动开始（动画一开始就不该再抢滚动）。
       */
      const holdAnchor = () => {
        if (options?.anchor) applyAnchorOffset(options.anchor);
      };

      /**
       * 落地后有界收敛：目标不再偏离视口顶就停，最多 12 次 × 100ms。
       *
       * 为什么不能只校正一次：跳转期间视口附近仍会有内容晚挂载（更旧的一页、
       * 代码高亮、图片），上方高度一变，目标就被整体推走 —— 实测最后一次校正后
       * 又被推偏 613px（中间位置则稳定在 0）。
       */
      const converge = (stableCount: number, attempt: number) => {
        if (interrupted || !isCurrent() || !el.isConnected) { stopWatching(); syncActiveRef.current(); return; }
        if (Math.abs(drift()) > 2) {
          if (attempt >= 12) { stopWatching(); syncActiveRef.current(); return; }
          scrollEl.scrollTo({ top: measure(), behavior: "auto" });
          window.setTimeout(() => converge(0, attempt + 1), 100);
          return;
        }
        if (stableCount >= 3) { stopWatching(); syncActiveRef.current(); return; }
        window.setTimeout(() => converge(stableCount + 1, attempt + 1), 100);
      };

      const settleThenScroll = (attempt = 0, last = Number.NaN, stable = 0) => {
        if (!isCurrent() || !el.isConnected || interrupted) { stopWatching(); return; }
        // 布局还在变（分批挂载）期间先维持锚点不动，用户看到的内容才是连续的
        holdAnchor();
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

      watchInterrupts();
      // 兜底路径：加载前那条可见消息不在新窗口里，锚点还原不了 —— 只能就地贴到目标。
      // 仍跑在调用方的 rAF 微任务里（绘制前），所以只是「没有动画」，不会闪。
      if (options?.instantAtTarget) {
        scrollEl.scrollTop = measure();
        converge(0, 0);
        return;
      }
      requestAnimationFrame(() => settleThenScroll());
    };

    /**
     * 记下「加载前视口顶部的可见消息」及其相对容器顶的偏移。
     *
     * 为什么需要：服务端定位会**整体替换时间线**（新窗口 = 目标前一页 → 最新），
     * 而浏览器不会替我们保住「当前视口对应的内容」—— scrollTop 只是个数字，
     * 换窗后它指向完全不同的内容，用户看到的就是「显示的内容被换掉了」。
     */
    const captureAnchor = (): { entryId: string; offset: number } | null =>
      captureViewportScrollAnchor(scrollEl);

    // 等目标进入 DOM（服务端定位后需要一拍渲染）
    const waitForTarget = async (): Promise<HTMLElement | null> => {
      for (let i = 0; i < 10; i += 1) {
        if (!isCurrent()) return null;
        const target = findTarget();
        if (target) return target;
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
      return null;
    };

    let handedOff = false;
    const immediate = await waitForTarget();
    if (immediate) {
      handedOff = true;
      scrollToTarget(immediate);
      return;
    }
    setJumpingTo(entryId);
    // 必须在替换时间线**之前**取锚点：之后 DOM 已经是新窗口，量不到旧视口的内容。
    const anchor = captureAnchor();
    try {
      const located = await jumpToEntry(entryId);
      if (!located || !isCurrent()) return;
      const target = await waitForTarget();
      if (target && isCurrent()) {
        handedOff = true;
        // 期望顺序：加载内容 → **加载完成的同时**把视口锚回「加载前显示的那段内容」
        // （同一个 rAF 内、绘制前完成，因此不闪）→ 再平滑滚到跳转目标（动画保留）。
        // 锚点还原不了（旧内容不在新窗口里）才退化为就地贴到目标。
        const restored = anchor !== null && applyAnchorOffset(anchor);
        // 还原成功 → 填充期继续钉住锚点，然后平滑滚到目标（动画保留）；
        // 旧内容不在新窗口里 → 只能就地贴到目标（同样不闪，但没有动画）。
        scrollToTarget(target, restored && anchor ? { anchor } : { instantAtTarget: true });
      }
    } finally {
      if (isCurrent()) setJumpingTo(null);
      // 未交给 scrollToTarget（定位失败/目标没渲染出来）：立即按归属解除钉住。
      // 漏这一步的后果不是“高亮不准”，而是导航条**永久停止跟随**。
      if (!handedOff && jumpPinRef.current === entryId) jumpPinRef.current = null;
    }
  }, [jumpToEntry, resolveMessageElementRef, scrollContainer, syncActiveRef]);

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
const JUMP_PIN_WATCHDOG_MS = 5_000;

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
