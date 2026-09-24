/**
 * 「刷新模型目录」：走 SDK `ModelRuntime.refresh()`（**带网络**）。
 *
 * 为什么要单独一条：服务商上新模型后，内置目录要等依赖更新才变；pi 命令行能刷，
 * Web 里没有等价入口。
 *
 * 失败语义（issue #88）：
 * - 网络/上游失败 → 抛出带原因的 `ModelCatalogRefreshError`，路由转成 502 并给出
 *   明确文案；**不得**改动磁盘上的任何文件（刷新只更新进程内目录与 SDK 缓存），
 *   更不允许把已有模型列表清空来「表示失败」。
 * - runtime 工厂可注入，便于单测不触网、不依赖真实凭据。
 */

import { invalidateModelsCache } from "./models-cache";

export type ModelCatalogRefreshErrorCode = "unavailable" | "network" | "unknown";

export class ModelCatalogRefreshError extends Error {
  readonly code: ModelCatalogRefreshErrorCode;

  constructor(code: ModelCatalogRefreshErrorCode, message: string) {
    super(message);
    this.name = "ModelCatalogRefreshError";
    this.code = code;
  }
}

interface RefreshCapableRuntime {
  refresh?: (options?: { signal?: AbortSignal }) => Promise<unknown>;
}

export interface ModelCatalogRefreshOptions {
  /** 注入 runtime（默认动态 import SDK 并 `ModelRuntime.create`）。 */
  runtimeFactory?: () => Promise<RefreshCapableRuntime>;
  signal?: AbortSignal;
}

/** SDK 缺失时的兜底工厂：与既有的 OAuth 登录路径同一条「可选依赖」策略。 */
async function defaultRuntimeFactory(): Promise<RefreshCapableRuntime> {
  try {
    const mod = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      ModelRuntime?: { create: (options?: unknown) => Promise<RefreshCapableRuntime> };
    };
    if (!mod.ModelRuntime) {
      throw new ModelCatalogRefreshError(
        "unavailable",
        "ModelRuntime is not available in @earendil-works/pi-coding-agent",
      );
    }
    return await mod.ModelRuntime.create({ allowModelNetwork: true });
  } catch (error) {
    if (error instanceof ModelCatalogRefreshError) throw error;
    throw new ModelCatalogRefreshError(
      "unavailable",
      "refreshing the model catalog requires @earendil-works/pi-coding-agent",
    );
  }
}

/** 把 SDK 的返回结果压成 JSON 安全的小对象（字段名不作为契约）。 */
function summarize(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const json = JSON.parse(JSON.stringify(value)) as unknown;
    return typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 刷新模型目录并让进程内缓存失效（下次 `GET /api/models` 重新读目录）。
 * 成功返回 SDK 结果的紧凑摘要；失败抛 `ModelCatalogRefreshError`。
 */
export async function refreshModelCatalog(
  options: ModelCatalogRefreshOptions = {},
): Promise<{ detail: Record<string, unknown> | null }> {
  const runtime = await (options.runtimeFactory ?? defaultRuntimeFactory)();
  if (typeof runtime.refresh !== "function") {
    throw new ModelCatalogRefreshError(
      "unavailable",
      "this ModelRuntime build does not support refresh()",
    );
  }

  let result: unknown;
  try {
    result = await runtime.refresh(options.signal ? { signal: options.signal } : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelCatalogRefreshError("network", message);
  }

  // 只有真正成功才动缓存：失败路径不得让列表看起来「变了」。
  invalidateModelsCache();
  return { detail: summarize(result) };
}
