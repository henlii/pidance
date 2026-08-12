import { NextResponse } from "next/server";
import { loadSkillsWithInstallInfo } from "@/lib/skills-service";
import { removeSkill, SkillWriteError, toggleSkillDisableModelInvocation } from "@/lib/skills-write";

export const dynamic = "force-dynamic";

// GET /api/skills?cwd=<path>
// 自管磁盘发现（lib/skill-discovery.ts）：agentDir/skills、~/.agents/skills、
// 项目 .pi/skills 与 .agents/skills（需项目信任）、settings.json skills 路径。
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    return NextResponse.json(await loadSkillsWithInstallInfo(cwd));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// PATCH /api/skills — toggle disable-model-invocation on a loader-authorized SKILL.md
export async function PATCH(req: Request) {
  try {
    const body = await req.json() as {
      cwd?: string;
      filePath?: string;
      disableModelInvocation?: boolean;
    };
    return NextResponse.json(await toggleSkillDisableModelInvocation({
      cwd: body.cwd ?? "",
      filePath: body.filePath ?? "",
      disableModelInvocation: body.disableModelInvocation ?? false,
    }));
  } catch (e) {
    if (e instanceof SkillWriteError) {
      const status = e.code === "forbidden" ? 403 : e.code === "not-found" ? 404 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// DELETE /api/skills — 删除技能目录（全局/已信任项目技能根内）
export async function DELETE(req: Request) {
  try {
    const body = await req.json() as { cwd?: string; filePath?: string };
    return NextResponse.json(await removeSkill({
      cwd: body.cwd ?? "",
      filePath: body.filePath ?? "",
    }));
  } catch (e) {
    if (e instanceof SkillWriteError) {
      const status = e.code === "forbidden" ? 403 : e.code === "not-found" ? 404 : 400;
      return NextResponse.json({ error: e.message }, { status });
    }
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
