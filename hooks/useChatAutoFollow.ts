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

    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("touchstart", onTouchStart, { passive: true });
    container.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("touchstart", onTouchStart);
      container.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [scrollContainerEl, applyAutoFollowMode]);

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
  };
}
