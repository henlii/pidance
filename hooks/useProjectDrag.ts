"use client";

/**
 * 会话侧栏项目行拖放引擎（#issue：项目拖放体验 + 手机端不可拖）。
 *
 * 为什么不用 HTML5 拖放：`draggable` + dragstart/dragover/drop 在触摸端完全不触发，
 * 手机上项目行根本拖不动；桌面端的落点也只有「整行覆盖」，没有插入位置反馈。
 * 这里统一走 Pointer Events（鼠标 / 触摸 / 笔同一路径）：
 *
 * - 鼠标/笔：按下后位移超过 MOUSE_START_PX 才进入拖拽，按下即点击不受影响；
 * - 触摸：长按 LONG_PRESS_MS 不动才进入拖拽（否则会和列表竖向滚动抢手势），
 *   进入拖拽后由非被动 touchmove 拦下浏览器滚动；
 * - 拖拽中：整列按落点让位（占位槽滑到落点）、浮动标签跟手起落、
 *   目标行画插入线、贴边自动滚动；
 * - 松手：按落点提交顺序；本次拖拽吞掉紧随其后的 click，避免顺带折叠/展开项目。
 *
 * 键盘路径不在这里：项目行的 Alt+↑/↓ 由 ProjectSection 直接调 moveByStep。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import {
  pickProjectDropSide,
  type ProjectDropSide,
  type ProjectDropTarget,
} from "@/components/session-sidebar-model";

export type { ProjectDropSide, ProjectDropTarget };

/** 长按激活拖拽的时长：短于它会被当成滚动开始。 */
const LONG_PRESS_MS = 240;
/** 鼠标/笔的起拖位移阈值。 */
const MOUSE_START_PX = 5;
/** 触摸端在长按计时结束前移动超过它即判定为滚动，放弃拖拽。 */
const TOUCH_CANCEL_PX = 10;
/** 贴边自动滚动的触发带宽度。 */
const EDGE_ZONE_PX = 44;
const EDGE_MIN_STEP_PX = 4;
const EDGE_MAX_STEP_PX = 14;
/** 拖拽结束后的点击抑制窗口（click 在 pointerup 之后同一帧派发）。 */
const CLICK_SUPPRESS_MS = 350;
/** 放下动画时长：浮动标签缩回后再真正卸载，动画才有落点。 */
const GHOST_DROP_MS = 130;
/** 落位高亮保留时长（行从当前位置滑到新位置 + 闪一下背景）。 */
const SETTLE_MS = 480;
/** 非被动 touchmove：只有它能拦住拖拽中的浏览器滚动；lib 的 EventListenerOptions 不含 passive，故收窄。 */
const NON_PASSIVE: AddEventListenerOptions = { passive: false };

type PendingDrag = {
  pointerId: number;
  pointerType: string;
  root: string;
  label: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  timer: number | null;
  element: HTMLElement;
};

/** 项目行需要的拖放绑定；ProjectSection 直接挂到行上。 */
export type ProjectDragBinding = {
  draggingRoot: string | null;
  dropTarget: ProjectDropTarget | null;
  /** 刚落定的行：保留一小段高亮，让顺序变化看得出来。 */
  settledRoot: string | null;
  /** 行上的 onPointerDown。 */
  start: (event: ReactPointerEvent<HTMLElement>, root: string, label: string) => void;
  /** 键盘换位（Alt+↑/↓）。 */
  moveByStep: (root: string, delta: -1 | 1) => void;
  /** 拖拽刚结束时返回 true：行的 onClick 应跳过这一次。 */
  shouldSuppressClick: () => boolean;
};

export type UseProjectDragOptions = {
  /** 搜索态等场景整体关闭拖放。 */
  enabled: boolean;
  /** 当前可见项目顺序（键盘换位用）。 */
  order: readonly string[];
  /** 列表滚动容器：落点命中与贴边自动滚动都以它为准。 */
  scrollRef: RefObject<HTMLElement | null>;
  onMove: (fromRoot: string, toRoot: string, side: ProjectDropSide) => void;
};

/** 项目行的位置带：落点判定只用几何，不做 elementFromPoint。 */
type RowBox = { root: string; top: number; height: number };

function measureRows(rows: readonly HTMLElement[]): RowBox[] {
  return rows.map((row) => {
    const rect = row.getBoundingClientRect();
    return { root: row.dataset.projectRoot ?? "", top: rect.top, height: rect.height };
  });
}

/** 指针不在任何行的纵带里时，取纵向最近的一行（跳过被拖行）。 */
function nearestRow(boxes: readonly RowBox[], y: number): RowBox | null {
  let best: RowBox | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const box of boxes) {
    const distance = y < box.top ? box.top - y : y > box.top + box.height ? y - box.top - box.height : 0;
    if (distance < bestDistance) {
      best = box;
      bestDistance = distance;
    }
  }
  return best;
}

export function useProjectDrag({
  enabled,
  order,
  scrollRef,
  onMove,
}: UseProjectDragOptions): ProjectDragBinding & {
  /** 浮动标签文字；null = 未在拖拽（放下动画期间仍是旧值）。 */
  dragLabel: string | null;
  /** 浮动标签节点（portal 到 body，位置由本 hook 直接写 transform）。 */
  ghostRef: RefObject<HTMLDivElement | null>;
  /** 放下动画进行中：标签缩回并淡出。 */
  ghostDropping: boolean;
} {
  const pendingRef = useRef<PendingDrag | null>(null);
  const dropTargetRef = useRef<ProjectDropTarget | null>(null);
  const draggingRootRef = useRef<string | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);
  const suppressClickUntilRef = useRef(0);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const touchMoveGuardRef = useRef<{ element: HTMLElement; listener: EventListener } | null>(null);
  /** 起拖时源行的位置带：指针还在这一带里就不算选好落点（避免一按下列表就重排）。 */
  const sourceBandRef = useRef<{ top: number; height: number; scrollTop: number } | null>(null);
  const ghostDropTimerRef = useRef<number | null>(null);
  const settleTimerRef = useRef<number | null>(null);

  const [draggingRoot, setDraggingRoot] = useState<string | null>(null);
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [ghostDropping, setGhostDropping] = useState(false);
  const [dropTarget, setDropTargetState] = useState<ProjectDropTarget | null>(null);
  const [settledRoot, setSettledRoot] = useState<string | null>(null);

  const enabledRef = useRef(enabled);
  const orderRef = useRef(order);
  const onMoveRef = useRef(onMove);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    orderRef.current = order;
  }, [order]);
  useEffect(() => {
    onMoveRef.current = onMove;
  }, [onMove]);

  const setDropTarget = useCallback((target: ProjectDropTarget | null) => {
    const current = dropTargetRef.current;
    if (current === target) return;
    if (current && target && current.root === target.root && current.side === target.side) return;
    dropTargetRef.current = target;
    setDropTargetState(target);
  }, []);

  /** 落定高亮：顺序变了就闪一下，让眼睛跟得上。 */
  const markSettled = useCallback((root: string) => {
    setSettledRoot(root);
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      setSettledRoot(null);
    }, SETTLE_MS);
  }, []);

  /** 浮动标签跟手：直接写 style，避免每帧一次 React 渲染。 */
  const moveGhost = useCallback((x: number, y: number) => {
    const ghost = ghostRef.current;
    if (!ghost) return;
    const width = ghost.offsetWidth || 180;
    ghost.style.transform = `translate3d(${Math.round(x - width / 2)}px, ${Math.round(y - 20)}px, 0)`;
  }, []);

  const updateDropTarget = useCallback(
    (x: number, y: number) => {
      const container = scrollRef.current;
      if (!container) {
        setDropTarget(null);
        return;
      }
      const bounds = container.getBoundingClientRect();
      // 拖出列表（正文区、侧栏头部）一律不落点。
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) {
        setDropTarget(null);
        return;
      }
      // 指针还在源行原来的位置带里：保持原位（按下去就重排会很突兀）。
      const band = sourceBandRef.current;
      if (band) {
        const scrolled = container.scrollTop - band.scrollTop;
        if (y >= band.top - scrolled && y < band.top + band.height - scrolled) {
          setDropTarget(null);
          return;
        }
      }
      // 项目区归属优先：指针落在某个项目展开后的会话区（项目行下方的会话列表）时，
      // 固定落到「该项目之后」。否则按最近行距判定，指针偏上会命中上一个项目（线在其
      // 下缘）、偏下会命中下一个项目（线在其上缘）——落位相同，但指示线在上下两处跳。
      const pointed = document.elementFromPoint(x, y) as HTMLElement | null;
      const section = pointed?.closest<HTMLElement>("[data-project-section]");
      const sectionRoot =
        section && container.contains(section) ? section.dataset.projectSection ?? "" : "";
      if (sectionRoot) {
        if (sectionRoot === draggingRootRef.current) {
          // 拖回自己的会话区：位置不变，不给落点线（松手不会有任何重排）。
          setDropTarget(null);
          return;
        }
        const onRow = pointed?.closest<HTMLElement>("[data-project-root]");
        if (onRow && onRow.dataset.projectRoot === sectionRoot) {
          const rect = onRow.getBoundingClientRect();
          setDropTarget({ root: sectionRoot, side: pickProjectDropSide(y, rect.top, rect.height) });
        } else {
          // 会话区内部（会话行、分页、区间空白）：一律「该项目之后」。
          setDropTarget({ root: sectionRoot, side: "after" });
        }
        return;
      }
      const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-project-root]"));
      const boxes = measureRows(rows).filter(
        (box) => box.root && box.root !== draggingRootRef.current,
      );
      if (boxes.length === 0) {
        setDropTarget(null);
        return;
      }
      const hit =
        boxes.find((box) => y >= box.top && y < box.top + box.height) ?? nearestRow(boxes, y);
      if (!hit) {
        setDropTarget(null);
        return;
      }
      setDropTarget({ root: hit.root, side: pickProjectDropSide(y, hit.top, hit.height) });
    },
    [scrollRef, setDropTarget],
  );

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  const startAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) return;
    const tick = () => {
      autoScrollFrameRef.current = requestAnimationFrame(tick);
      const pending = pendingRef.current;
      const container = scrollRef.current;
      if (!pending?.active || !container) return;
      const bounds = container.getBoundingClientRect();
      const fromTop = pending.y - (bounds.top + EDGE_ZONE_PX);
      const fromBottom = pending.y - (bounds.bottom - EDGE_ZONE_PX);
      const overshoot = fromTop < 0 ? -fromTop : fromBottom > 0 ? fromBottom : 0;
      if (overshoot <= 0) return;
      const step = Math.min(EDGE_MAX_STEP_PX, Math.max(EDGE_MIN_STEP_PX, Math.round(overshoot / 3)));
      const before = container.scrollTop;
      container.scrollTop = before + (fromTop < 0 ? -step : step);
      // 滚动后行的屏幕坐标变了，落点要重算（否则指示线停在旧行上）。
      if (container.scrollTop !== before) updateDropTarget(pending.x, pending.y);
    };
    autoScrollFrameRef.current = requestAnimationFrame(tick);
  }, [scrollRef, updateDropTarget]);

  /**
   * 触摸端的滚动护栏：非被动 touchmove 只在列表容器上，且只在拖拽进行中
   * preventDefault。挂在容器而不是 document —— 正文区滚动不进这条同步路径。
   */
  const detachTouchMoveGuard = useCallback(() => {
    const guard = touchMoveGuardRef.current;
    if (!guard) return;
    guard.element.removeEventListener("touchmove", guard.listener, NON_PASSIVE);
    touchMoveGuardRef.current = null;
  }, []);

  const attachTouchMoveGuard = useCallback(() => {
    const container = scrollRef.current;
    if (!container || touchMoveGuardRef.current?.element === container) return;
    detachTouchMoveGuard();
    const listener = (event: Event) => {
      // touch-action: pan-y 在起拖前仍放开竖向滚动；起拖后由这里拦下。
      if (pendingRef.current?.active) event.preventDefault();
    };
    container.addEventListener("touchmove", listener, NON_PASSIVE);
    touchMoveGuardRef.current = { element: container, listener };
  }, [detachTouchMoveGuard, scrollRef]);

  const finishDrag = useCallback((options?: { dropped?: boolean }) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending && pending.timer !== null) window.clearTimeout(pending.timer);
    if (pending) {
      try {
        pending.element.releasePointerCapture(pending.pointerId);
      } catch {
        // 指针已经消失（触摸抬起/系统接管）时 release 会抛，忽略即可。
      }
    }
    stopAutoScroll();
    draggingRootRef.current = null;
    sourceBandRef.current = null;
    setDraggingRoot(null);
    setDropTarget(null);
    document.body.classList.remove("pidance-project-dragging");

    if (ghostDropTimerRef.current !== null) {
      window.clearTimeout(ghostDropTimerRef.current);
      ghostDropTimerRef.current = null;
    }
    if (options?.dropped) {
      // 放下：先让标签缩回淡出，动画播完再卸载。
      setGhostDropping(true);
      ghostDropTimerRef.current = window.setTimeout(() => {
        ghostDropTimerRef.current = null;
        setGhostDropping(false);
        setDragLabel(null);
      }, GHOST_DROP_MS);
    } else {
      setGhostDropping(false);
      setDragLabel(null);
    }
  }, [setDropTarget, stopAutoScroll]);

  const activateDrag = useCallback(
    (pending: PendingDrag) => {
      if (pendingRef.current !== pending || pending.active) return;
      pending.active = true;
      if (pending.timer !== null) {
        window.clearTimeout(pending.timer);
        pending.timer = null;
      }
      try {
        pending.element.setPointerCapture(pending.pointerId);
      } catch {
        // 捕获失败不影响窗口级监听。
      }
      draggingRootRef.current = pending.root;
      const sourceRect = pending.element.getBoundingClientRect();
      sourceBandRef.current = {
        top: sourceRect.top,
        height: sourceRect.height,
        scrollTop: scrollRef.current?.scrollTop ?? 0,
      };
      setDraggingRoot(pending.root);
      setDragLabel(pending.label);
      setGhostDropping(false);
      document.body.classList.add("pidance-project-dragging");
      if (typeof navigator.vibrate === "function") navigator.vibrate(8);
      startAutoScroll();
      updateDropTarget(pending.x, pending.y);
    },
    [scrollRef, startAutoScroll, updateDropTarget],
  );

  const start = useCallback(
    (event: ReactPointerEvent<HTMLElement>, root: string, label: string) => {
      if (!enabledRef.current || pendingRef.current) return;
      if (!event.isPrimary || event.button !== 0) return;
      const target = event.target as Element | null;
      // 行内的按钮/菜单自己处理指针，别把点击变成拖拽。
      if (target?.closest("button, a, input, textarea, select, [role='menu'], [role='menuitem']")) return;
      const pending: PendingDrag = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        root,
        label,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false,
        timer: null,
        element: event.currentTarget,
      };
      if (ghostDropTimerRef.current !== null) {
        window.clearTimeout(ghostDropTimerRef.current);
        ghostDropTimerRef.current = null;
        setGhostDropping(false);
      }
      pendingRef.current = pending;
      if (event.pointerType === "touch") {
        // pointerdown 先于 touchstart 派发：护栏在这里补挂还赶得上本次手势。
        attachTouchMoveGuard();
        pending.timer = window.setTimeout(() => activateDrag(pending), LONG_PRESS_MS);
      }
    },
    [activateDrag, attachTouchMoveGuard],
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || event.pointerId !== pending.pointerId) return;
      pending.x = event.clientX;
      pending.y = event.clientY;
      if (!pending.active) {
        const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
        if (pending.pointerType === "touch") {
          // 长按未成立就开始移动：用户要的是滚动，立即放手。
          if (distance > TOUCH_CANCEL_PX) finishDrag();
        } else if (distance > MOUSE_START_PX) {
          activateDrag(pending);
        }
        return;
      }
      moveGhost(pending.x, pending.y);
      updateDropTarget(pending.x, pending.y);
    };

    const onPointerEnd = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || event.pointerId !== pending.pointerId) return;
      if (!pending.active) {
        finishDrag();
        return;
      }
      const target = dropTargetRef.current;
      const from = pending.root;
      suppressClickUntilRef.current = performance.now() + CLICK_SUPPRESS_MS;
      finishDrag({ dropped: true });
      if (target && target.root !== from) {
        onMoveRef.current(from, target.root, target.side);
        markSettled(from);
      }
    };

    const onPointerCancel = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || event.pointerId !== pending.pointerId) return;
      // 系统接管手势（来电、通知下拉）：整次拖拽作废，不提交顺序。
      finishDrag();
    };

    const onWindowBlur = () => {
      if (pendingRef.current) finishDrag();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" && pendingRef.current) finishDrag();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      detachTouchMoveGuard();
      if (ghostDropTimerRef.current !== null) window.clearTimeout(ghostDropTimerRef.current);
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      finishDrag();
    };
  }, [activateDrag, detachTouchMoveGuard, finishDrag, markSettled, moveGhost, updateDropTarget]);

  // 容器可能在挂载后才出现（归档视图切换）：挂载后补挂一次，起拖时再兜一次。
  useEffect(() => {
    attachTouchMoveGuard();
  }, [attachTouchMoveGuard]);

  // 浮动标签挂载后才有节点可写位置：按最后一次指针坐标摆好，避免从 (0,0) 飞进来。
  useEffect(() => {
    if (dragLabel === null) return;
    const pending = pendingRef.current;
    if (pending) moveGhost(pending.x, pending.y);
  }, [dragLabel, moveGhost]);

  const shouldSuppressClick = useCallback(
    () => performance.now() < suppressClickUntilRef.current,
    [],
  );

  const moveByStep = useCallback((root: string, delta: -1 | 1) => {
    const current = orderRef.current;
    const index = current.indexOf(root);
    const neighbor = index < 0 ? undefined : current[index + delta];
    if (neighbor === undefined) return;
    onMoveRef.current(root, neighbor, delta < 0 ? "before" : "after");
    markSettled(root);
  }, [markSettled]);

  return {
    draggingRoot,
    dropTarget,
    start,
    moveByStep,
    shouldSuppressClick,
    dragLabel,
    ghostRef,
    ghostDropping,
    settledRoot,
  };
}
