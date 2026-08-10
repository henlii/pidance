import { NextResponse } from "next/server";
import { applyPidanceUpdate } from "@/lib/pidance-update";

export const dynamic = "force-dynamic";
/** npm install 可能较久 */
export const maxDuration = 600;

/** POST /api/update/apply — 正式安装位一键升级（需认证；工作区拒绝）。 */
export async function POST(req: Request) {
  try {
    let targetVersion: string | undefined;
    try {
      const body = (await req.json()) as { version?: unknown };
      if (typeof body.version === "string" && body.version.trim()) {
        targetVersion = body.version.trim();
      }
    } catch {
      // 空 body 允许：升级到 latest
    }
    const result = await applyPidanceUpdate({ targetVersion });
    const status =
      result.status === "not_supported" ? 403
        : result.status === "error" ? 500
          : 200;
    return NextResponse.json(result, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
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
