/**
 * 密码认证限流状态：Basic 与页内登录表单**共用同一个计数器**，避免两条入口互相绕过。
 *
 * 与上游 pi-web 的有意差异：上游拿不到可靠的客户端地址（route handler 无 socket），
 * 于是用全局单一计数器。我们的自管 HTTP server 会把对端地址写进 `x-pidance-peer-ip`
 * （客户端自带的同名头一律覆盖），因此按地址分桶；取不到对端地址时退回固定全局桶
 * （宁可误伤也不放行）。是否信任 `x-forwarded-for` 由 `PIDANCE_TRUST_PROXY=1` 显式开启，
 * 默认关闭。
 *
 * 退避 1s → 60s 封顶；空闲 5 分钟复位。复位窗口必须比最大退避更长，否则「等过封锁」
 * 就等于把退避打回基准延迟，给攻击者新一轮爆发。
 */

export const AUTH_THROTTLE_BASE_DELAY_MS = 1_000;
export const AUTH_THROTTLE_MAX_DELAY_MS = 60_000;
export const AUTH_THROTTLE_RESET_AFTER_MS = 5 * 60_000;

/** 分桶上限：地址来自真实对端连接，但仍给 Map 设上界，避免异常来源无界增长。 */
const AUTH_THROTTLE_MAX_BUCKETS = 256;

export interface AuthThrottleState {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
}

declare global {
  var __piAuthThrottle: Map<string, AuthThrottleState> | undefined;
}

function store(): Map<string, AuthThrottleState> {
  if (!globalThis.__piAuthThrottle) globalThis.__piAuthThrottle = new Map();
  return globalThis.__piAuthThrottle;
}

function freshState(): AuthThrottleState {
  return { failures: 0, lastFailureAt: 0, blockedUntil: 0 };
}

function isStale(state: AuthThrottleState, now: number): boolean {
  return now - state.lastFailureAt >= AUTH_THROTTLE_RESET_AFTER_MS;
}

function expireIfStale(state: AuthThrottleState, now: number): void {
  if (state.failures > 0 && isStale(state, now)) Object.assign(state, freshState());
}

/** 桶数超上限时先清掉已过期桶；仍超上限则丢弃最早失活的桶。 */
function prune(now: number): void {
  const map = store();
  if (map.size <= AUTH_THROTTLE_MAX_BUCKETS) return;
  for (const [key, state] of map) {
    if (state.failures === 0 || isStale(state, now)) map.delete(key);
  }
  while (map.size > AUTH_THROTTLE_MAX_BUCKETS) {
    const oldest = [...map.entries()].sort((a, b) => a[1].lastFailureAt - b[1].lastFailureAt)[0];
    if (!oldest) break;
    map.delete(oldest[0]);
  }
}

export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  const exponent = Math.min(failures - 1, 31);
  return Math.min(AUTH_THROTTLE_BASE_DELAY_MS * 2 ** exponent, AUTH_THROTTLE_MAX_DELAY_MS);
}

/** 该桶还需等待多久（毫秒）；0 表示可以尝试。 */
export function getAuthRetryAfterMs(key: string, now = Date.now()): number {
  const state = store().get(key);
  if (!state) return 0;
  expireIfStale(state, now);
  return Math.max(0, state.blockedUntil - now);
}

/** 记录一次失败并返回这次施加的退避时长（毫秒）。 */
export function recordAuthFailure(key: string, now = Date.now()): number {
  const map = store();
  let state = map.get(key);
  if (!state) {
    state = freshState();
    map.set(key, state);
  }
  expireIfStale(state, now);
  state.failures += 1;
  state.lastFailureAt = now;
  state.blockedUntil = now + backoffDelayMs(state.failures);
  prune(now);
  return backoffDelayMs(state.failures);
}

/**
 * 登录表单成功：复位该桶。
 *
 * Basic 成功**不复位**（每个请求都带 Basic，复位会让穿插猜测者回到基准延迟）；
 * 由调用方决定，故不复用本函数。
 */
export function recordAuthSuccess(key: string): void {
  store().delete(key);
}

/** 清空全部桶（诊断与测试用）。 */
export function resetAuthThrottle(): void {
  store().clear();
}

/** `Retry-After` 头用的整秒；被封锁时至少为 1。 */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
