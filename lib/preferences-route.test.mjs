/**
 * /api/preferences 测试：合并写入 + 原子持久化（隔离 agentDir）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { GET, PUT } = await jiti.import("../app/api/preferences/route.ts");

async function withAgentDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "prefs-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("GET 无文件返回空对象", async () => {
  await withAgentDir(async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).prefs, {});
  });
});

test("PUT 顶层合并不覆盖已有键；写盘可读回", async () => {
  await withAgentDir(async (dir) => {
    await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ prefs: { drafts: { a: "x" }, fileTree: { "/a": { expanded: [] } } } }),
    }));
    // 第二次合并：只改 drafts.b，fileTree 保留
    await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ prefs: { drafts: { b: "y" } } }),
    }));
    const res = await GET();
    const prefs = (await res.json()).prefs;
    assert.deepEqual(prefs.drafts, { a: "x", b: "y" });
    assert.deepEqual(prefs.fileTree, { "/a": { expanded: [] } });

    const path = join(dir, "pidance-preferences.json");
    assert.ok(existsSync(path));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).drafts, { a: "x", b: "y" });
  });
});

test("PUT 非对象 prefs → 400；超大 → 413", async () => {
  await withAgentDir(async () => {
    const bad = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ prefs: [1] }),
    }));
    assert.equal(bad.status, 400);

    const huge = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ prefs: { x: "a".repeat(1_100_000) } }),
    }));
    assert.equal(huge.status, 413);
  });
});
