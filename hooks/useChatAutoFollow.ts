"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROGRAMMATIC_SMOOTH_IGNORE_MS,
  RUN_SETTLE_MS,
  canNestedScrollerConsumeUp,
  getBottomZoneSize,
  getDistanceFromBottom,
  getRealBottomTolerance,
  getScrollDirection,
  getTouchUpIntentThreshold,
  isLayoutDrivenScroll,
  isPointerSelectIntent,
  reduceAutoFollow,
  shouldShowJumpButton,
  type AutoFollowMode,
} from "@/lib/chat-auto-follow";

const RELEASE_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);

function isInsideNestedUpScrollable(target: EventTarget | null, container: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  let el: Element | null = target;
  while (el && el !== container) {
    if (el instanceof HTMLElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll")
        && canNestedScrollerConsumeUp({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })
      ) {
        return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}

export interface UseChatAutoFollowParams {
  isMobile: boolean;
  loading: boolean;
  isNew: boolean;
  messages: readonly unknown[];
  agentRunning: boolean;
  bashRunning: boolean;
}

/**
 * 聊天列表自动跟随。唯一 scrollTop 写入方是 pinToBottom；
 * SSE/runId/completion 仍留在 useAgentSession。
 */
export function useChatAutoFollow({
  isMobile,
  loading,
  isNew,
  messages,
  agentRunning,
  bashRunning,
}: UseChatAutoFollowParams) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const autoFollowModeRef = useRef<AutoFollowMode>("following");
  const [jumpButtonVisible, setJumpButtonVisible] = useState(false);
  const initialScrollDoneRef = useRef(false);
  const pendingSendPinRef = useRef(false);
  const pendingResetPinRef = useRef(false);
  const pendingEndPinRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const lastClientHeightRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const externalWriteUntilRef = useRef(0);
  const programmaticSmoothUntilRef = useRef(0);
  const runSettleUntilRef = useRef(0);
  const wasSessionBusyRef = useRef(false);
  const isMobileRef = useRef(false);
  const prefersReducedMotionRef = useRef(false);
  const selectingRef = useRef(false);
  /** 当前按下的指针 id：松开/取消必须来自同一次交互，避免杂散事件清掉进行中的交互态。 */
  const activePointerIdRef = useRef<number | null>(null);
  /** 左键按下起点（鼠标/笔）：拖选判定用，单击不释放跟随。 */
  const selectOriginRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);
  isMobileRef.current = isMobile;

  const updateJumpButtonVisibility = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      setJumpButtonVisible(false);
      return;
    }
    const show = shouldShowJumpButton(
      autoFollowModeRef.current,
      container.scrollHeight - container.clientHeight,
      getDistanceFromBottom(container.scrollHeight, container.scrollTop, container.clientHeight),
      getBottomZoneSize(container.clientHeight, isMobileRef.current),
    );
    setJumpButtonVisible((prev) => (prev === show ? prev : show));
  }, []);

  const applyAutoFollowMode = useCallback((mode: AutoFollowMode) => {
    if (autoFollowModeRef.current === mode) return;
    autoFollowModeRef.current = mode;
    updateJumpButtonVisibility();
  }, [updateJumpButtonVisibility]);

  const pinToBottom = useCallback((behavior: ScrollBehavior = "instant") => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (selectingRef.current) return;
    if (typeof window !== "undefined" && window.getSelection()?.type === "Range") return;
    const top = Math.max(0, container.scrollHeight - container.clientHeight);
    if (behavior === "smooth") {
      programmaticSmoothUntilRef.current = Date.now() + PROGRAMMATIC_SMOOTH_IGNORE_MS;
      container.scrollTo({ top, behavior: "smooth" });
      return;
    }
    lastScrollTopRef.current = top;
    container.scrollTop = top;
  }, []);

  const notifyAutoFollowSend = useCallback(() => {
    autoFollowModeRef.current = "following";
    pendingSendPinRef.current = true;
    setJumpButtonVisible(false);
  }, []);

  const notifyAutoFollowBranchReset = useCallback(() => {
    autoFollowModeRef.current = "following";
    pendingResetPinRef.current = true;
    setJumpButtonVisible(false);
  }, []);

  /**
   * 进入「浏览历史」态（released）：按 entryId 定位跳转后必须调用。
   *
   * 不能用 notifyAutoFollowBranchReset —— 那是「重置回 following 并钉底」，
   * 会让定位结果在下一帧被拉回会话尾部（用户反馈过的「跳了又弹回去」）。
   */
  const notifyBrowsingHistory = useCallback(() => {
    applyAutoFollowMode(reduceAutoFollow(autoFollowModeRef.current, { kind: "up-intent" }));
    // 定位滚动是程序化写入：不让自动跟随把它当成用户上滚之外的意图
    markExternalScrollWriteRef.current?.();
  }, [applyAutoFollowMode]);

  const notifyAutoFollowEnd = useCallback(() => {
    runSettleUntilRef.current = Date.now() + RUN_SETTLE_MS;
    pendingEndPinRef.current = true;
  }, []);

  const jumpToBottom = useCallback(() => {
    applyAutoFollowMode(reduceAutoFollow(autoFollowModeRef.current, { kind: "jump-button" }));
    pinToBottom(prefersReducedMotionRef.current ? "instant" : "smooth");
  }, [applyAutoFollowMode, pinToBottom]);

  const markExternalScrollWrite = useCallback(() => {
    externalWriteUntilRef.current = Date.now() + 150;
  }, []);
  const markExternalScrollWriteRef = useRef<(() => void) | null>(null);
  markExternalScrollWriteRef.current = markExternalScrollWrite;

  const notifyProgrammaticSmooth = useCallback(() => {
    programmaticSmoothUntilRef.current = Date.now() + PROGRAMMATIC_SMOOTH_IGNORE_MS;
  }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    setScrollContainerEl((prev) => (prev === el ? prev : el));
  }, [loading, messages.length, isNew]);

  useEffect(() => {
    const container = scrollContainerEl;
    if (!container) return;

    const releaseOnUpIntent = () => {
      applyAutoFollowMode(reduceAutoFollow(autoFollowModeRef.current, { kind: "up-intent" }));
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0) return;
      if (isInsideNestedUpScrollable(event.target, container)) return;
      releaseOnUpIntent();
    };

    let touchStartY: number | null = null;
    let touchTarget: EventTarget | null = null;
    const onTouchStart = (event: TouchEvent) => {
      touchStartY = event.touches[0]?.clientY ?? null;
      touchTarget = event.target;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (touchStartY === null) return;
      const y = event.touches[0]?.clientY;
      if (y === undefined) return;
      if (y - touchStartY > getTouchUpIntentThreshold(isMobileRef.current)) {
        if (!isInsideNestedUpScrollable(touchTarget, container)) releaseOnUpIntent();
        touchStartY = null;
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!RELEASE_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
      releaseOnUpIntent();
    };

    // 拖选/长按选中文本 = 用户阅读意图：暂停自动跟随，避免 pin 重设 scrollTop 清掉选区。
    // 不能在按下或 selectstart 当场释放：从后台切回前台常带一次落在正文上的单击，
    // Chromium 会为这次单击先发 selectstart（表格等块还会完全不发），按下即释放的表现
    // 就是「切一下窗口自动滚动就停了」。判据放在松开那一刻：这次按下真的选出了一段
    // 文本才算阅读意图；拖选位移 ≥ 阈值作为表格等不发 selectstart 场景的兜底。
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        // 触摸只登记「正在交互」（pin 别抢滚动/选区）；方向与阈值由 touchstart/touchmove 把关
        selectingRef.current = true;
        activePointerIdRef.current = event.pointerId;
        return;
      }
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true'], button, a")) return;
      selectingRef.current = true;
      activePointerIdRef.current = event.pointerId;
      selectOriginRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onPointerMove = (event: PointerEvent) => {
      const origin = selectOriginRef.current;
      if (!origin || !selectingRef.current || origin.pointerId !== event.pointerId) return;
      if (!isPointerSelectIntent(origin, { x: event.clientX, y: event.clientY })) return;
      selectOriginRef.current = null;
      // 只改 ref（不用 releaseOnUpIntent）：pointermove 里 setState 会重渲染，
      // 把还没成形的选区拖断；按钮状态由随后的 pointerup / scroll 事件对齐。
      autoFollowModeRef.current = reduceAutoFollow(autoFollowModeRef.current, { kind: "up-intent" });
    };
    const onPointerUp = (event: PointerEvent) => {
      if (activePointerIdRef.current !== event.pointerId) {
        // 不是这一次交互的松开/取消（别的指针，或按下时没登记的控件区）：
        // 不动交互态，也不补钉底
        return;
      }
      const pressedContent = selectingRef.current;
      activePointerIdRef.current = null;
      selectOriginRef.current = null;
      selectingRef.current = false;
      if (pressedContent && window.getSelection()?.type === "Range") {
        // 双击选词/长按选中/拖选都会在松开时留下 Range；仅是单击留下的 Caret 不算
        autoFollowModeRef.current = reduceAutoFollow(autoFollowModeRef.current, { kind: "up-intent" });
      } else if (autoFollowModeRef.current === "following") {
        // 按住期间内容增长被 pinToBottom 的交互态挡掉了；仍跟随就补一次守卫钉底，
        // 否则内容会停在半途（下一次增长才被拉回）。只补钉底，不改成 released/following。
        requestAnimationFrame(() => {
          if (autoFollowModeRef.current === "following") pinToBottom("instant");
        });
      }
      updateJumpButtonVisibility();
    };
    // 按住后切走窗口/拖到窗外：pointerup 可能落不到本页，
    // 不清掉选择态就会让 pinToBottom 从此永久跳过（表现为自动滚动再也不跟随）。
    const onWindowBlur = () => {
      activePointerIdRef.current = null;
      selectOriginRef.current = null;
      selectingRef.current = false;
    };

    container.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onWindowBlur);
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onWindowBlur);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [scrollContainerEl, applyAutoFollowMode, updateJumpButtonVisibility, pinToBottom]);

  useEffect(() => {
    const container = scrollContainerEl;
    if (!container) return;
    lastScrollTopRef.current = container.scrollTop;
    lastScrollHeightRef.current = container.scrollHeight;
    lastClientHeightRef.current = container.clientHeight;
    const onScroll = () => {
      const now = Date.now();
      const previousTop = lastScrollTopRef.current;
      const nextTop = container.scrollTop;
      lastScrollTopRef.current = nextTop;
      const previousClientHeight = lastClientHeightRef.current;
      const previousScrollHeight = lastScrollHeightRef.current;
      lastClientHeightRef.current = container.clientHeight;
      lastScrollHeightRef.current = container.scrollHeight;
      if (now < externalWriteUntilRef.current || now < programmaticSmoothUntilRef.current) {
        updateJumpButtonVisibility();
        return;
      }
      if (isLayoutDrivenScroll({
        previousScrollHeight,
        nextScrollHeight: container.scrollHeight,
        previousClientHeight,
        nextClientHeight: container.clientHeight,
      })) {
        updateJumpButtonVisibility();
        return;
      }
      applyAutoFollowMode(
        reduceAutoFollow(autoFollowModeRef.current, {
          kind: "scroll",
          distance: getDistanceFromBottom(container.scrollHeight, nextTop, container.clientHeight),
          direction: getScrollDirection(previousTop, nextTop),
          zoneSize: getBottomZoneSize(container.clientHeight, isMobileRef.current),
          bottomTolerance: getRealBottomTolerance(isMobileRef.current),
        }),
      );
      updateJumpButtonVisibility();
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [scrollContainerEl, applyAutoFollowMode, updateJumpButtonVisibility]);

  useEffect(() => {
    const busy = agentRunning || bashRunning;
    if (wasSessionBusyRef.current && !busy) {
      runSettleUntilRef.current = Date.now() + RUN_SETTLE_MS;
      if (autoFollowModeRef.current === "following") {
        requestAnimationFrame(() => {
          pinToBottom("instant");
          requestAnimationFrame(() => {
            if (autoFollowModeRef.current === "following") pinToBottom("instant");
          });
        });
      }
    }
    wasSessionBusyRef.current = busy;
  }, [agentRunning, bashRunning, pinToBottom]);

  useEffect(() => {
    const container = scrollContainerEl;
    if (!container) return;
    const content = container.firstElementChild;
    const onResize = () => {
      lastScrollHeightRef.current = container.scrollHeight;
      lastClientHeightRef.current = container.clientHeight;
      const now = Date.now();
      if (autoFollowModeRef.current !== "following") {
        updateJumpButtonVisibility();
        return;
      }
      if (now < programmaticSmoothUntilRef.current) return;
      if (now < externalWriteUntilRef.current) {
        updateJumpButtonVisibility();
        return;
      }
      pinToBottom("instant");
      updateJumpButtonVisibility();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(container);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [scrollContainerEl, pinToBottom, updateJumpButtonVisibility]);

  useEffect(() => {
    if (messages.length === 0) return;
    if (!scrollContainerRef.current) return;
    if (pendingSendPinRef.current || pendingResetPinRef.current || pendingEndPinRef.current) {
      pendingSendPinRef.current = false;
      pendingResetPinRef.current = false;
      pendingEndPinRef.current = false;
      initialScrollDoneRef.current = true;
      if (autoFollowModeRef.current === "following") pinToBottom("instant");
    } else if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      pinToBottom("instant");
    }
    updateJumpButtonVisibility();
  }, [messages, pinToBottom, updateJumpButtonVisibility]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      prefersReducedMotionRef.current = mql.matches;
    };
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return {
    scrollContainerRef,
    jumpButtonVisible,
    jumpToBottom,
    notifyAutoFollowSend,
    notifyAutoFollowBranchReset,
    notifyAutoFollowEnd,
    markExternalScrollWrite,
    notifyProgrammaticSmooth,
    notifyBrowsingHistory,
  };
}
