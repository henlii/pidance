import { NextResponse } from "next/server";
import {
  readRuntimeConfig,
  validateRuntimeDir,
  writeRuntimeConfig,
} from "@/lib/pidance-runtime-config";
import { configureRuntimeEnv, resolveRuntimeBinary } from "@/lib/pi-runtime";

export const dynamic = "force-dynamic";

/** GET /api/runtime/config — 运行时目录配置 + 当前解析结果 */
export async function GET() {
  const config = readRuntimeConfig();
  const resolved = resolveRuntimeBinary(process.env);
  return NextResponse.json(
    {
      runtimeDir: config.runtimeDir,
      resolved: {
        path: resolved.path,
        version: resolved.version,
        source: resolved.source,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** PUT /api/runtime/config — 更新运行时目录（空 = PATH） */
export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as { runtimeDir?: unknown };
    const raw = typeof body.runtimeDir === "string" ? body.runtimeDir : "";
    const validated = validateRuntimeDir(raw);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.message }, { status: 400 });
    }
    const config = writeRuntimeConfig({
      version: 1,
      runtimeDir: validated.runtimeDir,
    });
    // 立即刷新本进程解析（无需整服务重启即可对后续 ensureLive 生效）
    const resolved = configureRuntimeEnv(process.env);
    return NextResponse.json(
      {
        runtimeDir: config.runtimeDir,
        resolved: {
          path: resolved.path,
          version: resolved.version,
          source: resolved.source,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
