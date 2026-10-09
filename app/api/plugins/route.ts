import { NextResponse } from "next/server";
import { getAgentDir } from "@/lib/pi-paths";
import { setPackageDisabledInSettings } from "@/lib/settings-store";
import { extensionDiagnostics, listPluginPackages } from "@/lib/plugin-packages";
import { loadExtensionsForCwd } from "@/lib/loaded-extensions";
import {
  PluginUnsupportedSourceError,
  installPluginPackage,
  removePluginPackage,
  updatePluginPackage,
} from "@/lib/plugin-install";
import type { PluginScope, PluginsResponse } from "@/lib/api-types";
import { invalidateExtensionProvidersCache } from "@/lib/extension-providers";
import { invalidateMarkdownTransformCache } from "@/lib/extension-markdown-transformers";
import { invalidateModelsCache } from "@/lib/models-cache";

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
async function readPlugins(cwd: string): Promise<PluginsResponse> {
  const result = listPluginPackages({ agentDir: getAgentDir(), cwd });
  // 扩展加载的告警/错误也要出现在插件页（以前只进日志，用户看不到）。
  // 加载器自带 30s 缓存，正常路径不会拖慢这个页面。
  try {
    const loaded = await loadExtensionsForCwd({ cwd, agentDir: getAgentDir() });
    if (!loaded.ok) {
      result.diagnostics.push({ type: "error", message: loaded.error, source: "extensions" });
    } else {
      result.diagnostics.push(...extensionDiagnostics(loaded.value));
    }
  } catch (error) {
    result.diagnostics.push({ type: "warning", message: String(error), source: "extensions" });
  }
  return result;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const cwd = searchParams.get("cwd");
  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

  try {
    return NextResponse.json(await readPlugins(cwd));
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

    // 插件的增删改启停都会影响「扩展注册的 provider」与模型目录：
    // 不失效就会继续拿旧清单（用户刚装完看不到新 provider）。
    invalidateExtensionProvidersCache();
    invalidateMarkdownTransformCache();
    invalidateModelsCache();

    return NextResponse.json(await readPlugins(body.cwd));
  } catch (error) {
    if (error instanceof PluginUnsupportedSourceError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
