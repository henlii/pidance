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

  // ensureLive：复用 alive 或 resolve/start；Route 不再直接 import rpc-manager
  let session;
  try {
    session = await sessionService.ensureLive(id);
  } catch (error) {
    const status = httpStatusForSessionError(error);
    const message = error instanceof Error ? error.message : String(error);
    if (status === 404) {
      return new Response("Session not found", { status: 404 });
    }
    if (status !== 500) {
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(`Failed to start agent: ${error}`, { status: 500 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encode = (data: unknown) => {
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
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

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);

      // Cleanup when client disconnects
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        controller.close();
      };

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
