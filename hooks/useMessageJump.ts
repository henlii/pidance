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
 * 语义：
 * - 目标已在 DOM：直接滚动；
 * - 否则以当前已加载的消息为准，把 [目标, 当前窗口起点) 这一段一次取回来
 *   （prepend，保留现有内容），距离由服务端算，再滚过去；
 * - 跳转期间钉住当前项（jumpPinRef），有看门狗兜底，避免「导航条永久停止跟随」。
 */

import { useCallback, useRef, useState, type RefObject } from "react";
import {
  applyViewportScrollAnchor,
  captureViewportScrollAnchor,
} from "@/lib/chat-scroll-anchor";
import { easeInOutCubic } from "@/components/MessageNavRail";

/** 跳转进行中「钉住」的看门狗：滚动链应在秒级内以 stopWatching 收尾并解除钉住。 */
const JUMP_PIN_WATCHDOG_MS = 5_000;

/**
 * 「跳到选中消息」的滚动时长（ms）。
 *
 * 用自控缓动而不是原生 behavior:"smooth"：后者时长由浏览器决定、不可调，
 * 而这一步是一次明确的定位动作，要短、要可预期。比导航条自身的
 * RAIL_SCROLL_DURATION_MS(420) 更短，因为导航条是跟手滚动、这里是一次跳转。
 */
const JUMP_SCROLL_DURATION_MS = 260;

export interface MessageJumpOptions {
  /** 会话滚动容器（三端都有） */
  scrollContainer: RefObject<HTMLDivElement | null>;
  /** entryId → 已渲染的消息元素（由 ChatWindow 提供；槽位映射归渲染层所有） */
  resolveMessageElementRef: RefObject<((entryId: string) => HTMLElement | null) | null>;
  /**
   * 向上（更早）补一段，保留当前已加载的消息（prepend）。
   *
   * options.from 给定时要的是 [from, 当前窗口起点) 这一整段 —— 要多少条由服务端
   * 按两个 entryId 的距离算，调用方不猜距离、不猜页宽。
   */
  loadOlder: (options?: { from?: string }) => Promise<boolean>;
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
  loadOlder,
  railHandleRef,
  notifyBrowsingHistory,
}: MessageJumpOptions): MessageJumpHandle {
  const [jumpingTo, setJumpingTo] = useState<string | null>(null);
  const jumpPinRef = useRef<string | null>(null);
  const jumpSeqRef = useRef(0);

  const jumpTo = useCallback(async (entryId: string): Promise<boolean> => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return false;
    // 点击即刻把该点设为当前项，并钉住到本次跳转结束：不依赖异步流程末尾的解析
    // 结果（补页 + 滚动整条链路是秒级，这期间用户早就点过了），中间几拍也不得被
    // 旧视口覆盖；若末尾解析因窗口内无提问等原因返回 null（见 resolveActiveOutlineEntry），
    // 高亮就会一直停在跳转前那条。流程收尾仍会按实际位置校正一次。
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
     * 滚动到目标（自控时长缓动，不是瞬时跳转）。
     *
     * 定位前时间线还会继续长（补页分批提交、图片/媒体延迟挂载），此时立刻发滚动，
     * 目标偏移会算在旧布局上，落点整体偏掉（实测 topRel 2842px）。所以：
     * 先等布局稳定（连续两帧位置一致）→ 缓动滚过去 → 动画结束后再校正一次。
     */
    const scrollToTarget = (el: HTMLElement, options?: {
      /** 加载前视口内容的锚点：填充期间钉回原位 */
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
       * 补页填充期持续把锚点钉回原位（无锚点时无事发生）。
       *
       * 为什么不能只还原一次：定位后新加载的一页是分批挂载的，锚点上方内容变高
       * 就会把它整体推走 —— 一次性还原只挡住第一帧，之后仍漂 1695px。所以填充期间
       * 每帧重钉，直到缓动滚动开始（动画一开始就不该再抢滚动）。
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
          // 自控时长的快速滚动。动画跑完直接进收敛——以前用原生 smooth，
          // 还要靠「每 60ms 采样、连续三帧 scrollTop 不变」去猜它何时结束，
          // 既拖长了链路，也因为猜不准而多绕一轮收敛。
          const from = scrollEl.scrollTop;
          const delta = top - from;
          const startedAt = performance.now();
          const step = (now: number) => {
            if (interrupted || !isCurrent() || !el.isConnected) { stopWatching(); return; }
            const progress = Math.min(1, (now - startedAt) / JUMP_SCROLL_DURATION_MS);
            scrollEl.scrollTop = from + delta * easeInOutCubic(progress);
            if (progress < 1) { requestAnimationFrame(step); return; }
            converge(0, 0);
          };
          requestAnimationFrame(step);
          return;
        }
        requestAnimationFrame(() => settleThenScroll(attempt + 1, top, nextStable));
      };

      watchInterrupts();
      requestAnimationFrame(() => settleThenScroll());
    };

    /**
     * 记下「加载前视口顶部的可见消息」及其相对容器顶的偏移。
     *
     * 为什么需要：跳转要往时间线**上方**补好几页，补一页上方就长高一截，
     * 下方内容整体被推走；浏览器默认的锚定在 released 态虽已打开，但一次插入
     * 上千条时它并不总保得住（Chrome 会放弃）。自己钉住才能保证「用户读到的
     * 位置不动」。
     */
    const captureAnchor = (): { entryId: string; offset: number } | null =>
      captureViewportScrollAnchor(scrollEl);

    /**
     * 等目标进入 DOM，最多轮 frames 帧。
     *
     * 为什么要按帧轮询而不是查一次：补页 hydrate 之后 React 才提交渲染，且上千条的
     * 列表要分好几拍；查一次必然查不到，而「查不到」在这里等于「还没补到」。
     */
    const waitForTarget = async (frames = 10): Promise<HTMLElement | null> => {
      for (let i = 0; i < frames; i += 1) {
        if (!isCurrent()) return null;
        const target = findTarget();
        if (target) return target;
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
      return null;
    };

    // 目标已在 DOM：不加载，直接滚过去（用户就是在当前窗口里点的这一条）。
    const immediate = await waitForTarget();
    if (immediate) {
      notifyBrowsingHistory();
      scrollToTarget(immediate);
      return true;
    }

    setJumpingTo(entryId);
    // 进入浏览历史态必须发生在**第一次补页之前**：
    // following 态下每次内容变高，自动跟随都会把 scrollTop 重写成新的底部，
    // 而补页要连补好几轮、之后还要滚动到目标 —— 这期间任何一次重写都会把本次
    // 定位抹掉；定位结束后迟到的图片/媒体把内容撑高，也一样会把视口拖回尾部
    // （「跳了又弹回去」）。released 态同时还把 overflow-anchor 交还浏览器，
    // 上方插入内容时视口保持不动。
    notifyBrowsingHistory();
    // 增量补页会往时间线里插内容（向上是 prepend），上方高度一变当前视口就被推走。
    // 先记下「加载前视口顶部那段内容」，每补一页后把它钉回去 —— 用户读到的位置不动。
    const anchor = captureAnchor();
    let target: HTMLElement | null = null;
    try {
      // 目标不在时间线里：一次把 [目标, 当前窗口起点) 整段要回来，prepend 保留现状。
      // 要多少条由服务端按这两个 entryId 的距离精确算（外加目标上方一小段余量）——
      // 不按页宽猜：页宽猜大了一页白拉几百条（跳转本来就嫌拉得多），猜小了要多跑
      // 好几个来回。
      //
      // 这里刻意不用「around 换窗」：那会把已经读到的内容整段替换掉，目标之后的消息
      // 也不在手边（表现为「跳过去以后后续的会话被折叠起来」）。
      //
      // 加载之后要等它真正落进 DOM 再找目标：hydrate 之后 React 才提交渲染，紧跟着
      // 同步查一次 DOM 必然查不到（实测：目标其实已经在时间线里，却因为这一步把整次
      // 跳转判成失败）。上千条的一次提交还会分几拍，所以按帧轮询。
      if (await loadOlder({ from: entryId })) {
        if (!isCurrent()) return false;
        // 上方插入内容会把视口推走：把加载前那段内容钉回原位，用户读到的位置不动。
        if (anchor) applyAnchorOffset(anchor);
        target = await waitForTarget(40);
      }
    } finally {
      if (isCurrent()) setJumpingTo(null);
      // 目标始终没渲染出来：立即按归属解除钉住，不把流程交给 scrollToTarget。
      // 漏这一步的后果不是“高亮不准”，而是导航条**永久停止跟随**。
      if (!target && jumpPinRef.current === entryId) jumpPinRef.current = null;
    }
    if (!target || !isCurrent()) return false;
    // 锚点还在就继续钉着，然后滚到目标（动画保留）；没有锚点就直接滚。
    scrollToTarget(target, anchor ? { anchor } : undefined);
    return true;
  }, [loadOlder, resolveMessageElementRef, scrollContainer, railHandleRef, notifyBrowsingHistory]);
  return { jumpTo, jumpingTo, jumpPinRef };
}

