/**
 * 扩展自持活注册表（版本化全局键，跨模块实例共享）。
 *
 * 背景：宿主在 agent settle 或空闲超时后 dispose。扩展如果还有后台任务在跑
 * （MCP 子进程、长任务、定时器），宿主一没，完成事件就没有监听者——用户看到的是
 * 「后台任务跑完了，会话没被唤起」，与子代理那条既有问题同类（见
 * lib/sdk-session-host.ts 的 hasActiveSubagentRun 注释）。
 *
 * 与上游 pi-web v0.9.3 的**有意分叉**：上游 provider 抛错时按「仍活跃」处理
 * （fail-open）；这里一律按「不活跃」处理（fail-closed），与仓库既有取舍一致——
 * 读不到状态宁可回收，也不要因为一个抛错的扩展让会话和跨进程 writer 租约永久不释放。
 *
 * 键沿用上游符号名，pi-web 系扩展可直接复用。
 */

const LIVENESS_REGISTRY_KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");

export type SessionLivenessProvider = {
  /** 诊断用名字；同一名字重复注册视为同一提供者（后注册覆盖先注册）。 */
  name: string;
  /** 省略表示对所有会话生效；给了就只对该会话文件生效。 */
  sessionFile?: string;
  isActive: () => boolean;
};

type LivenessRegistry = {
  providers: Map<string, SessionLivenessProvider>;
  warned: Set<string>;
};

function registry(): LivenessRegistry {
  // 全局键按 Symbol 存取：Next 的 route/instrumentation 各自有模块实例，
  // 只有挂在 globalThis 上才是同一份注册表。
  const existing = (globalThis as Record<symbol, LivenessRegistry | undefined>)[LIVENESS_REGISTRY_KEY];
  if (existing) return existing;
  const created: LivenessRegistry = { providers: new Map(), warned: new Set() };
  (globalThis as Record<symbol, LivenessRegistry | undefined>)[LIVENESS_REGISTRY_KEY] = created;
  return created;
}

function providerKey(provider: SessionLivenessProvider): string {
  return `${provider.name}\u0000${provider.sessionFile ?? ""}`;
}

/**
 * 注册一个自持活提供者，返回注销函数。
 *
 * 形状不合法的注册被忽略（第三方扩展代码走这里，不能让坏形状打断宿主回收判断）。
 */
export function registerSessionLiveness(provider: SessionLivenessProvider): () => void {
  if (
    typeof provider !== "object"
    || provider === null
    || typeof provider.name !== "string"
    || provider.name === ""
    || typeof provider.isActive !== "function"
    || (provider.sessionFile !== undefined && typeof provider.sessionFile !== "string")
  ) {
    console.warn("[pidance] 忽略形状非法的 session liveness 注册:", provider);
    return () => {};
  }
  const store = registry();
  const key = providerKey(provider);
  store.providers.set(key, provider);
  store.warned.delete(key);
  return () => {
    store.providers.delete(key);
    store.warned.delete(key);
  };
}

/** 已注册的提供者名字（诊断/测试用）。 */
export function listSessionLivenessProviders(): string[] {
  return [...registry().providers.values()].map((provider) => provider.name);
}

/**
 * 本会话名下是否有扩展持有的活跃后台工作。
 *
 * fail-closed：provider 抛错按「不活跃」处理，并只告警一次（空闲窗口每轮都会问，
 * 不能每次都刷日志）。
 */
export function hasActiveExternalWork(sessionFile: string): boolean {
  const store = registry();
  for (const [key, provider] of store.providers) {
    if (provider.sessionFile !== undefined && provider.sessionFile !== sessionFile) continue;
    try {
      if (provider.isActive() === true) return true;
    } catch (error) {
      if (!store.warned.has(key)) {
        store.warned.add(key);
        console.warn(`[pidance] session liveness provider 抛错，按不活跃处理: ${provider.name}`, error);
      }
    }
  }
  return false;
}

/** 失效入口：清空全部注册（测试与热重载）。 */
export function clearSessionLivenessProviders(): void {
  const store = registry();
  store.providers.clear();
  store.warned.clear();
}
