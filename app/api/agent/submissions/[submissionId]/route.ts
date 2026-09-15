import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent/submissions/[submissionId]
 *
 * 查询一个新建会话提交的状态。真实 sessionId 只有启动完成后才存在，所以
 * 「POST /api/agent/new 的响应还没回来」时，客户端只能靠这个端点对账。
 *
 * no-store：状态是瞬时事实，不能被缓存。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ submissionId: string }> },
) {
  const { submissionId } = await params;
  if (!submissionId || typeof submissionId !== "string") {
    return NextResponse.json({ error: "submissionId is required" }, { status: 400 });
  }
  return NextResponse.json(
    { submission: sessionService.getSubmission(submissionId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * POST /api/agent/submissions/[submissionId]  body: { type: "cancel" }
 *
 * 显式取消一个提交。**这不是「连接断开」**：弱网、关页与用户按 Stop 不是同一
 * 意图，因此不使用请求 AbortSignal 自动映射为 Agent abort。
 *
 * 返回 status：
 * - `pending`   已登记（提交尚未落地，或该 id 尚未出现），并未确认停掉任何东西；
 * - `confirmed` 已对原运行发出 abort。
 * 客户端在 pending 时不得声称「已停止」，也不得自动重发。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ submissionId: string }> },
) {
  const { submissionId } = await params;
  if (!submissionId || typeof submissionId !== "string") {
    return NextResponse.json({ error: "submissionId is required" }, { status: 400 });
  }

  let body: { type?: string };
  try {
    body = await req.json() as { type?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body?.type !== "cancel") {
    return NextResponse.json(
      { error: `Unsupported submission command: ${String(body?.type)}` },
      { status: 400 },
    );
  }

  const result = await sessionService.cancelSubmission(submissionId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
