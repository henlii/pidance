import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";

export const dynamic = "force-dynamic";

// GET /api/agent/running
// 当前运行中会话 id 的轮询端点（对齐上游 0.8.6 agent/running）：
// 与 SSE running/events 等价但一次请求即回，供轮询/恢复场景使用。
export async function GET() {
	return NextResponse.json(
		{
			runningSessionIds: sessionService.getRunningIds(),
			pendingExtensionUi: sessionService.listPendingExtensionUi(),
		},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
