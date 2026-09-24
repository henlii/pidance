import { sessionService, READ_ONLY_SUBAGENT_ERROR, requireWritableSession, httpStatusForSessionError } from "@/lib/session-service";
import { projectAgentEvent } from "@/lib/agent-event-stream";
import { isEventIncludedInSnapshot, type SnapshotEvent } from "@/lib/stream-snapshot";
import { registerEventStreamCloser } from "@/lib/server-shutdown";

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

      // 事件投影纯函数（lib/agent-event-stream.ts）：丢弃 turn_start/turn_end、
      // 透传 tool_execution_update、message_update 去 assistantMessageEvent、
      // agent_end 瘦身、无合法 type 丢弃。
      //
      // 先订阅再取快照：两者之间没有 await（同一段同步代码），所以不会漏事件；
      // 万一以后加了异步步骤，缓冲下来并在快照之后回放。
      let snapshotSent = false;
      const buffered: SnapshotEvent[] = [];
      const unsubscribe = session.onEvent((event) => {
        const projected = projectAgentEvent(event);
        if (projected === null) return;
        // 投影保证非空 type（无合法 type 的直接返回 null），这里按快照事件形状收窄。
        const frame = projected as SnapshotEvent;
        if (!snapshotSent) {
          buffered.push(frame);
          return;
        }
        encode(frame);
      });

      // 首帧：connected 带 isStreaming，随后回放当前流式消息与活跃工具。
      // 中途接入的页面（新标签/重连/冷挂载）因此立刻看到已生成的部分回复与正在跑
      // 的工具输出，而不是等到下一个 chunk。
      const snapshot = session.connectionSnapshot();
      encode({ type: "connected", sessionId: id, isStreaming: snapshot.isStreaming });
      for (const event of snapshot.events) encode(event);
      snapshotSent = true;
      for (const event of buffered) {
        if (isEventIncludedInSnapshot(event, snapshot)) continue;
        encode(event);
      }
      buffered.length = 0;

      // SSE 生命周期绑定 host：空闲 dispose 会关闭流，浏览器侧收到 CLOSED
      // 后不再认为会话仍在 live（否则列表/输入态与宿主脱节，见 #28 A1/A3）。
      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        encode(":");
      }, 10_000);

      let cleaned = false;
      let releaseDestroy: (() => void) | null = null;
      let unregisterCloser: () => void = () => {};
      const cleanup = (shutdownReason?: string) => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        unsubscribe();
        // 已断开的流必须退订：否则 host 的销毁通知集合会随连接数增长。
        releaseDestroy?.();
        releaseDestroy = null;
        unregisterCloser();
        try {
          // 收尾（进程退出）必须用 error 硬断：close() 会被 Next 管道吞掉，
          // 连接照旧挂着，server.close() 继续等。
          if (shutdownReason) controller.error(new Error(shutdownReason));
          else controller.close();
        } catch {
          // already closed
        }
      };

      // 进程退出时由 lib/server-shutdown.ts 硬断本流（顺序：先 dispose writer 再断流）。
      unregisterCloser = registerEventStreamCloser(() =>
        cleanup("pidance server shutting down"),
      );

      // host destroy（空闲 dispose/删除）时主动终断 SSE 流
      releaseDestroy = session.onDestroy(() => cleanup());
      // 注册前已清理（客户端在注册窗口内断开）：立即退订，不留悬挂回调。
      if (cleaned) {
        releaseDestroy();
        releaseDestroy = null;
        unregisterCloser();
      }

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", () => cleanup());
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
