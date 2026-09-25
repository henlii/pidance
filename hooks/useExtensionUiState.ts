"use client";

import { useCallback, useRef, useState } from "react";
import {
  clearExtensionUiRequest,
  createEmptyExtensionUiState,
  rememberSettledRequestId,
  type ExtensionUiDialogRequest,
  type ExtensionUiCustomRequest,
  type ExtensionUiState,
} from "@/lib/extension-ui-bridge";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";

// 兼容 re-export：useAgentSession 与其消费方沿用既有类型名。
export type { ExtensionUiDialogRequest, ExtensionUiCustomRequest } from "@/lib/extension-ui-bridge";

/**
 * extension UI 展示状态（#17 D5c 自 useAgentSession 抽出的第一刀，纯移动）。
 * 持有阻塞请求队列在 React 侧的投影 state、镜像 ref 与三个更新回调；
 * useAgentSession 解构后所有既有使用点保持零改动。
 *
 * 对齐 TUI：阻塞请求（select/confirm/input/editor）一律弹窗承载（dialog），
 * 无内联卡片形态。
 */
export function useExtensionUiState() {
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [extensionTerminalInputListenerCount, setExtensionTerminalInputListenerCount] = useState(0);
  const [extensionWorkingMessage, setExtensionWorkingMessage] = useState<string | null>(null);
  const [extensionWorkingVisible, setExtensionWorkingVisible] = useState(true);
  const [extensionWorkingIndicator, setExtensionWorkingIndicator] = useState<{ frames: string[]; intervalMs: number } | null>(null);
  /** 插件自定义的折叠思考标签（setHiddenThinkingLabel）；null = 用我们的默认文案。 */
  const [extensionHiddenThinkingLabel, setExtensionHiddenThinkingLabel] = useState<string | null>(null);
  /** 插件页头槽位（setHeader）；null = 没有插件页头。 */
  const [extensionHeader, setExtensionHeader] = useState<string[] | null>(null);
  /** 插件页脚槽位（setFooter）；null = 用我们自己的状态条。 */
  const [extensionFooter, setExtensionFooter] = useState<string[] | null>(null);
  /** 扩展请求的全局工具展开态（issue #75）：null = 从未请求过，客户端保持每块自己的折叠。 */
  const [extensionToolsExpandedRequest, setExtensionToolsExpandedRequest] = useState<{ expanded: boolean; revision: number } | null>(null);

  const extensionUiStateRef = useRef<ExtensionUiState>(createEmptyExtensionUiState({
    customUi: extensionCustomUi,
    statuses: extensionStatuses,
    widgets: extensionWidgets,
  }));
  /**
   * 已经被**宿主**结算过的阻塞请求 id（有界 FIFO，见 rememberSettledRequestId）。
   *
   * 两个用途：收到 `extension_ui_settled` 时把面板收起；以及**挡住比结算事件晚到的
   * 状态快照**把它装回来（那个快照是在结算之前序列化的，里面还有这个 id）。
   * 用 ref 不用 state：它不参与渲染，改它不该触发重渲。
   */
  const settledRequestIdsRef = useRef<string[]>([]);

  const commitExtensionUiState = useCallback((next: ExtensionUiState) => {
    extensionUiStateRef.current = next;
    setExtensionDialog(next.dialog);
    setExtensionCustomUi(next.customUi);
    setExtensionStatuses(next.statuses);
    setExtensionWidgets(next.widgets);
    setExtensionTerminalInputListenerCount(next.terminalInputListenerCount);
    setExtensionWorkingMessage(next.workingMessage);
    setExtensionWorkingVisible(next.workingVisible);
    setExtensionWorkingIndicator(next.workingIndicator);
    setExtensionHiddenThinkingLabel(next.hiddenThinkingLabel);
    setExtensionHeader(next.header);
    setExtensionFooter(next.footer);
    setExtensionToolsExpandedRequest(next.toolsExpanded === null
      ? null
      : { expanded: next.toolsExpanded, revision: next.toolsExpandedRevision });
  }, []);

  const patchExtensionUiState = useCallback((patch: Partial<ExtensionUiState>) => {
    commitExtensionUiState({ ...extensionUiStateRef.current, ...patch });
  }, [commitExtensionUiState]);

  /** 按 id 移除阻塞请求并推进队列；不发送协议响应（本地过期 / 服务端已结算） */
  const dismissExtensionUiRequest = useCallback((requestId: string) => {
    const currentState = extensionUiStateRef.current;
    const nextState = clearExtensionUiRequest(currentState, requestId);
    if (nextState === currentState) return;
    commitExtensionUiState(nextState);
  }, [commitExtensionUiState]);

  /**
   * 记住一个已结算的请求 id。宿主已结算的面板**不该**再被迟到的状态快照装回来；
   * 调用方（SSE 分支）紧接着调 dismissExtensionUiRequest 收起当前面板。
   */
  const markExtensionUiRequestSettled = useCallback((requestId: string) => {
    settledRequestIdsRef.current = rememberSettledRequestId(settledRequestIdsRef.current, requestId);
  }, []);

  /** 切会话时丢掉上一会话的结算记录（它的请求 id 不会再出现在新会话的快照里）。 */
  const clearSettledExtensionUiRequests = useCallback(() => {
    settledRequestIdsRef.current = [];
  }, []);

  return {
    extensionDialog,
    extensionCustomUi,
    extensionStatuses,
    extensionWidgets,
    extensionTerminalInputListenerCount,
    extensionWorkingMessage,
    extensionWorkingVisible,
    extensionWorkingIndicator,
    extensionHiddenThinkingLabel,
    extensionHeader,
    extensionFooter,
    extensionUiStateRef,
    commitExtensionUiState,
    patchExtensionUiState,
    extensionToolsExpandedRequest,
    dismissExtensionUiRequest,
    settledRequestIdsRef,
    markExtensionUiRequestSettled,
    clearSettledExtensionUiRequests,
  };
}
