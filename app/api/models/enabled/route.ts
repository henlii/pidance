/**
 * GET  /api/models/enabled — 每模型开关面板的数据：**未过滤**的可用目录 + 当前 enabledModels。
 * POST /api/models/enabled — 开关单个模型（最小编辑 settings.json，只动 enabledModels）。
 *
 * 为什么 GET 不在 /api/models 上加开关位：那里返回的是**已过滤**的列表，被关掉的模型
 * 根本不在里面，界面就没法把它显示成「关」。这里返回完整目录 + `enabled` 标记。
 *
 * 状态语义见 lib/enabled-models-store.ts。错误码：
 * 400 参数非法 / 422 settings.json 读不出（拒写）/ 409 项目级覆盖只读、或不允许关掉最后一个。
 */

import { NextResponse } from "next/server";
import { resolve } from "path";
import { getSettingsPath } from "@/lib/pi-paths";
import { invalidateModelsCache } from "@/lib/models-cache";
import {
  EnabledModelsError,
  projectSettingsPathFor,
  readEnabledModelsState,
  toggleEnabledModel,
} from "@/lib/enabled-models-store";
import { isModelEnabled, loadAvailableModels, modelRefOf } from "@/lib/models-available";

export const dynamic = "force-dynamic";

function errorStatus(code: EnabledModelsError["code"]): number {
  switch (code) {
    case "bad-request":
      return 400;
    case "unreadable":
      return 422;
    case "project-override":
    case "last-model":
      return 409;
    default:
      return 500;
  }
}

function cwdFrom(request: Request): string {
  const requested = new URL(request.url).searchParams.get("cwd");
  return resolve(requested && requested.trim() !== "" ? requested : process.cwd());
}

export async function GET(req: Request) {
  const cwd = cwdFrom(req);
  try {
    const state = readEnabledModelsState({
      projectSettingsPath: projectSettingsPathFor(cwd) ?? undefined,
    });
    const data = await loadAvailableModels();
    return NextResponse.json(
      {
        enabledModels: state.enabledModels,
        projectOverride: state.projectOverride,
        unreadable: state.unreadable,
        models: data.modelList.map((m) => ({
          ref: modelRefOf(m),
          id: m.id,
          name: m.name,
          provider: m.provider,
          enabled: isModelEnabled(m, state.enabledModels),
        })),
      },
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
  const cwd = cwdFrom(req);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { ref, enabled } = (body ?? {}) as { ref?: unknown; enabled?: unknown };
  if (typeof ref !== "string" || ref.trim() === "" || typeof enabled !== "boolean") {
    return NextResponse.json(
      { error: "ref (string) and enabled (boolean) are required" },
      { status: 400 },
    );
  }

  try {
    const data = await loadAvailableModels();
    const result = toggleEnabledModel(
      ref,
      enabled,
      data.modelList.map(modelRefOf),
      {
        settingsPath: getSettingsPath(),
        projectSettingsPath: projectSettingsPathFor(cwd) ?? undefined,
      },
    );
    // 列表口径立刻生效：别让用户切回聊天还看到旧的可选模型集。
    invalidateModelsCache();
    return NextResponse.json({ enabledModels: result.enabledModels });
  } catch (error) {
    if (error instanceof EnabledModelsError) {
      return NextResponse.json({ error: error.message, code: error.code }, {
        status: errorStatus(error.code),
      });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
