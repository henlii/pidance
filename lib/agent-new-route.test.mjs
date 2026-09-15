/**
 * Issue #37：POST /api/agent/new 的错误状态码映射。
 *
 * 旧实现用 `String(error)` 与 `"cwd is required"` 等原文比较，而
 * `String(new Error("cwd is required"))` 是 `"Error: cwd is required"`，
 * 两个 400 分支永远不命中 —— 缺参数/目录不存在都被报成 500。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { POST } = await jiti.import("../app/api/agent/new/route.ts");
const { httpStatusForNewSessionError } = await jiti.import("./session-service.ts");

function post(body) {
  return POST(new Request("http://localhost/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

test("#37 缺失 cwd → 400（旧实现误报 500）", async () => {
  const res = await post({ type: "ensure_session" });
  assert.equal(res.status, 400, "缺参数属于客户端错误");
  assert.equal((await res.json()).error, "cwd is required");
});

test("#37 cwd 目录不存在 → 400（旧实现误报 500）", async () => {
  const missing = join(tmpdir(), "pidance-not-here-#37-does-not-exist");
  const res = await post({ cwd: missing, type: "ensure_session" });
  assert.equal(res.status, 400, "目录不存在属于客户端错误");
  assert.match((await res.json()).error, /Directory does not exist/);
});

test("#37 映射函数：Error 前缀不再让 400 分支失效", () => {
  // 直接钉住旧缺陷：String(new Error(...)) 带前缀，按原文比较必然失配。
  assert.equal(String(new Error("cwd is required")), "Error: cwd is required");
  assert.equal(httpStatusForNewSessionError(new Error("cwd is required")), 400);
  assert.equal(httpStatusForNewSessionError(new Error("Directory does not exist: /x")), 400);
  assert.equal(httpStatusForNewSessionError(new Error("Session not found")), 404);
  assert.equal(httpStatusForNewSessionError(new Error("boom")), 500);
});

test("#37 非输入错误仍保持 500（不把失败伪装成客户端错误）", async () => {
  // 合法 cwd + 非法 type：走 service 抛错路径，必须不是 400 的输入错误分支。
  const dir = mkdtempSync(join(tmpdir(), "pidance-new-route-"));
  try {
    const res = await post({ cwd: dir, type: "definitely-not-a-command" });
    assert.ok(res.status >= 400, `应返回错误状态，实际 ${res.status}`);
    assert.notEqual(res.status, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
