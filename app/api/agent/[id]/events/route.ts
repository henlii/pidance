import { sessionService, READ_ONLY_SUBAGENT_ERROR, requireWritableSession, httpStatusForSessionError } from "@/lib/session-service";
import { projectAgentEvent } from "@/lib/agent-event-stream";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // 门禁错误形态与历史一致：readOnly→403 JSON，门禁内部异常→500 JSON（非 Failed to start 文本）
  try {
    await requireWritableSession(id, sessionService.isReadOnly);
  } catch (error) {
    const status = httpStatusForSessionError(error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: status === 403 ? READ_ONLY_SUBAGENT_ERROR : message }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  // SSE 只连接当前进程已经存在的 live host；打开历史会话不得因为 attach
  // 自动创建 writer。首次写操作由 submitPrompt 显式唤醒。
  const session = sessionService.getLive(id);
  if (!session) {
    return new Response(JSON.stringify({ error: "Agent is not live" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        try {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already closed
        }
      };

      // Send initial connected event
      encode({ type: "connected", sessionId: id });

      // 事件投影纯函数（lib/agent-event-stream.ts）：丢弃 turn_start/turn_end、
      // 透传 tool_execution_update、message_update 去 assistantMessageEvent、
      // agent_end 瘦身、无合法 type 丢弃。
      const unsubscribe = session.onEvent((event) => {
        const projected = projectAgentEvent(event);
        if (projected !== null) encode(projected);
      });

      // SSE 生命周期绑定 host：空闲 dispose 会关闭流，浏览器侧收到 CLOSED
      // 后不再认为会话仍在 live（否则列表/输入态与宿主脱节，见 #28 A1/A3）。
      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        encode(":");
      }, 30_000);

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // host destroy（空闲 dispose/删除）时主动终断 SSE 流
      session.onDestroy(cleanup);

      // Detect client disconnect via abort signal
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
