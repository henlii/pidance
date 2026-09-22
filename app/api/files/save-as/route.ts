import { NextResponse } from "next/server";
import { expandHome } from "@/lib/cwd-browse";
import { FileOpsError, saveFileAs } from "@/lib/file-ops";

export const dynamic = "force-dynamic";

/**
 * POST /api/files/save-as  { path, targetDirectory }
 *
 * 「另存为」：把源文件复制一份到用户选定的目录，**原文件保留**（不是移动）。
 * 同名不覆盖，自动加 ` (n)` 后缀（见 lib/file-ops.ts 的 saveFileAs）。
 *
 * 与 `POST /api/files/<path>?type=copy` 的关系：那条走的是文件树内部复制（同名报冲突、
 * 目标在受管目录里）；这条是给「另存为」用的 —— 目标是用户在目录选择器里随便挑的目录，
 * 语义是「多存一份」。
 */
export async function POST(request: Request) {
  let body: { path?: unknown; targetDirectory?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    // 落到下面的 400
  }
  const source = typeof body?.path === "string" ? body.path.trim() : "";
  const targetRaw = typeof body?.targetDirectory === "string" ? body.targetDirectory.trim() : "";
  if (!source || !targetRaw) {
    return NextResponse.json({ error: "path and targetDirectory are required" }, { status: 400 });
  }
  // 目录选择器给的是人可读路径（可能带 ~）：与浏览接口同一口径展开。
  const target = expandHome(targetRaw);
  if (!target) {
    return NextResponse.json({ error: "Invalid target directory" }, { status: 400 });
  }

  try {
    const result = saveFileAs(source, target);
    return NextResponse.json({ path: result.path, name: result.name });
  } catch (error) {
    if (error instanceof FileOpsError) {
      const status = error.code === "forbidden"
        ? 403
        : error.code === "not-found"
          ? 404
          : error.code === "conflict"
            ? 409
            : 400;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
}
