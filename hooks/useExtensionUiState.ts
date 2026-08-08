"use client";

import { useCallback, useRef, useState } from "react";
import {
  clearExtensionUiRequest,
  createEmptyExtensionUiState,
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

  const extensionUiStateRef = useRef<ExtensionUiState>(createEmptyExtensionUiState({
    customUi: extensionCustomUi,
    statuses: extensionStatuses,
    widgets: extensionWidgets,
  }));

  const commitExtensionUiState = useCallback((next: ExtensionUiState) => {
    extensionUiStateRef.current = next;
    setExtensionDialog(next.dialog);
    setExtensionCustomUi(next.customUi);
    setExtensionStatuses(next.statuses);
    setExtensionWidgets(next.widgets);
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

  return {
    extensionDialog,
    extensionCustomUi,
    extensionStatuses,
    extensionWidgets,
    extensionUiStateRef,
    commitExtensionUiState,
    patchExtensionUiState,
    dismissExtensionUiRequest,
  };
}
