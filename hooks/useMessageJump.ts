"use client";

/**
 * 历史定位（导航条点击 / 全文搜索命中）的共享实现。
 *
 * 为什么要单独成 hook：定位请求由会话外发起（AppShell 收到全文搜索命中），消费方
 * 必须**始终挂载** —— 导航条在手机端不渲染（ChatWindow 里 isMobile 时返回 null），
 * 没有提问时自己也返回 null。消费逻辑留在导航条里，就等于「≤640px 点命中只切会话、
 * 不滚动」。所以跳转机制移到这里，由 ChatWindow 持有（三端都在），导航条只拿
 * jumpTo / jumpingTo 做交互与视觉。
 *
 * 语义与原先在导航条里时完全一致：
 * - 目标已在 DOM：直接滚动；
 * - 否则调 jumpToEntry 让服务端返回该条附近窗口并整体替换时间线，再滚到目标；
 * - 跳转期间钉住当前项（jumpPinRef），有看门狗兜底，避免「导航条永久停止跟随」。
 */

import { useCallback, useRef, useState, type RefObject } from "react";
import {
  applyViewportScrollAnchor,
  captureViewportScrollAnchor,
} from "@/lib/chat-scroll-anchor";

/** 跳转进行中「钉住」的看门狗：滚动链应在秒级内以 stopWatching 收尾并解除钉住。 */
const JUMP_PIN_WATCHDOG_MS = 5_000;

export interface MessageJumpOptions {
  /** 会话滚动容器（三端都有） */
  scrollContainer: RefObject<HTMLDivElement | null>;
  /** entryId → 已渲染的消息元素（由 ChatWindow 提供；槽位映射归渲染层所有） */
  resolveMessageElementRef: RefObject<((entryId: string) => HTMLElement | null) | null>;
  /** 按 entryId 跳到历史某条：服务端返回该条附近窗口并整体替换时间线（一次到位） */
  jumpToEntry: (entryId: string) => Promise<boolean>;
  /**
   * 重算导航条高亮。导航条挂载时把自己的 syncActive 注册进来；手机端没有导航条
  /**
   * 导航条挂载时注册的能力（高亮重算 + 即刻设当前项）。手机端不挂导航条，
   * 窄屏或没有提问时导航条自行返回 null —— 此时为空，跳转流程不依赖它。
   */
  railHandleRef: RefObject<MessageJumpRailHandle | null>;
  /** 进入「浏览历史」态：跳转前必须离开跟随态，否则自动跟随会先钉底 */
  notifyBrowsingHistory: () => void;
}

export interface MessageJumpRailHandle {
  /** 立刻把该条设为当前项：跳转期间不等异步解析结果 */
  setActive(entryId: string): void;
  /** 按当前视口重算当前项（跳转收尾时调用） */
  syncActive(): void;
}

export interface MessageJumpHandle {
  jumpTo: (entryId: string) => Promise<boolean>;
  jumpingTo: string | null;
  /** 跳转期间钉住的目标；导航条的 syncActive 读它跳过按旧视口改写高亮 */
  jumpPinRef: RefObject<string | null>;
}

export function useMessageJump({
  scrollContainer,
  resolveMessageElementRef,
  jumpToEntry,
  railHandleRef,
  notifyBrowsingHistory,
}: MessageJumpOptions): MessageJumpHandle {
  const [jumpingTo, setJumpingTo] = useState<string | null>(null);
  const jumpPinRef = useRef<string | null>(null);
  const jumpSeqRef = useRef(0);

  const jumpTo = useCallback(async (entryId: string): Promise<boolean> => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return false;
    // 点击即刻把该点设为当前项：不依赖异步流程末尾的解析结果。
    // 理由：跳转会整体替换时间线，解析需要等新窗口渲染 + 滚动稳定，这期间用户已
    // 经点过了；若末尾解析因窗口内无提问等原因返回 null（见 resolveActiveOutlineEntry），
    // 高亮会一直停在跳转前那条。同步流程末尾仍会按实际位置校正一次。
    // 点击即刻把该点设为当前项，并钉住到本次跳转结束：中间几拍不得被旧视口覆盖。
    railHandleRef.current?.setActive(entryId);
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
        if (interrupted || !isCurrent() || !el.isConnected) { stopWatching(); railHandleRef.current?.syncActive(); return; }
        if (Math.abs(drift()) > 2) {
          if (attempt >= 12) { stopWatching(); railHandleRef.current?.syncActive(); return; }
          scrollEl.scrollTo({ top: measure(), behavior: "auto" });
          window.setTimeout(() => converge(0, attempt + 1), 100);
          return;
        }
        if (stableCount >= 3) { stopWatching(); railHandleRef.current?.syncActive(); return; }
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
      // 目标已在 DOM：不会走 jumpToEntry（它内部才 notifyBrowsingHistory），
      // 但「用户在窗口内点了一条命中」同样是从跟随态进入阅读态，必须显式进入。
      notifyBrowsingHistory();
      handedOff = true;
      scrollToTarget(immediate);
      return true;
    }
    setJumpingTo(entryId);
    // 必须在替换时间线**之前**取锚点：之后 DOM 已经是新窗口，量不到旧视口的内容。
    const anchor = captureAnchor();
    try {
      const located = await jumpToEntry(entryId);
      if (!located || !isCurrent()) return false;
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
    return handedOff;
  }, [jumpToEntry, resolveMessageElementRef, scrollContainer, railHandleRef, notifyBrowsingHistory]);
  return { jumpTo, jumpingTo, jumpPinRef };
}

