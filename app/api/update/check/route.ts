import { NextResponse } from "next/server";
import { checkPidanceUpdate } from "@/lib/pidance-update";

export const dynamic = "force-dynamic";

/** GET /api/update/check — 查 npm 最新版与本机是否可一键升级（只读）。 */
export async function GET() {
  try {
    const result = await checkPidanceUpdate();
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
