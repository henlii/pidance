import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@/lib/pi-paths";
import { invalidateModelsCache } from "@/lib/models-cache";
import {
  ModelsConfigError,
  saveModelsConfig,
} from "@/lib/models-config-service";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2_000_000;

function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GET /api/models-config/raw — models.json 原文（含密钥，仅本机设置页 JSON 模式） */
export async function GET() {
  try {
    const path = getModelsPath();
    let text: string;
    if (!existsSync(path)) text = "{\n  \"providers\": {}\n}\n";
    else text = readFileSync(path, "utf8");
    return NextResponse.json({ json: text }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** PUT /api/models-config/raw — 校验为对象后写回（走 saveModelsConfig 归一化） */
export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { json?: unknown };
    if (typeof body.json !== "string") {
      return NextResponse.json({ error: "json must be a string" }, { status: 400 });
    }
    if (Buffer.byteLength(body.json, "utf8") > MAX_BYTES) {
      return NextResponse.json({ error: `models.json exceeds ${MAX_BYTES} bytes` }, { status: 413 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.json);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Invalid JSON: ${message}` }, { status: 400 });
    }
    if (!isPlainObject(parsed)) {
      return NextResponse.json({ error: "models.json must be a JSON object" }, { status: 400 });
    }
    // 原始 JSON 模式不做 baseline 冲突检测（整文件覆盖意图）；传 null 表示强制写
    const result = saveModelsConfig(getModelsPath(), parsed, null);
    invalidateModelsCache();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ModelsConfigError) {
      const status = error.code === "conflict" ? 409 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
