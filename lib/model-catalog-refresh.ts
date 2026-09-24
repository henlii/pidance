/**
 * 「刷新模型目录」：走 SDK `ModelRuntime.refresh()`（**带网络**）。
 *
 * 为什么要单独一条：服务商上新模型后，内置目录要等依赖更新才变；pi 命令行能刷，
 * Web 里没有等价入口。
 *
 * 失败语义（issue #88）：
 * - SDK 的 `refresh()` **不抛错**：provider 网络失败只记进返回值的 `errors` Map，
 *   请求被中止则 `aborted` 为真（见 pi-ai `ModelsRefreshResult`）。只捕 throw 会把
 *   失败当成功 —— 界面显示「已刷新」而什么都没发生。这里显式判定两者。
 * - 必须 `refreshOnCreate: false` + `force: true`：`ModelRuntime.create` 自己会先刷一次，
 *   而 provider 侧对 4 小时内已检查过的目录会直接跳过；不 `force` 就永远不重新请求。
 * - 失败**不得**让已有列表看起来变了：不失效缓存、不碰任何磁盘文件。
 *   （成功的刷写由 SDK 落到 models-store.json，目录读取侧按 mtime 自动生效。）
 * - runtime 工厂与缓存失效都可注入，便于单测不触网、并断言「失败不清缓存」。
 */

import { invalidateModelsCache } from "./models-cache";

export type ModelCatalogRefreshErrorCode = "unavailable" | "aborted" | "providers" | "network" | "unknown";

export class ModelCatalogRefreshError extends Error {
  readonly code: ModelCatalogRefreshErrorCode;
  /** 逐 provider 的失败（`providers` 码时给出）。 */
  readonly providers?: readonly string[];

  constructor(code: ModelCatalogRefreshErrorCode, message: string, providers?: readonly string[]) {
    super(message);
    this.name = "ModelCatalogRefreshError";
    this.code = code;
    if (providers && providers.length > 0) this.providers = providers;
  }
}

interface RefreshCapableRuntime {
  refresh?: (options?: {
    allowNetwork?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }) => Promise<unknown>;
}

export interface ModelCatalogRefreshOptions {
  /** 注入 runtime（默认动态 import SDK 并 `ModelRuntime.create`）。 */
  runtimeFactory?: () => Promise<RefreshCapableRuntime>;
  signal?: AbortSignal;
  /** 成功后失效进程内缓存；注入只为测试断言「失败不清缓存」。 */
  invalidate?: () => void;
}

export interface ModelCatalogRefreshResult {
  detail: {
    /** 本次刷新是否被中止（成功路径恒为 false；失败会直接抛错）。 */
    aborted: boolean;
    /** 失败的 provider（成功时为空）。 */
    failed: string[];
  };
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
    // refreshOnCreate: false —— 创建时不刷，由下面的显式 refresh(force: true) 负责，
    // 否则创建阶段那次非 force 刷新会把 4 小时窗口占掉，显式刷新就变成空转。
    return await mod.ModelRuntime.create({ allowModelNetwork: true, refreshOnCreate: false });
  } catch (error) {
    if (error instanceof ModelCatalogRefreshError) throw error;
    throw new ModelCatalogRefreshError(
      "unavailable",
      "refreshing the model catalog requires @earendil-works/pi-coding-agent",
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (isPlainObject(value) && typeof value.message === "string") return value.message;
  return "unknown error";
}

/**
 * 解析 SDK 的刷新结果。
 *
 * 返回 null 表示拿不到契约信息（注入的假实现返回 undefined 等），调用方按成功处理；
 * 真实 SDK 的 `ModelRuntime.refresh` 总是返回 `{ aborted, errors }`。
 */
export function readRefreshOutcome(
  result: unknown,
): { aborted: boolean; errors: Map<string, string> } | null {
  if (!isPlainObject(result)) return null;
  const aborted = result.aborted === true;
  const errors = new Map<string, string>();
  const raw = result.errors;
  if (raw instanceof Map) {
    for (const [key, value] of raw) errors.set(String(key), describeError(value));
  } else if (isPlainObject(raw)) {
    for (const [key, value] of Object.entries(raw)) errors.set(key, describeError(value));
  }
  return { aborted, errors };
}

/**
 * 刷新模型目录；成功后让进程内缓存失效（下次 `GET /api/models` 重新读目录）。
 * 失败抛 `ModelCatalogRefreshError`，且**不改动**缓存与磁盘。
 */
export async function refreshModelCatalog(
  options: ModelCatalogRefreshOptions = {},
): Promise<ModelCatalogRefreshResult> {
  const runtime = await (options.runtimeFactory ?? defaultRuntimeFactory)();
  if (typeof runtime.refresh !== "function") {
    throw new ModelCatalogRefreshError(
      "unavailable",
      "this ModelRuntime build does not support refresh()",
    );
  }

  let result: unknown;
  try {
    result = await runtime.refresh({
      allowNetwork: true,
      force: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ModelCatalogRefreshError(options.signal?.aborted ? "aborted" : "network", message);
  }

  const outcome = readRefreshOutcome(result);
  if (outcome?.aborted || options.signal?.aborted) {
    throw new ModelCatalogRefreshError("aborted", "model catalog refresh was aborted");
  }
  if (outcome && outcome.errors.size > 0) {
    const failed = [...outcome.errors.keys()];
    const first = outcome.errors.values().next().value ?? "unknown error";
    throw new ModelCatalogRefreshError(
      "providers",
      `model catalog refresh failed for ${failed.join(", ")}: ${first}`,
      failed,
    );
  }

  // 只有真正成功才动缓存：失败路径不得让列表看起来「变了」。
  (options.invalidate ?? invalidateModelsCache)();
  return {
    detail: {
      aborted: false,
      failed: [],
    },
  };
}
