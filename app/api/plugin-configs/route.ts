/**
 * 插件配置文件通用发现与编辑。
 * 扫描插件根目录（~/.pi/agent/extensions/*、~/.pi/agent/npm/node_modules/*）下的
 * config.json；编辑走 JSON 校验 + 原子写。不针对任何插件特化。
 */
import { NextResponse } from "next/server";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "@/lib/pi-paths";

export const dynamic = "force-dynamic";

const MAX_CONFIG_BYTES = 512 * 1024;

export type PluginConfigEntry = {
  /** 插件标识（目录名） */
  plugin: string;
  /** config.json 绝对路径 */
  path: string;
  content: string;
};

function scanDir(root: string, out: PluginConfigEntry[]): void {
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const configPath = join(dir, "config.json");
    if (!existsSync(configPath)) continue;
    try {
      const content = readFileSync(configPath, "utf8");
      out.push({ plugin: name, path: configPath, content });
    } catch {
      /* 跳过不可读 */
    }
  }
}

/** 扫描全局插件根（extensions/ 与 npm/node_modules 顶层插件）。 */
export function scanPluginConfigs(agentDir: string): PluginConfigEntry[] {
  const out: PluginConfigEntry[] = [];
  scanDir(join(agentDir, "extensions"), out);
  scanDir(join(agentDir, "npm", "node_modules"), out);
  return out;
}

export async function GET() {
  try {
    const entries = scanPluginConfigs(getAgentDir());
    return NextResponse.json(
      { entries: entries.map((e) => ({ plugin: e.plugin, path: e.path, content: e.content })) },
      { headers: { "Cache-Control": "no-store" } },
    );
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
      path?: unknown;
      content?: unknown;
    };
    if (typeof body.path !== "string" || !body.path) {
      return NextResponse.json({ error: "path is required" }, { status: 400 });
    }
    if (typeof body.content !== "string") {
      return NextResponse.json({ error: "content must be a string" }, { status: 400 });
    }
    if (Buffer.byteLength(body.content, "utf8") > MAX_CONFIG_BYTES) {
      return NextResponse.json({ error: "content too large" }, { status: 413 });
    }
    // JSON 校验
    try {
      JSON.parse(body.content);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: `Invalid JSON: ${message}` }, { status: 400 });
    }

    // 路径白名单：必须是扫描出的 config.json
    const agentDir = getAgentDir();
    const allowed = new Set(scanPluginConfigs(agentDir).map((e) => resolve(e.path)));
    const target = resolve(body.path);
    if (!allowed.has(target)) {
      return NextResponse.json({ error: "path is not a known plugin config.json" }, { status: 403 });
    }

    const dir = dirname(target);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temp, body.content, { flag: "wx", mode: 0o600 });
      renameSync(temp, target);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        /* ignore */
      }
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
