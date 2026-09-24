/**
 * 挂起登录请求的一次性 token（OAuth 手动码流程）。
 *
 * 早先的实现是 `` `${provider}-${Date.now()}-${Math.random()...}` ``：可预测，并且把
 * provider 与发起时间编进了 token 本身——回调路由只能靠**前缀**反查它属于哪个
 * provider（`token.startsWith(`${provider}-`)`），于是 token 既泄漏信息、又让
 * 「属于谁」这件事没有权威来源（见 issue #86）。
 *
 * 现在 token 只做「不可预测的一次性凭据」，provider 存在挂起记录里（见
 * `app/api/auth/login/[provider]/route.ts` 的回调注册表）。本函数**不接受任何参数**，
 * 所以结构上就不可能把 provider 编进 token。
 */
import { randomUUID } from "node:crypto";

export function createLoginRequestToken(): string {
  return randomUUID();
}
