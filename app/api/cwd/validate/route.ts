import { NextResponse } from "next/server";
import { statSync, type Stats } from "fs";
import { expandHome } from "@/lib/cwd-browse";
import { allowFileRoot } from "@/lib/file-access";

/**
 * 校验失败的机器可读原因。UI 只在 NOT_FOUND 上提供「创建目录」，
 * 不靠匹配错误文案判断。
 */
type ValidateFailureCode =
  | "PATH_REQUIRED"
  | "INVALID_PATH"
  | "NOT_FOUND"
  | "NOT_A_DIRECTORY"
  | "PERMISSION_DENIED"
  | "INTERNAL";

function fail(code: ValidateFailureCode, error: string, status: number, cwd?: string) {
  return NextResponse.json(cwd === undefined ? { code, error } : { code, error, cwd }, { status });
}

// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
// 路径语义与 /api/cwd/create 共用（expandHome）：只接受绝对路径与 ~ 前缀；
// 相对路径不再按服务进程 cwd 解析，避免选中/创建出意外目录。
export async function POST(req: Request) {
  try {
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return fail("PATH_REQUIRED", "Path is required", 400);
    }

    const normalizedCwd = expandHome(cwd);
    if (!normalizedCwd) {
      return fail("INVALID_PATH", `Path must be absolute or start with ~: ${cwd}`, 400);
    }

    let stat: Stats;
    try {
      stat = statSync(normalizedCwd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // 带上规范化候选：UI 用它弹「是否创建该目录」并据此发 create 请求。
        return fail("NOT_FOUND", `Directory does not exist: ${cwd}`, 400, normalizedCwd);
      }
      if (code === "ENOTDIR") {
        return fail("NOT_A_DIRECTORY", `Path is not a directory: ${cwd}`, 400);
      }
      if (code === "EACCES" || code === "EPERM") {
        return fail("PERMISSION_DENIED", `Permission denied: ${cwd}`, 400);
      }
      return fail("INTERNAL", String(error), 500);
    }

    if (!stat.isDirectory()) {
      return fail("NOT_A_DIRECTORY", `Path is not a directory: ${cwd}`, 400);
    }

    allowFileRoot(normalizedCwd);
    return NextResponse.json({ success: true, cwd: normalizedCwd });
  } catch (error) {
    return fail("INTERNAL", String(error), 500);
  }
}
