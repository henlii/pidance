import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 墓碑删除语义（客户端侧）：删除 = 内存置 null + PUT 显式 null，
 * 服务端 merge 遇 null 删键 —— 解决「发送后草稿残留服务端，sync 复活」。
 */
const jiti = createJiti(import.meta.url);
const m = await jiti.import("./server-preferences.ts");

const savedFetch = globalThis.fetch;
function installMockFetch() {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ method, url: String(url), body: options.body ? JSON.parse(String(options.body)) : undefined });
    if (method === "GET") {
      return new Response(JSON.stringify({ prefs: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return calls;
}

test("server-preferences：删除以 null 墓碑 PUT，读侧归一 undefined", async () => {
  const calls = installMockFetch();
  try {
    await m.ensureServerPrefsLoaded();
    // 模拟一次草稿写入（同 clearDraft 路径）
    m.setServerPref("drafts.s1", { value: "残留文本", images: [], updatedAt: Date.now() });
    assert.equal(m.getServerPref("drafts.s1").value, "残留文本");

    // clearDraft 等价删除
    m.setServerPref("drafts.s1", undefined);
    // 读侧统一 undefined（调用方无需区分 null/缺失）
    assert.equal(m.getServerPref("drafts.s1"), undefined);

    m.flushServerPrefs();
    const put = calls.find((c) => c.method === "PUT");
    assert.ok(put, "删除后应立即 PUT");
    assert.equal(put.body.prefs.drafts.s1, null, "PUT 必须携带显式 null 墓碑");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("server-preferences：墓碑可被新值覆盖", async () => {
  const calls = installMockFetch();
  try {
    await m.ensureServerPrefsLoaded();
    m.setServerPref("drafts.s2", { value: "新草稿", images: [] });
    m.setServerPref("drafts.s2", undefined);
    m.setServerPref("drafts.s2", { value: "又输入了", images: [] });
    assert.equal(m.getServerPref("drafts.s2").value, "又输入了");
    m.flushServerPrefs();
    const put = calls.find((c) => c.method === "PUT");
    assert.deepEqual(put.body.prefs.drafts.s2, { value: "又输入了", images: [] });
  } finally {
    globalThis.fetch = savedFetch;
  }
});
