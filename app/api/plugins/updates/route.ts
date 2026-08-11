import { NextResponse } from "next/server";
import { checkPluginUpdates } from "@/lib/plugin-updates";

export const dynamic = "force-dynamic";

/**
 * POST /api/plugins/updates
 * body: { packages: [{ source, installed }] }
 * 返回每个 npm 源插件的最新版本与是否有更新（批量、并发受限）。
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      packages?: Array<{ source?: unknown; installed?: unknown }>;
    };
    if (!Array.isArray(body.packages) || body.packages.length > 200) {
      return NextResponse.json(
        { error: "packages must be an array (max 200)" },
        { status: 400 },
      );
    }
    const sources = body.packages
      .filter((p) => typeof p?.source === "string" && p.source)
      .map((p) => ({
        source: (p.source as string).trim(),
        installed: typeof p.installed === "string" && p.installed ? p.installed : null,
      }));
    const updates = await checkPluginUpdates(sources);
    return NextResponse.json({ updates });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
