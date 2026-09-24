import { NextResponse } from "next/server";
import { join } from "path";
import { getAgentDir } from "@/lib/pi-paths";
import { invalidateModelsCache } from "@/lib/models-cache";
import {
  getSanitizedModelsConfig,
  ModelsConfigError,
  ModelsConfigReadError,
  saveModelsConfig,
  type Baseline,
} from "@/lib/models-config-service";

export const dynamic = "force-dynamic";

function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

function parseBaseline(value: unknown): Baseline | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.mtimeMs === "number" && typeof record.size === "number") {
      return { mtimeMs: record.mtimeMs, size: record.size };
    }
  }
  return null;
}

/** GET：读不出 models.json 时 422（不降级为空配置；面板不得据此覆盖写）。 */
export async function GET() {
  try {
    return NextResponse.json(getSanitizedModelsConfig(getModelsPath()));
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
    }
    const record = body as Record<string, unknown>;
    const baseline = parseBaseline(record.baseline);
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key !== "baseline") data[key] = value;
    }
    const result = saveModelsConfig(getModelsPath(), data, baseline);
    invalidateModelsCache();
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ModelsConfigReadError) {
      // 409：服务器上的文件读不出，写回会丢掉它的内容
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ModelsConfigError) {
      const status = error.code === "conflict" ? 409 : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
