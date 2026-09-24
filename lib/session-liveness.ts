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
 * 与上游一致的部分：`sessionId` 必填、按 id 或文件命中、注销按注册 token 只删自己
 * （同名后注册不会被先返回的注销函数误删）。
 *
 * 键沿用上游符号名，pi-web 系扩展可直接复用。
 */

const LIVENESS_REGISTRY_KEY = Symbol.for("@agegr/pi-web/session-liveness/v1");

export type SessionLivenessProvider = {
  /** 诊断用名字；同名可以注册多个，各自独立注销。 */
  name: string;
  /** 提供者所属的会话 id。**必填**：不给就不能确定作用范围，只能对所有会话生效——
   *  那会让一个扩展拖住其它会话的回收与跨进程 writer 租约。 */
  sessionId: string;
  /** 可选：会话文件路径，与 sessionId 二选一命中即可。 */
  sessionFile?: string;
  isActive: () => boolean;
};

/** 查询方的会话身份（宿主同时有两项）。 */
export type SessionIdentity = {
  sessionId?: string;
  sessionFile?: string;
};

type LivenessRegistry = {
  /** 键是注册时生成的 token：注销只删自己那份，不会被同名的先注销者误删（与上游一致）。 */
  providers: Map<symbol, SessionLivenessProvider>;
  warned: Set<symbol>;
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

function providerKey(provider: SessionLivenessProvider): symbol {
  return Symbol(provider.name);
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
    || typeof provider.sessionId !== "string"
    || provider.sessionId === ""
    || (provider.sessionFile !== undefined && typeof provider.sessionFile !== "string")
  ) {
    console.warn("[pidance] 忽略形状非法的 session liveness 注册（需要 name / sessionId / isActive）:", provider);
    return () => {};
  }
  const store = registry();
  const token = providerKey(provider);
  store.providers.set(token, provider);
  store.warned.delete(token);
  let disposed = false;
  return () => {
    // 幂等且只删自己那份：同名/同会话的后注册不会被先返回的注销函数删掉。
    if (disposed) return;
    disposed = true;
    store.providers.delete(token);
    store.warned.delete(token);
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
export function hasActiveExternalWork(session: SessionIdentity): boolean {
  const store = registry();
  const identities = new Set(
    [session.sessionId, session.sessionFile].filter((value): value is string => Boolean(value)),
  );
  if (identities.size === 0) return false;
  for (const [token, provider] of store.providers) {
    // 按 id 或文件命中（与上游一致）：两者都不命中就不属于本会话。
    const matches = identities.has(provider.sessionId)
      || (provider.sessionFile !== undefined && identities.has(provider.sessionFile));
    if (!matches) continue;
    try {
      if (provider.isActive() === true) return true;
    } catch (error) {
      if (!store.warned.has(token)) {
        store.warned.add(token);
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
