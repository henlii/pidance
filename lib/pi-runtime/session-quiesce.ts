/**
 * 树写前 quiesce：abort → 短等 → 停外部 RPC 进程。
 * 与 ExternalRpcSession.quiesceForTreeWrite 同语义，抽成可测纯流程。
 */

export type QuiesceTarget = {
  isAlive: () => boolean;
  abort: () => Promise<void>;
  stop: () => Promise<void>;
};

export type QuiesceOptions = {
  /** abort 后等待 ms，默认 50 */
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * 对外部 RPC 目标执行 quiesce。目标已死则 no-op。
 * 不负责 registry/destroy 回调——由调用方处理。
 */
export async function quiesceRpcProcess(
  target: QuiesceTarget | null | undefined,
  options: QuiesceOptions = {},
): Promise<void> {
  if (!target?.isAlive()) return;
  const settleMs = options.settleMs ?? 50;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  try {
    await target.abort();
  } catch {
    /* abort 失败仍继续 stop */
  }
  await sleep(settleMs);
  try {
    await target.stop();
  } catch {
    /* stop 失败由上层 destroy 兜底 */
  }
}
