import { NextResponse } from "next/server";
import { mkdirSync, statSync, type Stats } from "fs";
import { expandHome } from "@/lib/cwd-browse";
import { allowFileRoot } from "@/lib/file-access";

function statOrNull(target: string): Stats | null {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

function fail(code: string, error: string, status: number) {
  return NextResponse.json({ code, error }, { status });
}

// POST /api/cwd/create  body: { cwd: string }
// 添加项目弹窗在用户确认「路径不存在，是否创建」后调用：递归创建目录并返回规范化路径。
// 路径语义与 /api/cwd/validate 共用（expandHome）；已存在且是目录时幂等返回成功。
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return fail("PATH_REQUIRED", "Path is required", 400);
    }

    const target = expandHome(cwd);
    if (!target) {
      return fail("INVALID_PATH", `Path must be absolute or start with ~: ${cwd}`, 400);
    }

    const existing = statOrNull(target);
    if (existing && !existing.isDirectory()) {
      return fail("NOT_A_DIRECTORY", `Path is not a directory: ${cwd}`, 400);
    }

    if (!existing) {
      try {
        mkdirSync(target, { recursive: true });
      } catch (error) {
        return fail("CREATE_FAILED", String(error), 400);
      }
    }

    // 创建后复验：mkdir 返回不代表现在拿到的是目录（并发删除/同名文件）。
    const created = statOrNull(target);
    if (!created?.isDirectory()) {
      return fail("NOT_A_DIRECTORY", `Path is not a directory: ${cwd}`, 400);
    }

    allowFileRoot(target);
    return NextResponse.json({ success: true, cwd: target });
  } catch (error) {
    return fail("INTERNAL", String(error), 500);
  }
}
