import assert from "node:assert/strict";
import test from "node:test";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
async function loadSubject() {
  return jiti.import("./provider-error.ts");
}

test("无 body 的 400 / 413 / 422 判定为上游拒绝但未给原因", async () => {
  const { isUnexplainedUpstreamRejection } = await loadSubject();
  assert.equal(isUnexplainedUpstreamRejection("OpenAI API error (400): 400 status code (no body)"), true);
  assert.equal(isUnexplainedUpstreamRejection("400 status code (no body)"), true);
  assert.equal(isUnexplainedUpstreamRejection("OpenAI API error (413): no content"), true);
  assert.equal(isUnexplainedUpstreamRejection("(422) empty body"), true);
});

test("带 body 的 4xx 不归类：上游已经给出原因", async () => {
  const { isUnexplainedUpstreamRejection } = await loadSubject();
  assert.equal(isUnexplainedUpstreamRejection("OpenAI API error (400): invalid request: model not found"), false);
  assert.equal(isUnexplainedUpstreamRejection("OpenAI API error (400): no body allowed here"), false);
});

test("语义明确的状态码不归类（凭证 / 路由 / 限流 / 服务端）", async () => {
  const { isUnexplainedUpstreamRejection } = await loadSubject();
  for (const status of [401, 403, 404, 429, 500, 502]) {
    assert.equal(
      isUnexplainedUpstreamRejection(`OpenAI API error (${status}): ${status} status code (no body)`),
      false,
      `${status} 不应归入无原因拒绝`,
    );
  }
});

test("非错误文本与缺少状态码的文本不归类", async () => {
  const { isUnexplainedUpstreamRejection } = await loadSubject();
  assert.equal(isUnexplainedUpstreamRejection(""), false);
  assert.equal(isUnexplainedUpstreamRejection("   "), false);
  assert.equal(isUnexplainedUpstreamRejection("Request aborted"), false);
  assert.equal(isUnexplainedUpstreamRejection("no body"), false);
  // 数字不能当状态码误读（长数字内部没有词边界）
  assert.equal(isUnexplainedUpstreamRejection("no body (max_output_tokens=114044)"), false);
});

test("包装后的状态码优先于其它数字", async () => {
  const { isUnexplainedUpstreamRejection } = await loadSubject();
  assert.equal(isUnexplainedUpstreamRejection("OpenAI API error (400): no body (max_output_tokens=114044)"), true);
});
