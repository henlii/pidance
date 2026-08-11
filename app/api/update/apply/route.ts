import { applyPidanceUpdate } from "@/lib/pidance-update";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

/**
 * POST /api/update/apply
 * - Accept: text/event-stream（或 query stream=1）→ SSE 推送进度 + 最终 result
 * - 否则 → JSON 最终结果（兼容关于页旧调用）
 */
export async function POST(req: Request) {
  let targetVersion: string | undefined;
  let wantStream = false;
  try {
    const body = (await req.json()) as { version?: unknown; stream?: unknown };
    if (typeof body.version === "string" && body.version.trim()) {
      targetVersion = body.version.trim();
    }
    wantStream = body.stream === true || body.stream === 1 || body.stream === "1";
  } catch {
    /* empty body ok */
  }
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) wantStream = true;
  const url = new URL(req.url);
  if (url.searchParams.get("stream") === "1") wantStream = true;

  if (!wantStream) {
    try {
      const result = await applyPidanceUpdate({ targetVersion });
      const status =
        result.status === "not_supported" ? 403
          : result.status === "error" ? 500
            : 200;
      return Response.json(result, {
        status,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return Response.json(
        {
          ok: false,
          status: "error",
          currentVersion: "?",
          targetVersion: null,
          message,
        },
        { status: 500 },
      );
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          /* closed */
        }
      };

      void (async () => {
        try {
          const result = await applyPidanceUpdate({
            targetVersion,
            onProgress: (ev) => {
              send({ type: "progress", ...ev });
            },
          });
          send({ type: "result", result });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          send({
            type: "result",
            result: {
              ok: false,
              status: "error",
              currentVersion: "?",
              targetVersion: targetVersion ?? null,
              message,
            },
          });
        } finally {
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-cache",
      Connection: "keep-alive",
    },
  });
}
