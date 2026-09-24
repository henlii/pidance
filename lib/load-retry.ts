/**
 * 带超时与有界重试的加载（issue #91「失败要能恢复」）。
 *
 * 背景：同源连接被饿住时请求**一个字节都收不到**，于是既不 resolve 也不 reject。
 * 没有超时的加载路径会把界面永久留在 loading —— 实测：页面里的
 * `/api/sessions/<id>?deferThinking=1&…` 挂住 20s+ 不返回，而**同时刻**服务端 curl
 * 只要 5–6ms；`location.reload()` 立刻恢复（旧文档的连接被释放）。
 *
 * 语义：
 * - 每次尝试有**独立超时**；超时算一次可重试失败（不是终态）。
 * - `signal` 是「切走 / 被更新的加载取代」：一旦它 aborted 立刻停（不重试，也不算失败），
 *   并抛出 AbortError —— 调用方既有的 `isAbortError` 判断照旧把取消当「不是错误」。
 * - 重试次数用尽后抛 `LoadFailedError`（带 `attempts` 与最后一次失败原因），
 *   调用方据此给出**可见且可点重试**的提示。
 * - 只重试「可能是暂时性」的失败：超时、网络错误、5xx / 408 / 429。4xx 直接返回响应，
 *   由调用方按既有语义处理（例如 404 表示会话不存在，不该重试）。
 */

export type LoadFailureKind = "timeout" | "network" | "http";

export type LoadFailure = {
  kind: LoadFailureKind;
  /** http 失败时的状态码 */
  status?: number;
  /** 失败简述（用于日志与提示的细节行） */
  detail?: string;
};

/** 重试都用尽后的失败。`message` 是给人看的简述，细节在 `failure` 里。 */
export class LoadFailedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly failure: LoadFailure,
  ) {
    super(
      failure.kind === "timeout"
        ? `加载超时（已尝试 ${attempts} 次）`
        : `加载失败（已尝试 ${attempts} 次）`,
    );
    this.name = "LoadFailedError";
  }
}

export type LoadWithRetryOptions = {
  url: string;
  /** 「切走/被取代」的取消信号（不是超时）。 */
  signal: AbortSignal;
  timeoutMs: number;
  /** 首次尝试之外的额外尝试次数（0 = 只试一次）。 */
  maxRetries: number;
  /** 第 n 次重试前等待 `retryDelayMs * n`。 */
  retryDelayMs: number;
  fetchImpl?: typeof fetch;
  /** 注入定时器（测试用）；默认全局 setTimeout。 */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** 每次失败后回调（用于日志/埋点）。 */
  onAttemptFailed?: (failure: LoadFailure, attempt: number) => void;
};

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function delay(ms: number, schedule?: LoadWithRetryOptions["schedule"]): Promise<void> {
  return new Promise((resolve) => {
    if (schedule) {
      schedule(resolve, ms);
      return;
    }
    setTimeout(resolve, ms);
  });
}

/** 手动组合取消信号与超时信号：避免依赖 `AbortSignal.any` 的浏览器版本，也便于清理监听。 */
function combineSignals(
  caller: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  if (caller.aborted) controller.abort();
  else caller.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      caller.removeEventListener("abort", onCallerAbort);
    },
  };
}

/** 该状态码是否值得重试（4xx 多为确定性失败，重试只会拖长等待）。 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/**
 * 发起请求；失败按上面的语义重试。成功（含调用方需要自己判断的 4xx）返回 Response。
 * 调用方 signal 被取消时抛 AbortError；重试用尽时抛 LoadFailedError。
 */
export async function loadWithBoundedRetry(options: LoadWithRetryOptions): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const attemptsAllowed = Math.max(1, options.maxRetries + 1);
  let lastFailure: LoadFailure = { kind: "network" };

  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    if (options.signal.aborted) throw abortError();
    const combined = combineSignals(options.signal, options.timeoutMs);
    try {
      const response = await doFetch(options.url, { signal: combined.signal });
      if (response.ok) return response;
      if (response.status === 404 || !isRetryableStatus(response.status)) return response;
      lastFailure = { kind: "http", status: response.status, detail: `HTTP ${response.status}` };
    } catch (error) {
      // 取消（切走/被取代）优先：不算失败、不重试。
      if (options.signal.aborted) throw abortError();
      if (combined.timedOut()) {
        lastFailure = { kind: "timeout", detail: `超时 ${options.timeoutMs}ms` };
      } else if (error instanceof Error && error.name === "AbortError") {
        // 既不是调用方取消、也不是超时：当作网络层失败重试。
        lastFailure = { kind: "network", detail: error.message };
      } else {
        lastFailure = { kind: "network", detail: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      combined.cleanup();
    }

    options.onAttemptFailed?.(lastFailure, attempt);
    if (attempt < attemptsAllowed) {
      await delay(options.retryDelayMs * attempt, options.schedule);
      if (options.signal.aborted) throw abortError();
    }
  }

  throw new LoadFailedError(attemptsAllowed, lastFailure);
}
