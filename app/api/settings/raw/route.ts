import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { getSettingsPath } from "@/lib/pi-paths";
import {
  loadSettingsFile,
  saveSettingsFile,
  type SettingsObject,
} from "@/lib/settings-store";

export const dynamic = "force-dynamic";

const MAX_SETTINGS_BYTES = 1_000_000;

function isPlainObject(value: unknown): value is SettingsObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GET /api/settings/raw — 全局 settings.json 原文（含 SDK 未知键，JSON 模式编辑用）。
 */
export async function GET() {
  try {
    const path = getSettingsPath();
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = "{}\n";
    }
    return NextResponse.json({ json: text }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/settings/raw — 校验并原子写回全局 settings.json。
 * body: { json: string }。必须是合法 JSON 对象且体积有界。
 */
export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { json?: unknown };
    if (typeof body.json !== "string") {
      return NextResponse.json({ error: "json must be a string" }, { status: 400 });
    }
    if (Buffer.byteLength(body.json, "utf8") > MAX_SETTINGS_BYTES) {
      return NextResponse.json(
        { error: `settings.json exceeds ${MAX_SETTINGS_BYTES} bytes` },
        { status: 413 },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.json);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Invalid JSON: ${message}` }, { status: 400 });
    }
    if (!isPlainObject(parsed)) {
      return NextResponse.json(
        { error: "settings.json must be a JSON object" },
        { status: 400 },
      );
    }
    saveSettingsFile(getSettingsPath(), parsed);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
