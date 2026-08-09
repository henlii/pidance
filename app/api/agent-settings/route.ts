/**
 * GET  /api/agent-settings?cwd=<optional>
 * PUT  /api/agent-settings  body: AgentSettingsPatch 白名单
 *
 * 自管全局 settings.json（GlobalSettingsStore）；不依赖 SettingsManager。
 * 全局作用域；cwd 仅用于解析 projectTrusted 展示字段。
 */

import { NextRequest, NextResponse } from "next/server";
import { getAgentDir } from "@/lib/pi-paths";
import { homedir } from "node:os";
import {
  applyAgentSettingsPatch,
  parseAgentSettingsPatch,
  projectAgentSettingsView,
  type AgentSettingsView,
} from "@/lib/agent-settings";
import { GlobalSettingsStore } from "@/lib/settings-store";

export type { AgentSettingsPatch, AgentSettingsView } from "@/lib/agent-settings";

export const dynamic = "force-dynamic";

function createManager(cwd: string | null): GlobalSettingsStore {
  const agentDir = getAgentDir();
  const workDir = cwd && cwd.trim() ? cwd : homedir();
  return GlobalSettingsStore.create(workDir, agentDir);
}

export async function GET(req: NextRequest) {
  try {
    const cwdParam = req.nextUrl.searchParams.get("cwd");
    const cwd = cwdParam != null && cwdParam.trim() !== "" ? cwdParam : null;
    const manager = createManager(cwd);
    const body: AgentSettingsView = projectAgentSettingsView(manager);
    return NextResponse.json(body);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const raw = (await req.json()) as unknown;
    // cwd 可放在 body，也可 query；不从 body 读非白名单设置键
    let cwd: string | null = null;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "cwd" in raw) {
      const c = (raw as { cwd?: unknown }).cwd;
      if (typeof c === "string" && c.trim()) cwd = c;
    }
    if (!cwd) {
      const q = req.nextUrl.searchParams.get("cwd");
      if (q != null && q.trim()) cwd = q;
    }

    // 剥离 cwd 后再校验白名单
    let patchBody = raw;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "cwd" in raw) {
      const { cwd: _cwd, ...rest } = raw as Record<string, unknown>;
      void _cwd;
      patchBody = rest;
    }

    const parsed = parseAgentSettingsPatch(patchBody);
    if (!parsed.ok) {
      return NextResponse.json({ error: "校验失败", errors: parsed.errors }, { status: 400 });
    }

    const manager = createManager(cwd);
    const body = await applyAgentSettingsPatch(manager, parsed.patch);
    return NextResponse.json(body);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

