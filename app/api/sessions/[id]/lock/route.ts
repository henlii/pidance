import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";

/**
 * GET /api/sessions/[id]/lock — 只读的 writer 租约探针（锁定条的发现路径）。
 *
 * 为什么单独一条路由：锁定态来自**另一个进程**持有的租约文件，本进程没有事件可订阅，
 * 只能由客户端轮询。而客户端空闲期的状态刷新是 2 分钟一档（空闲且事件流活着时故意
 * 收紧，见 useAgentSession 的 RECONCILE_IDLE_MS），用它发现「对端刚抢走写权」太慢；
 * `/state` 又要做完整状态投影，按秒轮询等于把收紧掉的开销加回来。这条只读一次租约
 * 文件（existsSync + read + kill(0)），不做任何投影。
 *
 * 状态码：缺参 400；探针自身异常 503（客户端**保留上一次状态**，不要误清锁定条）；
 * 其余恒 200 `{ lockedByOther }`。会话不存在也返回 200 false —— 没有租约就是没被占用。
 */
export type SessionLockDeps = {
  isLockedByOther: (sessionId: string) => boolean;
};

export function createSessionLockHandler(deps: SessionLockDeps = {
  isLockedByOther: (sessionId) => sessionService.isLockedByOther(sessionId),
}) {
  return async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    if (typeof id !== "string" || id.trim() === "") {
      return NextResponse.json({ error: "Missing session id" }, { status: 400 });
    }
    try {
      return NextResponse.json({ lockedByOther: deps.isLockedByOther(id) === true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: message, code: "unavailable" }, { status: 503 });
    }
  };
}

export const GET = createSessionLockHandler();
export const dynamic = "force-dynamic";
