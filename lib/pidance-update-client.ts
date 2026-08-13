import type { UpgradePhase } from "@/lib/pidance-update";

export type ApplyStreamResult = {
  ok: boolean;
  status: string;
  message: string;
  targetVersion?: string | null;
};

export type UpgradeProgressState = {
  phase: UpgradePhase;
  percent: number;
  message: string;
};

/**
 * POST /api/update/apply 的 SSE 客户端。
 * 关于页与打开页横幅共用，避免再分 JSON / stream 两套路径。
 */
export async function streamApplyPidanceUpdate(
  version: string,
  onProgress: (event: UpgradeProgressState) => void,
): Promise<ApplyStreamResult> {
  const res = await fetch("/api/update/apply?stream=1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ version, stream: true }),
  });

  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as ApplyStreamResult | null;
    return {
      ok: false,
      status: data?.status || "error",
      message: data?.message || `HTTP ${res.status}`,
      targetVersion: data?.targetVersion ?? version,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let finalResult: ApplyStreamResult | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        const payload = JSON.parse(line.slice(6)) as {
          type?: string;
          phase?: UpgradePhase;
          percent?: number;
          message?: string;
          result?: ApplyStreamResult;
        };
        if (payload.type === "progress" && payload.phase) {
          onProgress({
            phase: payload.phase,
            percent: typeof payload.percent === "number" ? payload.percent : 0,
            message: payload.message || "",
          });
        } else if (payload.type === "result" && payload.result) {
          finalResult = payload.result;
        }
      } catch {
        /* ignore bad frame */
      }
    }
  }

  return (
    finalResult ?? {
      ok: false,
      status: "error",
      message: "升级未返回结果",
      targetVersion: version,
    }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 轮询 /api/about，直到新进程起来（版本对上或鉴权层已响应）。 */
export async function waitForPidanceReady(options: {
  expectedVersion?: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
  onTick?: (elapsedMs: number) => void;
} = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 1_500;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const pause = options.sleepImpl ?? sleep;
  const start = now();
  while (now() - start < timeoutMs) {
    options.onTick?.(now() - start);
    try {
      const res = await fetchImpl("/api/about", { cache: "no-store", credentials: "same-origin" });
      if (res.status === 401 || res.status === 403) return true;
      if (res.ok) {
        const data = (await res.json()) as { version?: unknown };
        if (!options.expectedVersion) return true;
        if (typeof data.version === "string" && data.version === options.expectedVersion) return true;
      }
    } catch {
      /* 进程还没起来 */
    }
    await pause(intervalMs);
  }
  return false;
}

function likelyRestartedWithoutResult(lastPhase: UpgradePhase, result: ApplyStreamResult): boolean {
  if (result.ok) return false;
  const dropped =
    result.message.includes("升级未返回结果") ||
    /network|fetch|abort|failed/i.test(result.message);
  return dropped && (lastPhase === "restarting" || lastPhase === "linking" || lastPhase === "done");
}

/**
 * 一键升级完整流程：SSE 安装 → 等服务重启就绪。
 * 关于页与右下角横幅共用，避免两套收尾逻辑漂移。
 */
export async function runPidanceUpgrade(
  version: string,
  onProgress: (event: UpgradeProgressState) => void,
  options?: {
    fetchImpl?: typeof fetch;
    wait?: typeof waitForPidanceReady;
  },
): Promise<ApplyStreamResult> {
  let lastPhase: UpgradePhase = "preparing";
  const wait = options?.wait ?? waitForPidanceReady;
  const track = (event: UpgradeProgressState) => {
    lastPhase = event.phase;
    onProgress(event);
  };

  let result: ApplyStreamResult;
  try {
    result = await streamApplyPidanceUpdate(version, track);
  } catch (e) {
    result = {
      ok: false,
      status: "error",
      message: e instanceof Error ? e.message : String(e),
      targetVersion: version,
    };
  }

  const shouldWait =
    (result.ok && (result.status === "upgraded" || result.status === "already_latest")) ||
    likelyRestartedWithoutResult(lastPhase, result);
  if (!shouldWait) return result;

  const target = result.targetVersion ?? version;
  track({ phase: "waiting", percent: 97, message: "等待服务就绪…" });
  const ready = await wait({
    expectedVersion: result.status === "already_latest" ? undefined : target,
    fetchImpl: options?.fetchImpl,
    onTick: (elapsed) => {
      track({
        phase: "waiting",
        percent: Math.min(99, 97 + Math.floor(elapsed / 30_000)),
        message: "等待服务就绪…",
      });
    },
  });
  if (!ready) {
    return {
      ok: false,
      status: "error",
      message: "已切换版本，但等待服务就绪超时，请手动刷新",
      targetVersion: target,
    };
  }
  return {
    ok: true,
    status: result.ok ? result.status : "upgraded",
    message: result.ok ? result.message : `已升级到 ${target}`,
    targetVersion: target,
  };
}
