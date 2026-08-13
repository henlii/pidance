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
