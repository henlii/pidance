import { sessionService } from "@/lib/session-service";
import { getPidancePrefsBus } from "@/lib/pidance-prefs-bus";

export const dynamic = "force-dynamic";

// GET /api/agent/running/events - SSE stream of the set of currently-running
// session ids. Pushes an update whenever any session starts or stops working,
// so the sidebar never has to poll.
export async function GET(req: Request) {
  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      const encodeRunning = (ids: string[]) => {
        encode({
          type: "running",
          runningSessionIds: ids,
          runningStartedAt: sessionService.getRunningStartedAt(),
          pendingExtensionUi: sessionService.listPendingExtensionUi(),
        });
      };

      const unsubscribe = sessionService.subscribeRunning((ids) => {
        try {
          encodeRunning(ids);
        } catch {
          // controller already closed
        }
      });

      // 偏好变更也走这条流（#66）：**不再单独开一条 SSE** —— 浏览器同源并发连接有限，
      // 多一条长连接会在「刷新页面」这种旧连接未关的时刻把普通请求挤住（实测踩过）。
      const prefsBus = getPidancePrefsBus();
      const unsubscribePrefs = prefsBus.subscribe((change) => {
        try {
          encode({ type: "prefs", ...change });
        } catch {
          /* controller already closed */
        }
      });

      encodeRunning(sessionService.getRunningIds());

      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribePrefs();
        try { controller.close(); } catch { /* already closed */ }
      };

      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
