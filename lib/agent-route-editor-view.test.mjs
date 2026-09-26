/**
 * `POST /api/agent/[id]` 对编辑器接管的**视图上报**不能唤醒会话（issue #107 四轮审查 阻断 1）。
 *
 * 这条报文是纯登记：客户端切走 / 关标签时会补一条 `shown=false` 注销自己在旧会话上的登记，
 * 而宿主可能已经回收了那个会话。走 `sessionService.send` 会对已经不 live 的会话 `ensureLive`
 * —— 为了注销一条登记去唤醒旧宿主、占上写者租约，还会让侧栏把那个会话短暂显示成运行中。
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { sessionService } = await jiti.import("@/lib/session-service");
const { POST: agentPost } = await jiti.import("../app/api/agent/[id]/route.ts");

const SESSION_ID = "no-such-session-for-editor-view";
const params = { params: Promise.resolve({ id: SESSION_ID }) };
const post = (body) =>
  new Request("http://localhost/api/agent/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("视图上报：会话不 live 时按成功返回，且不建 host（对照组证明不是恒真）", async () => {
  assert.ok(!sessionService.getLive(SESSION_ID), "前置：这个会话本来就没有 live host");

  const response = await agentPost(
    post({ type: "editor_takeover_view", requestId: "t1", shown: false, clientId: "tab-A" }),
    params,
  );
  assert.equal(response.status, 200, "纯登记不该因为「会话不在跑」而失败");
  assert.ok(!sessionService.getLive(SESSION_ID), "更不能为了注销一条登记去唤醒宿主（会占写者租约）");

  // 对照组：别的命令照旧走 send（对这个不存在的会话会失败）—— 说明上面那次不是"什么命令都 200"。
  const control = await agentPost(post({ type: "set_thinking_level", level: "high" }), params);
  assert.notEqual(control.status, 200, "其它命令仍然要真正的 host（403/404/500 都行，但不该是 200）");
  assert.ok(!sessionService.getLive(SESSION_ID), "对照组也不该留下 host");
});
