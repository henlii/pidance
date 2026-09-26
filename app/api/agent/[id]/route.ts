import { NextResponse } from "next/server";
import { sessionService, requireWritableSession, httpStatusForSessionError } from "@/lib/session-service";
import { isTypedMessageCommandType, parseTypedMessageCommand } from "@/lib/agent-commands";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    await requireWritableSession(id, sessionService.isReadOnly);
    const body = await req.json() as { type?: string; [key: string]: unknown };
    if (typeof body.type !== "string" || !body.type) {
      return NextResponse.json({ error: "type is required" }, { status: 400 });
    }
    if (isTypedMessageCommandType(body.type)) {
      try {
        const command = parseTypedMessageCommand(body);
        if (command.type === "prompt") {
          const receipt = await sessionService.submitPrompt(id, command);
          return NextResponse.json({ success: true, data: receipt });
        }
        const result = await sessionService.send(id, command, { signal: req.signal });
        return NextResponse.json({ success: true, data: result });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("required") || message.startsWith("Unsupported") || message.startsWith("invalid") || message.includes("must be")) {
          return NextResponse.json({ error: message }, { status: 400 });
        }
        throw error;
      }
    }
    // 编辑器接管的视图上报是**纯登记**（issue #107 四轮审查 阻断 1）：客户端切走 / 关标签时
    // 会补一条 shown=false 注销自己在旧会话上的登记，而宿主可能已经把那个会话回收了。
    // 走 send 会对已经不 live 的会话 ensureLive —— 为了注销一条登记去唤醒旧宿主、让它占上
    // 写者租约，还会让侧栏把那个会话短暂显示成运行中。没有 live host 时这条登记没有意义，
    // 直接按成功返回。
    if (body.type === "editor_takeover_view" && !sessionService.getLive(id)) {
      return NextResponse.json({ success: true, data: null });
    }
    const result = await sessionService.send(id, body as { type: string; [key: string]: unknown }, { signal: req.signal });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: httpStatusForSessionError(error) });
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // light=1：轮询用。省略 systemPrompt（数十 KB 且几乎不变）；
  // 消费方按「键缺失 = 本次不更新」处理，语义不变。
  const light = new URL(req.url).searchParams.get("light") === "1";

  try {
    const result = await sessionService.getAgentState(id, { light });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: httpStatusForSessionError(error) });
  }
}
