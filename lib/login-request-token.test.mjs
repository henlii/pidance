/**
 * 挂起登录 token 的不可预测性（issue #86）。
 *
 * 早先是 `${provider}-${Date.now()}-${Math.random()...}`：可预测，而且把 provider 与
 * 发起时间编进 token，回调路由只能靠前缀反查归属。现在 token 只做一次性凭据，
 * provider 存在挂起记录里。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createLoginRequestToken } = await jiti.import("./login-request-token.ts");
const ROUTE_SOURCE = readFileSync(
  fileURLToPath(new URL("../app/api/auth/login/[provider]/route.ts", import.meta.url)),
  "utf8",
);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("token 是不可预测的 UUID，不含 provider、不含时间戳线索", () => {
  const token = createLoginRequestToken();
  assert.match(token, UUID_V4, "必须是 v4 UUID（randomUUID）");

  // 不泄漏 provider：函数签名就不接受 provider，结构上不可能编进去。
  for (const provider of ["openai", "anthropic", "xiaomi-token-plan-ams", "github-copilot"]) {
    assert.equal(token.includes(provider), false, `token 不得包含 provider 名 ${provider}`);
  }
  // 不含时间线索：老实现用 Date.now()，token 里能看出先后；UUID v4 没有这个结构。
  assert.equal(token.includes(String(Date.now())), false);
  assert.equal(/^\d{13}-/.test(token), false, "不得以 13 位时间戳开头");
});

test("连续生成的 token 互不相同且不可由前一个推断", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(createLoginRequestToken());
  assert.equal(seen.size, 200, "200 次生成必须全部唯一");

  // 老实现是 Math.random().toString(36)：短且带前缀。这里守住「不含 provider 前缀」与长度下限。
  for (const token of seen) {
    assert.equal(token.length, 36, "UUID 长度固定 36");
    assert.equal(token.startsWith("openai-"), false);
  }
});

test("回调路由用 createLoginRequestToken，且不再有可预测来源或 provider 前缀校验", () => {
  assert.match(ROUTE_SOURCE, /createLoginRequestToken/, "路由必须使用统一的 token 工厂");
  assert.doesNotMatch(ROUTE_SOURCE, /Math\.random/, "不得再用 Math.random 造 token");
  assert.doesNotMatch(ROUTE_SOURCE, /`\$\{provider\}-\$\{Date\.now\(\)\}/, "不得再把 provider/时间编进 token");
  assert.doesNotMatch(ROUTE_SOURCE, /token\.startsWith\(/, "归属不得再由 token 前缀推断");
  assert.match(ROUTE_SOURCE, /callbacks\.provider !== provider/, "归属必须以挂起记录里的 provider 为准");
});
