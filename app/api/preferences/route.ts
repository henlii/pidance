import { NextResponse } from "next/server";
import {
  mergePidancePrefs,
  readPidancePrefs,
  writePidancePrefs,
} from "@/lib/pidance-prefs-file";

export const dynamic = "force-dynamic";

const MAX_PREFS_BYTES = 1_000_000;

/**
 * GET /api/preferences — 服务端持久化偏好（跨客户端同步）。
 */
export async function GET() {
  try {
    return NextResponse.json({ prefs: readPidancePrefs() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/preferences — 顶层合并写入（不整体覆盖；后写者胜出）。
 * body: { prefs: object }
 */
export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { prefs?: unknown };
    const prefs = body.prefs;
    if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) {
      return NextResponse.json({ error: "prefs must be a JSON object" }, { status: 400 });
    }
    const serialized = JSON.stringify(prefs);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PREFS_BYTES) {
      return NextResponse.json(
        { error: `preferences exceed ${MAX_PREFS_BYTES} bytes` },
        { status: 413 },
      );
    }
    const current = readPidancePrefs();
    writePidancePrefs(mergePidancePrefs(current, prefs as Record<string, unknown>));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
