import { NextResponse } from "next/server";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@/lib/pi-paths";

export const dynamic = "force-dynamic";

/** 文令文件名（Pi 约定）：覆盖 SYSTEM.md、追加 APPEND_SYSTEM.md、全局规则 AGENTS.md。 */
export const PROMPT_FILES = {
  system: "SYSTEM.md",
  systemAppend: "APPEND_SYSTEM.md",
  agents: "AGENTS.md",
} as const;

export type PromptKey = keyof typeof PROMPT_FILES;

const DRAFTS_FILENAME = "pidance-prompt-drafts.json";
const MAX_PROMPT_BYTES = 512 * 1024;

type Drafts = Partial<Record<PromptKey, string>>;

function draftsPath(): string {
  return join(getAgentDir(), DRAFTS_FILENAME);
}

function readDrafts(): Drafts {
  const path = draftsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Drafts;
    }
  } catch {
    /* 损坏 → 空 */
  }
  return {};
}

function writeDrafts(drafts: Drafts): void {
  const path = draftsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(drafts, null, 2), { flag: "wx", mode: 0o600 });
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

function isPromptKey(value: unknown): value is PromptKey {
  return (
    typeof value === "string" &&
    (value === "system" || value === "systemAppend" || value === "agents")
  );
}

/** 禁用时也持久化的草稿：始终保存；启用时写入 md 文件。 */
export async function GET() {
  try {
    const agentDir = getAgentDir();
    const drafts = readDrafts();
    const entries = (Object.keys(PROMPT_FILES) as PromptKey[]).map((key) => {
      const file = join(agentDir, PROMPT_FILES[key]);
      const enabled = existsSync(file);
      const content = enabled
        ? (() => {
            try {
              return readFileSync(file, "utf8");
            } catch {
              return drafts[key] ?? "";
            }
          })()
        : (drafts[key] ?? "");
      return { key, enabled, content };
    });
    return NextResponse.json({ entries }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      key?: unknown;
      enabled?: unknown;
      content?: unknown;
    };
    if (!isPromptKey(body.key)) {
      return NextResponse.json({ error: "key must be system | systemAppend | agents" }, { status: 400 });
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    if (body.content !== undefined && typeof body.content !== "string") {
      return NextResponse.json({ error: "content must be a string" }, { status: 400 });
    }
    if (body.content && Buffer.byteLength(body.content, "utf8") > MAX_PROMPT_BYTES) {
      return NextResponse.json({ error: `content exceeds ${MAX_PROMPT_BYTES} bytes` }, { status: 413 });
    }

    const key = body.key;
    const agentDir = getAgentDir();
    const file = join(agentDir, PROMPT_FILES[key]);
    const drafts = readDrafts();
    const enabled = body.enabled ?? existsSync(file);

    // 内容始终持久化到草稿（禁用状态也可编辑保存）
    if (body.content !== undefined) {
      if (body.content) drafts[key] = body.content;
      else delete drafts[key];
    }
    writeDrafts(drafts);

    if (enabled) {
      // 启用：确保文件存在；用草稿内容（或保留现有文件内容）
      const content = body.content ?? drafts[key];
      if (content !== undefined && content !== null) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content, "utf8");
      } else if (!existsSync(file)) {
        writeFileSync(file, "", "utf8");
      }
    } else {
      // 禁用：删除文件（草稿已保留）
      if (existsSync(file)) unlinkSync(file);
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
