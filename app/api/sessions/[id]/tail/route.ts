import { NextResponse } from "next/server";
import { sessionService } from "@/lib/session-service";
import { probeSessionFile, readFileStamp, waitForSessionFileChange } from "@/lib/session-file-tail";

/**
 * GET /api/sessions/[id]/tail?offset=<byte>&ino=<inode>&wait=<ms>
 *
 * 会话文件跟随的探测端点（跨进程 / 外部修改）。
 *
 * - 不带 `offset`：只建基线，`changed=false`。客户端刚读完详情时用这一次对齐偏移。
 * - 带 `offset+ino`：文件长出新行 → `changed=true`；文件变短/换 inode →
 *   没有 writer 时 `reset`（整份重载），有 writer 时 `externalRewrite`（拒绝静默合并）。
 * - `wait`：长轮询，最长 10s。一个在途请求就是一份订阅，客户端 abort 即退订，
 *   服务端不维护全局 watch 表。
 *
 * 只读探针：不 wake host、不写租约、不改缓存。
 */
export const dynamic = "force-dynamic";

const MAX_WAIT_MS = 10_000;

function parseNonNegative(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function unavailable(sessionId: string) {
  return {
    sessionId,
    available: false,
    localLive: false,
    writerActive: false,
    ino: 0,
    size: 0,
    lastEntryId: null,
    changed: false,
    reset: false,
    externalRewrite: false,
  };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(req.url);
  const hasOffset = url.searchParams.has("offset");
  const offset = parseNonNegative(url.searchParams.get("offset"), 0);
  const ino = parseNonNegative(url.searchParams.get("ino"), 0);
  const wait = Math.min(MAX_WAIT_MS, parseNonNegative(url.searchParams.get("wait"), 0));

  try {
    const filePath = await sessionService.resolvePath(id);
    if (!filePath) return NextResponse.json(unavailable(id));

    const localLive = Boolean(sessionService.getLive(id));
    // 对端真的在跑才算 writer：空闲 writer 的租约不该把「外部改写」判成正常追加。
    const writerActive = sessionService.isLockedByOther(id);
    const previous = hasOffset && ino > 0 ? { offset, ino } : null;
    let probe = probeSessionFile(filePath, previous, { writerActive });

    if (
      wait > 0 &&
      previous !== null &&
      probe.available &&
      !probe.changed &&
      !probe.reset &&
      !probe.externalRewrite
    ) {
      const stamp = readFileStamp(filePath);
      if (stamp) {
        const changed = await waitForSessionFileChange(filePath, stamp, wait, req.signal);
        if (changed) probe = probeSessionFile(filePath, previous, { writerActive });
      }
    }

    return NextResponse.json({ sessionId: id, path: filePath, localLive, writerActive, ...probe });
  } catch (error) {
    // 只读投影失败不把跟随循环打成错误页：返回安全空态，客户端下一轮再探。
    console.warn("[pidance] session tail probe failed:", error);
    return NextResponse.json(unavailable(id));
  }
}
