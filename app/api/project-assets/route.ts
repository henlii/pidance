/**
 * 项目资产：项目级规则（AGENTS.md）与项目技能（.agents/skills/）管理。
 * 路径严格限制在项目目录内（realpath + 前缀校验）。
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
import { dirname, join, relative, resolve } from "node:path";
import { getAllowedFileRoots, isFilePathAllowed } from "@/lib/file-access";

export const dynamic = "force-dynamic";

const MAX_RULES_BYTES = 512 * 1024;
const MAX_SKILL_BYTES = 256 * 1024;
const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function projectAssetsDir(cwd: string): string {
  return join(resolve(cwd), ".agents", "skills");
}

function isInside(cwd: string, target: string): boolean {
  const root = resolve(cwd);
  const rel = relative(root, resolve(target));
  return rel !== "" && !rel.startsWith("..") && !resolve(target).startsWith(`${root}${require("node:path").sep}`);
}

async function guardCwd(cwd: string): Promise<string | null> {
  if (typeof cwd !== "string" || !cwd) return "cwd is required";
  const roots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, roots)) return "cwd is not in allowed roots";
  return null;
}

function readTextSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function skillEnabled(content: string): boolean {
  return !/^\s*disable-model-invocation:\s*true\s*$/m.test(content);
}

function listSkills(cwd: string): Array<{ name: string; enabled: boolean; content: string }> {
  const dir = projectAssetsDir(cwd);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ name: string; enabled: boolean; content: string }> = [];
  for (const name of names) {
    const skillDir = join(dir, name);
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const md = join(skillDir, "SKILL.md");
    if (!existsSync(md)) continue;
    const content = readTextSafe(md);
    out.push({ name, enabled: skillEnabled(content), content });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function GET(req: Request) {
  try {
    const cwd = new URL(req.url).searchParams.get("cwd") ?? "";
    const guard = await guardCwd(cwd);
    if (guard) return NextResponse.json({ error: guard }, { status: 403 });

    const rulesPath = join(resolve(cwd), "AGENTS.md");
    const rulesContent = existsSync(rulesPath) ? readTextSafe(rulesPath) : "";
    const skills = listSkills(cwd);
    return NextResponse.json(
      { rulesPath, rulesExists: existsSync(rulesPath), rulesContent, skills },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    const guard = await guardCwd(cwd);
    if (guard) return NextResponse.json({ error: guard }, { status: 403 });

    const kind = body.kind;
    if (kind === "rules") {
      const content = body.content;
      if (typeof content !== "string") {
        return NextResponse.json({ error: "content must be a string" }, { status: 400 });
      }
      if (Buffer.byteLength(content, "utf8") > MAX_RULES_BYTES) {
        return NextResponse.json({ error: "content too large" }, { status: 413 });
      }
      const path = join(resolve(cwd), "AGENTS.md");
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
      try {
        writeFileSync(temp, content, { flag: "wx", mode: 0o644 });
        renameSync(temp, path);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {
          /* ignore */
        }
        throw error;
      }
      return NextResponse.json({ ok: true });
    }

    if (kind === "skill") {
      const action = body.action;
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || !SKILL_NAME_RE.test(name)) {
        return NextResponse.json({ error: "invalid skill name" }, { status: 400 });
      }
      const skillDir = join(projectAssetsDir(cwd), name);
      const mdPath = join(skillDir, "SKILL.md");
      if (!isInside(cwd, mdPath)) {
        return NextResponse.json({ error: "skill path escapes project" }, { status: 403 });
      }

      if (action === "create") {
        if (existsSync(mdPath)) {
          return NextResponse.json({ error: "skill already exists" }, { status: 409 });
        }
        mkdirSync(skillDir, { recursive: true });
        const template = `---\nname: ${name}\ndescription: ${name} skill\n---\n\n# ${name}\n\n（编辑此技能内容）\n`;
        writeFileSync(mdPath, template, { flag: "wx", mode: 0o644 });
        return NextResponse.json({ ok: true });
      }

      if (action === "update") {
        const content = body.content;
        if (typeof content !== "string") {
          return NextResponse.json({ error: "content must be a string" }, { status: 400 });
        }
        if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
          return NextResponse.json({ error: "content too large" }, { status: 413 });
        }
        if (!existsSync(mdPath)) {
          return NextResponse.json({ error: "skill not found" }, { status: 404 });
        }
        mkdirSync(skillDir, { recursive: true });
        const temp = `${mdPath}.${process.pid}.${Date.now()}.tmp`;
        try {
          writeFileSync(temp, content, { flag: "wx", mode: 0o644 });
          renameSync(temp, mdPath);
        } catch (error) {
          try {
            unlinkSync(temp);
          } catch {
            /* ignore */
          }
          throw error;
        }
        return NextResponse.json({ ok: true });
      }

      if (action === "toggle") {
        if (!existsSync(mdPath)) {
          return NextResponse.json({ error: "skill not found" }, { status: 404 });
        }
        const enabled = body.enabled !== false;
        let content = readTextSafe(mdPath);
        if (enabled) {
          content = content.replace(/^\s*disable-model-invocation:\s*true\s*$/m, "");
        } else if (!/disable-model-invocation/.test(content)) {
          // 在 frontmatter 中插入 disable-model-invocation: true
          if (content.startsWith("---")) {
            const end = content.indexOf("\n---", 3);
            if (end >= 0) {
              content = content.slice(0, end) + "\ndisable-model-invocation: true" + content.slice(end);
            }
          } else {
            content = `---\ndisable-model-invocation: true\n---\n\n${content}`;
          }
        }
        const temp = `${mdPath}.${process.pid}.${Date.now()}.tmp`;
        try {
          writeFileSync(temp, content, { flag: "wx", mode: 0o644 });
          renameSync(temp, mdPath);
        } catch (error) {
          try {
            unlinkSync(temp);
          } catch {
            /* ignore */
          }
          throw error;
        }
        return NextResponse.json({ ok: true });
      }

      if (action === "delete") {
        if (!existsSync(mdPath)) {
          return NextResponse.json({ error: "skill not found" }, { status: 404 });
        }
        unlinkSync(mdPath);
        // 尝试删除空目录（失败静默）
        try {
          readdirSync(skillDir);
          rmdirIfEmpty(skillDir);
        } catch {
          /* ignore */
        }
        return NextResponse.json({ ok: true });
      }

      return NextResponse.json({ error: "unknown skill action" }, { status: 400 });
    }

    return NextResponse.json({ error: "kind must be rules | skill" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

function rmdirIfEmpty(dir: string): void {
  const { rmdirSync } = require("node:fs") as typeof import("node:fs");
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    /* ignore */
  }
}
