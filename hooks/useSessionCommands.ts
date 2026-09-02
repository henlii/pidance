"use client";

import { useCallback, useMemo, type RefObject } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  buildBranchSwitchCommand,
  buildSetBranchLabelCommand,
  gateBranchAction,
  type BranchActions,
  type BranchActionResult,
  type BranchSwitchChoice,
} from "@/lib/branch-bookmarks";
import type { ChatInputHandle } from "@/lib/types";

// ── 纯逻辑层（不依赖 React，供 hooks/useSessionCommands.test.mjs 直接测试）────

/** 分支导航 / fork / 新会话命令返回的原始结果中与 UI 副作用相关的字段。 */
export interface BranchCommandResult {
  cancelled?: boolean;
  aborted?: boolean;
  editorText?: string;
  newSessionId?: string;
}

/**
 * fork / 新会话命令的副作用计划：cancelled 或缺失 newSessionId 一律保持当前
 * 会话（不预填、不切换）；user 预填语义由 prefill 携带，assistant 不传即无。
 */
export type ForkSideEffectPlan =
  | { kind: "noop" }
  | { kind: "switch-session"; sessionId: string; prefill?: string };

export function planForkResult(
  result: BranchCommandResult | null | undefined,
  prefill?: string,
): ForkSideEffectPlan {
  const { cancelled, newSessionId } = result ?? {};
  if (cancelled || !newSessionId) return { kind: "noop" };
  return {
    kind: "switch-session",
    sessionId: newSessionId,
    ...(prefill ? { prefill } : {}),
  };
}

/** 输入框句柄（replaceText / insertIfEmpty 语义对齐 ChatInputHandle）。 */
export interface BranchEditorHandle {
  replaceText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
}

/**
 * 分支导航副作用执行：cancelled/aborted（noop）不改输入、不刷新；
 * replace 模式（从此处分支）string 即替换（含空串清空），
 * insertIfEmpty 模式（带选项切换）仅非空插入。
 * 返回是否应继续刷新会话（noop → false，调用方保持当前 context）。
 */
export function applyNavigationSideEffects(
  plan: { noop: boolean; editorText?: string },
  editor: BranchEditorHandle | null | undefined,
  mode: "replace" | "insertIfEmpty",
): boolean {
  if (plan.noop) return false;
  const text = plan.editorText;
  if (typeof text === "string") {
    if (mode === "replace") {
      editor?.replaceText(text);
    } else if (text !== "") {
      editor?.insertIfEmpty(text);
    }
  }
  return true;
}

/** 刷新会话后的分支动作结果：成功 ok；失败 error（文案由调用方给出）。 */
export function finalizeBranchRefresh(
  refreshed: unknown,
  failMessage: string,
): BranchActionResult {
  if (refreshed) return { kind: "ok" };
  return { kind: "error", message: failMessage };
}

// ── React hook ────────────────────────────────────────────────────────────

/** useAgentSession 分支 / 新会话命令的上下文注入（显式传参，不反向依赖上层返回值）。 */
export interface UseSessionCommandsOptions {
  /** 当前会话 id（新会话 ensure 成功后由调用方写入 ref）。 */
  sessionIdRef: RefObject<string | null>;
  /** 只读（subagent 持久化）会话：一切写命令在 UI 层拦截，后端仍为权威防线。 */
  isReadOnly: boolean;
  /** 分支写入口是否可用（capabilities.canSendSessionCommands）。 */
  canWrite: boolean;
  /** 从 per-session BrowserSessionRuntimeRegistry 读取运行态。 */
  getAgentRunning: () => boolean;
  bashRunningRef: RefObject<boolean>;
  /** 分支切换进行中门禁：ref 与 state 必须同源，二者同时写（见调用方）。 */
  branchBusyRef: RefObject<boolean>;
  branchBusy: boolean;
  setBranchBusy: (busy: boolean) => void;
  setForkingEntryId: (id: string | null) => void;
  setActiveLeafId: (leafId: string | null) => void;
  sendAgentCommand: typeof sendAgentCommand;
  /** 整体重新 GET 会话（分支导航成功后应用新 context；reportSuccess/resetBranchFollow 语义由调用方实现保留）。 */
  loadSession: (
    sid: string,
    showLoading?: boolean,
    includeState?: boolean,
    reportSuccess?: boolean,
    resetBranchFollow?: boolean,
  ) => Promise<unknown>;
  /** 按 leaf 拉取 context（只读降级路径与 leaf 切换）。 */
  loadContext: (sid: string, leafId: string | null) => Promise<void>;
  addNotice: (notice: { id?: string; message: string; type?: "info" | "success" | "warning" | "error" }) => void;
  chatInputRef?: RefObject<ChatInputHandle | null>;
  /** fork/新会话成功后切换会话；prefill 为预填到新会话输入框的文本（draft 注入）。 */
  onSessionForked?: (newSessionId: string, prefill?: string) => void;
}

/**
 * 分支 / 新会话命令集（P3a 自 useAgentSession 迁出）：
 * handleFork / handleNavigate / handleLeafChange / handleBranchHere /
 * handleBranchFromAssistant / navigateBranch / setBranchLabel，外加 branchActions 与 branchBusy。
 * 命令逻辑不直接持 React state，全部经显式注入的依赖执行。
 */
export function useSessionCommands(options: UseSessionCommandsOptions) {
  const {
    sessionIdRef,
    isReadOnly,
    canWrite,
    getAgentRunning,
    bashRunningRef,
    branchBusyRef,
    branchBusy,
    setBranchBusy,
    setForkingEntryId,
    setActiveLeafId,
    sendAgentCommand,
    loadSession,
    loadContext,
    addNotice,
    chatInputRef,
    onSessionForked,
  } = options;

  const handleFork = useCallback(async (entryId: string) => {
    // 只读会话：fork 会创建新 session 文件，拦截。
    if (isReadOnly) return;
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<BranchCommandResult>(sid, {
        type: "fork",
        entryId,
      });
      const plan = planForkResult(result);
      if (plan.kind === "switch-session") {
        onSessionForked?.(plan.sessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
    } finally {
      setForkingEntryId(null);
    }
  }, [isReadOnly, bashRunningRef, sessionIdRef, setForkingEntryId, sendAgentCommand, onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    if (bashRunningRef.current || branchBusyRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (isReadOnly) {
      // 只读降级：分支切换只发纯 GET context，不发 navigate_tree 写命令。
      setActiveLeafId(entryId);
      await loadContext(sid, entryId);
      return;
    }
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [isReadOnly, bashRunningRef, branchBusyRef, sessionIdRef, setActiveLeafId, sendAgentCommand, loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current || branchBusyRef.current) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    // 只读会话不持久化分支位置（select_leaf_exact 会写会话状态）。
    if (leafId && !isReadOnly) {
      // 分支树点选 = 精确 leaf（user 叶也停在该 entry，不触发 Pi 的 user 编辑语义）
      sendAgentCommand(sid, { type: "select_leaf_exact", entryId: leafId }).catch(() => {});
    }
  }, [isReadOnly, bashRunningRef, branchBusyRef, sessionIdRef, setActiveLeafId, sendAgentCommand, loadContext]);

  /**
   * 用户「从此处分支」：await navigate_tree(user)（Pi 编辑语义：leaf=parent + editorText）。
   * cancelled（扩展拒绝）则完全不改 UI；成功才 replace 预填并刷新当前路径。
   * 真正分叉 = 用户随后发送新消息（在当前 leaf 下 append）。
   */
  const handleBranchHere = useCallback(async (entryId: string, text?: string) => {
    const gate = gateBranchAction({
      readOnly: isReadOnly,
      busy: getAgentRunning() || bashRunningRef.current || branchBusyRef.current,
    });
    if (!gate.allowed) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    branchBusyRef.current = true;
    setBranchBusy(true);
    try {
      const result = await sendAgentCommand<BranchCommandResult>(sid, {
        type: "navigate_tree",
        targetId: entryId,
        summarize: false,
      });
      // cancelled：不预填、不刷新，保持当前 context。
      if (!applyNavigationSideEffects(
        { noop: Boolean(result?.cancelled), editorText: result?.editorText },
        chatInputRef?.current,
        "replace",
      )) return;
      // 外部 RPC 磁盘 navigate_tree 不返回 editorText；用传入的用户消息文本预填
      // （「从此处分支」= 分支后把该消息填到输入框）
      if (text?.trim()) {
        chatInputRef?.current?.replaceText(text.trim());
      }
      await loadSession(sid, false, false, true, true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message });
    } finally {
      branchBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [addNotice, isReadOnly, getAgentRunning, bashRunningRef, branchBusyRef, sessionIdRef, setBranchBusy, sendAgentCommand, chatInputRef, loadSession]);

  /**
   * Assistant「基于此回答分支」（选项 B）：服务端计算 turnEnd（至下一条 user 前最后 entry），
   * navigateTree(turnEnd) 精确设 leaf（turnEnd 恒非 user）。成功后将回答文本预填输入框
   * （与 user 分叉的 editorText 预填语义对称）。发送后长新枝。
   */
  const handleBranchFromAssistant = useCallback(async (entryId: string) => {
    const gate = gateBranchAction({
      readOnly: isReadOnly,
      busy: getAgentRunning() || bashRunningRef.current || branchBusyRef.current,
    });
    if (!gate.allowed) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    branchBusyRef.current = true;
    setBranchBusy(true);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean }>(sid, {
        type: "branch_from_assistant",
        assistantEntryId: entryId,
      });
      if (result?.cancelled) return;
      await loadSession(sid, false, false, true, true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message });
    } finally {
      branchBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [addNotice, isReadOnly, getAgentRunning, bashRunningRef, branchBusyRef, sessionIdRef, setBranchBusy, sendAgentCommand, loadSession]);

  /**
   * 用户「从此处开始新会话」：fork（SDK before-entry：createBranchedSession(user.parentId)）
   * 创建线性新会话（不含该 user 及其后、不含其他分支），切换会话并预填该用户消息。
   */
  const handleNewSessionFromHere = useCallback(async (entryId: string, text: string) => {
    const gate = gateBranchAction({
      readOnly: isReadOnly,
      busy: getAgentRunning() || bashRunningRef.current || branchBusyRef.current,
    });
    if (!gate.allowed) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    branchBusyRef.current = true;
    setBranchBusy(true);
    try {
      const result = await sendAgentCommand<BranchCommandResult>(sid, {
        type: "fork",
        entryId,
      });
      const plan = planForkResult(result, text);
      if (plan.kind === "switch-session") {
        onSessionForked?.(plan.sessionId, plan.prefill);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message });
    } finally {
      branchBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [addNotice, isReadOnly, getAgentRunning, bashRunningRef, branchBusyRef, sessionIdRef, setBranchBusy, sendAgentCommand, onSessionForked]);

  /**
   * Assistant「基于此回答开始新会话」：create_session_from_leaf（SDK through-entry：
   * 含轮末 turnEnd 的路径克隆），切换新会话；不预填输入框。
   */
  const handleNewSessionFromAnswer = useCallback(async (entryId: string) => {
    const gate = gateBranchAction({
      readOnly: isReadOnly,
      busy: getAgentRunning() || bashRunningRef.current || branchBusyRef.current,
    });
    if (!gate.allowed) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    branchBusyRef.current = true;
    setBranchBusy(true);
    try {
      const result = await sendAgentCommand<BranchCommandResult>(sid, {
        type: "create_session_from_leaf",
        entryId,
      });
      const plan = planForkResult(result);
      if (plan.kind === "switch-session") {
        // assistant 不预填：不传 prefill。
        onSessionForked?.(plan.sessionId);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message });
    } finally {
      branchBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [addNotice, isReadOnly, getAgentRunning, bashRunningRef, branchBusyRef, sessionIdRef, setBranchBusy, sendAgentCommand, onSessionForked]);

  /**
   * 带选项的分支切换（D3）：直接 / 默认摘要 / 自定义焦点。
   * 取消或中止保留当前 context；成功后整体重新 GET，让 tree/active leaf/context/
   * branch_summary 即时一致。SDK 导航到 user message 返回的 editorText 回填输入框，
   * 维持既有「从该处编辑」行为。
   */
  const navigateBranch = useCallback(async (targetId: string, choice: BranchSwitchChoice): Promise<BranchActionResult> => {
    const gate = gateBranchAction({
      readOnly: isReadOnly,
      busy: getAgentRunning() || bashRunningRef.current || branchBusyRef.current,
    });
    if (!gate.allowed) return { kind: gate.reason === "busy" ? "busy" : "error" };
    const command = buildBranchSwitchCommand(targetId, choice);
    if (!command) return { kind: "error" };
    const sid = sessionIdRef.current;
    if (!sid) return { kind: "error" };
    branchBusyRef.current = true;
    setBranchBusy(true);
    try {
      const result = await sendAgentCommand<BranchCommandResult>(sid, command);
      // 取消/中止：用户主动行为，保留当前 context，静默返回。
      if (!applyNavigationSideEffects(
        { noop: Boolean(result?.cancelled || result?.aborted), editorText: result?.editorText },
        chatInputRef?.current,
        "insertIfEmpty",
      )) return { kind: "cancelled" };
      const refreshed = await loadSession(sid, false, false, true, true);
      if (!refreshed) {
        const message = "Failed to refresh session after switching branches";
        addNotice({ type: "error", message });
        return { kind: "error", message };
      }
      return { kind: "ok" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message });
      return { kind: "error", message };
    } finally {
      branchBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [addNotice, isReadOnly, getAgentRunning, bashRunningRef, branchBusyRef, sessionIdRef, setBranchBusy, sendAgentCommand, chatInputRef, loadSession]);

  /**
   * 设置/清除分支书签（D3）：只经 set_branch_label 命令，不直接写会话文件；
   * 成功后整体刷新，让 tree 上的书签即时一致。rawLabel 传空串表示清除。
   */
  const setBranchLabel = useCallback(async (targetId: string, rawLabel: string): Promise<BranchActionResult> => {
    const gate = gateBranchAction({
      readOnly: isReadOnly,
      busy: getAgentRunning() || bashRunningRef.current || branchBusyRef.current,
    });
    if (!gate.allowed) return { kind: gate.reason === "busy" ? "busy" : "error" };
    const command = buildSetBranchLabelCommand(targetId, rawLabel);
    if (!command) return { kind: "error" };
    const sid = sessionIdRef.current;
    if (!sid) return { kind: "error" };
    branchBusyRef.current = true;
    setBranchBusy(true);
    try {
      await sendAgentCommand(sid, command);
      const refreshed = await loadSession(sid, false, false, true);
      if (!refreshed) {
        const message = "Failed to refresh session after saving the bookmark";
        addNotice({ type: "error", message });
        return { kind: "error", message };
      }
      return { kind: "ok" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      addNotice({ type: "error", message });
      return { kind: "error", message };
    } finally {
      branchBusyRef.current = false;
      setBranchBusy(false);
    }
  }, [addNotice, isReadOnly, getAgentRunning, bashRunningRef, branchBusyRef, sessionIdRef, setBranchBusy, sendAgentCommand, loadSession]);

  const branchActions = useMemo<BranchActions>(() => ({
    canWrite,
    busy: branchBusy,
    navigate: navigateBranch,
    setLabel: setBranchLabel,
  }), [canWrite, branchBusy, navigateBranch, setBranchLabel]);

  return {
    handleFork,
    handleNavigate,
    handleLeafChange,
    handleBranchHere,
    handleBranchFromAssistant,
    handleNewSessionFromHere,
    handleNewSessionFromAnswer,
    navigateBranch,
    setBranchLabel,
    branchActions,
    branchBusy,
  };
}
