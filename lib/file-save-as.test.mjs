/**
 * 「另存为」客户端：成功取回落盘路径；非 2xx 把服务端原因透出来（不吞成通用失败）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { saveFileAs } = await jiti.import("./file-save-as.ts");

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("saveFileAs：成功返回落盘路径与文件名", async () => {
  let called = null;
  const result = await saveFileAs({
    path: "/src/pic.png",
    targetDirectory: "/dst",
    fetchImpl: async (url, init) => {
      called = { url, body: JSON.parse(init.body) };
      return jsonResponse(200, { path: "/dst/pic.png", name: "pic.png" });
    },
  });
  assert.deepEqual(result, { ok: true, path: "/dst/pic.png", name: "pic.png" });
  assert.equal(called.url, "/api/files/save-as");
  assert.deepEqual(called.body, { path: "/src/pic.png", targetDirectory: "/dst" });
});

test("saveFileAs：失败时透出服务端原因（403/404/409 各有默认文案）", async () => {
  const denied = await saveFileAs({ path: "/s", targetDirectory: "/d", fetchImpl: async () => jsonResponse(403, { error: "Access denied" }) });
  assert.deepEqual(denied, { ok: false, message: "Access denied" });
  const missing = await saveFileAs({ path: "/s", targetDirectory: "/d", fetchImpl: async () => jsonResponse(404, {}) });
  assert.deepEqual(missing, { ok: false, message: "Not found" });
  const conflict = await saveFileAs({ path: "/s", targetDirectory: "/d", fetchImpl: async () => jsonResponse(409, { error: "Too many copies" }) });
  assert.deepEqual(conflict, { ok: false, message: "Too many copies" });
});

test("saveFileAs：网络异常与空响应都回失败，不抛", async () => {
  const thrown = await saveFileAs({ path: "/s", targetDirectory: "/d", fetchImpl: async () => { throw new Error("boom"); } });
  assert.equal(thrown.ok, false);
  const empty = await saveFileAs({ path: "/s", targetDirectory: "/d", fetchImpl: async () => jsonResponse(200, {}) });
  assert.equal(empty.ok, false);
});
