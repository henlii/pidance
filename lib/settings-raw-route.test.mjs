/**
 * /api/settings/raw 路由测试：JSON 校验 + 原子写（隔离 agentDir）。
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
const { GET, PUT } = await jiti.import("../app/api/settings/raw/route.ts");

async function withAgentDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "settings-raw-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    // 必须 await：否则 finally 在异步 fn 挂起时先还原 env，
    // 后续 await（如 PUT 的 req.json）会读到真实 agentDir
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
    const body = await res.json();
    assert.equal(body.json.trim(), "{}");
  });
});

test("PUT 非法 JSON → 400；合法对象 → 落盘；非对象 → 400", async () => {
  await withAgentDir(async (dir) => {
    const bad = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ json: "{ not json" }),
    }));
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /Invalid JSON/);

    const array = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ json: "[1,2]" }),
    }));
    assert.equal(array.status, 400);
    assert.match((await array.json()).error, /object/);

    const ok = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ json: JSON.stringify({ theme: "dark", retry: { enabled: true } }) }),
    }));
    assert.equal(ok.status, 200);
    const path = join(dir, "settings.json");
    assert.ok(existsSync(path));
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.theme, "dark");
    assert.equal(written.retry.enabled, true);

    // 读回
    const res = await GET();
    const body = await res.json();
    assert.match(body.json, /"theme": "dark"/);
  });
});

test("PUT 非字符串 json → 400；超大 → 413", async () => {
  await withAgentDir(async () => {
    const noStr = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ json: 42 }),
    }));
    assert.equal(noStr.status, 400);

    const huge = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ json: `{"x":"${"a".repeat(1_100_000)}"}` }),
    }));
    assert.equal(huge.status, 413);
  });
});
