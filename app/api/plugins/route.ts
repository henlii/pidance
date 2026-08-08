import { NextResponse } from "next/server";
import { getAgentDir } from "@/lib/pi-paths";
import { resolveProjectTrustedForSession } from "@/lib/project-trust";
import { setPackageDisabledInSettings } from "@/lib/settings-store";
import { listPluginPackages } from "@/lib/plugin-packages";
import {
  PluginUnsupportedSourceError,
  installPluginPackage,
  removePluginPackage,
  updatePluginPackage,
} from "@/lib/plugin-install";
import type { PluginScope, PluginsResponse } from "@/lib/api-types";

export const dynamic = "force-dynamic";

type PluginAction = "install" | "remove" | "update" | "disable" | "enable";

function readScope(scope: unknown): PluginScope {
  return scope === "project" ? "project" : "global";
}

function setPackageDisabled(
  cwd: string,
  source: string,
  scope: PluginScope,
  disabled: boolean,
): boolean {
  return setPackageDisabledInSettings(source, scope, disabled, {
    agentDir: getAgentDir(),
    cwd,
  });
}

/** 自管插件列表：GET 路径不依赖 @earendil-works/pi-coding-agent */
function readPlugins(cwd: string): PluginsResponse {
  return listPluginPackages({ agentDir: getAgentDir(), cwd });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    return NextResponse.json(readPlugins(cwd));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/plugins body: { action, source?, scope?, cwd }
export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      action?: PluginAction;
      source?: string;
      scope?: PluginScope;
      cwd?: string;
    };
    if (!body.cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!body.action) return NextResponse.json({ error: "action required" }, { status: 400 });

    const source = body.source?.trim();
    const local = readScope(body.scope) === "project";
    // 对齐上游 0.8.2：项目级插件写操作要求目标项目已信任
    if (local && !resolveProjectTrustedForSession(body.cwd)) {
      return NextResponse.json(
        { error: "Project resources must be trusted before modifying project plugins" },
        { status: 403 },
      );
    }

    if (body.action === "install") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      await installPluginPackage(source, readScope(body.scope), {
        agentDir: getAgentDir(),
        cwd: body.cwd,
      });
    } else if (body.action === "remove") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      await removePluginPackage(source, readScope(body.scope), {
        agentDir: getAgentDir(),
        cwd: body.cwd,
      });
    } else if (body.action === "update") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      await updatePluginPackage(source, readScope(body.scope), {
        agentDir: getAgentDir(),
        cwd: body.cwd,
      });
    } else if (body.action === "disable") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      setPackageDisabled(body.cwd, source, readScope(body.scope), true);
    } else if (body.action === "enable") {
      if (!source) return NextResponse.json({ error: "source required" }, { status: 400 });
      setPackageDisabled(body.cwd, source, readScope(body.scope), false);
    } else {
      return NextResponse.json({ error: `Unsupported action: ${body.action}` }, { status: 400 });
    }

    return NextResponse.json(readPlugins(body.cwd));
  } catch (error) {
    if (error instanceof PluginUnsupportedSourceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
