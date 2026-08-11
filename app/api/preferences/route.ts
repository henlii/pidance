import { NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@/lib/pi-paths";

export const dynamic = "force-dynamic";

const MAX_PREFS_BYTES = 1_000_000;
const PREFS_FILENAME = "pidance-preferences.json";

type Prefs = Record<string, unknown>;

function prefsPath(): string {
  return join(getAgentDir(), PREFS_FILENAME);
}

function isPlainObject(value: unknown): value is Prefs {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPrefs(): Prefs {
  const path = prefsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 顶层键合并；双方均为对象时再深合并一层（drafts/fileTree 等嵌套键不互相覆盖）。 */
function mergePrefs(base: Prefs, patch: Prefs): Prefs {
  const out: Prefs = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = { ...(out[key] as Prefs), ...(value as Prefs) };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function writePrefs(prefs: Prefs): void {
  const path = prefsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(prefs, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* ignore */
    }
    throw error;
  }
}

/**
 * GET /api/preferences — 服务端持久化偏好（跨客户端同步）。
 */
export async function GET() {
  try {
    return NextResponse.json({ prefs: readPrefs() }, { headers: { "Cache-Control": "no-store" } });
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
    if (!isPlainObject(body.prefs)) {
      return NextResponse.json({ error: "prefs must be a JSON object" }, { status: 400 });
    }
    const serialized = JSON.stringify(body.prefs);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PREFS_BYTES) {
      return NextResponse.json(
        { error: `preferences exceed ${MAX_PREFS_BYTES} bytes` },
        { status: 413 },
      );
    }
    const current = readPrefs();
    writePrefs(mergePrefs(current, body.prefs as Prefs));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
