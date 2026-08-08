import { NextResponse } from "next/server";
import { switchRuntimeSlot } from "@/lib/pi-runtime/runtime-switch";
import { buildRuntimeInfo } from "@/lib/pi-runtime/runtime-info";

export const dynamic = "force-dynamic";

/**
 * POST /api/runtime/switch { version: "0.84.1" }
 * 显式切换 ~/.pidance/runtimes/pi/current → 指定 slot。
 * 不下载、不自动升级；31415 默认 forbidden。
 * 切换后需重启 Pidance 进程才会让新 live session 使用新 binary。
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const version =
    body && typeof body === "object" && typeof (body as { version?: unknown }).version === "string"
      ? (body as { version: string }).version.trim()
      : "";
  if (!version) {
    return NextResponse.json({ error: "version is required" }, { status: 400 });
  }

  const result = switchRuntimeSlot(version, process.env);
  if (!result.ok) {
    const status =
      result.code === "forbidden"
        ? 403
        : result.code === "not_found" || result.code === "invalid_version"
          ? 404
          : 500;
    return NextResponse.json(
      { success: false, error: result.error, code: result.code },
      { status },
    );
  }

  // 返回切换结果 + 最新 runtime 探测（path 可能仍为旧进程 PATH，直至重启）
  const info = buildRuntimeInfo(process.env, process.cwd());
  return NextResponse.json({
    success: true,
    switched: result,
    runtime: info.runtime,
    upgrade: info.upgrade,
    note: "current 已切换；已有 live 会话仍用旧进程，需重启 Pidance 后新会话生效",
  });
}
