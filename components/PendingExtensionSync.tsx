"use client";

import { useEffect, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ExtensionUiDialogRequest } from "@/lib/extension-ui-bridge";
import { ExtensionDialog, type ExtensionDialogResponse } from "./ExtensionDialog";

type PendingItem = {
  sessionId: string;
  requests: Array<Record<string, unknown>>;
};

function isDialogRequest(value: Record<string, unknown>): value is ExtensionUiDialogRequest {
  const method = value.method;
  return method === "select" || method === "confirm" || method === "input" || method === "editor";
}

function pickForeignDialog(
  items: PendingItem[],
  selectedSessionId: string | null,
): { sessionId: string; request: ExtensionUiDialogRequest } | null {
  for (const item of items) {
    if (selectedSessionId && item.sessionId === selectedSessionId) continue;
    const request = item.requests.find(isDialogRequest);
    if (request) return { sessionId: item.sessionId, request };
  }
  return null;
}

/**
 * 同一运行时的其它客户端：当前未打开的会话若有阻塞 Extension 弹窗，在此补显。
 * 当前选中会话仍由 ChatWindow / SSE 负责，避免双弹窗。
 */
export function PendingExtensionSync({ selectedSessionId }: { selectedSessionId: string | null }) {
  const [foreign, setForeign] = useState<{ sessionId: string; request: ExtensionUiDialogRequest } | null>(null);

  useEffect(() => {
    const apply = (items: unknown) => {
      if (!Array.isArray(items)) return;
      setForeign(pickForeignDialog(items as PendingItem[], selectedSessionId));
    };

    void fetch("/api/agent/running", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { pendingExtensionUi?: unknown }) => apply(d.pendingExtensionUi))
      .catch(() => undefined);

    const source = new EventSource("/api/agent/running/events");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { pendingExtensionUi?: unknown };
        apply(data.pendingExtensionUi);
      } catch {
        /* ignore */
      }
    };
    return () => source.close();
  }, [selectedSessionId]);

  if (!foreign) return null;

  const onRespond = async (response: ExtensionDialogResponse) => {
    const { sessionId, request } = foreign;
    try {
      await sendAgentCommand(sessionId, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
      if ("cancelled" in response && response.cancelled === true) {
        try {
          await sendAgentCommand(sessionId, { type: "abort" });
        } catch {
          /* abort 失败不挡取消 */
        }
      }
    } catch (error) {
      console.error("Failed to respond to synced extension UI:", error);
    }
    setForeign(null);
  };

  return <ExtensionDialog request={foreign.request} onRespond={(response) => { void onRespond(response); }} />;
}
