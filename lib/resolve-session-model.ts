/**
 * 从 Pi ModelRuntime 解析模型：优先静态目录 getModel（models.json + 内置），
 * 不先走 getAvailable() 全量刷新（网络/鉴权抖动会让切换偶发失败）。
 */

export type SessionModelRef = {
  provider: string;
  id: string;
};

export type SessionModelRuntimeLike<T extends SessionModelRef> = {
  getModel?: (provider: string, modelId: string) => T | undefined;
  getAvailableSnapshot?: () => readonly T[];
};

export function resolveSessionModel<T extends SessionModelRef>(
  runtime: SessionModelRuntimeLike<T>,
  provider: string,
  modelId: string,
): T | undefined {
  const exact = runtime.getModel?.(provider, modelId);
  if (exact) return exact;
  return runtime.getAvailableSnapshot?.().find((m) => m.provider === provider && m.id === modelId);
}
