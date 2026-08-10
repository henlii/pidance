import { NextResponse } from "next/server";
import { installLatestPiGlobal } from "@/lib/pi-runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

/** POST /api/runtime/install-pi — 全局安装最新 @earendil-works/pi-coding-agent */
export async function POST() {
  try {
    const result = await installLatestPiGlobal({ pinRuntimeDir: true });
    const status = result.ok ? 200 : 500;
    return NextResponse.json(result, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        ok: false,
        message,
        version: null,
        path: null,
        source: "none",
        npmRoot: null,
      },
      { status: 500 },
    );
  }
}
