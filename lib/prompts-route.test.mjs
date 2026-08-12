/**
 * /api/prompts 测试：启用/禁用控制 md 文件存在；禁用时内容仍持久化（草稿）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { GET, PUT } = await jiti.import("../app/api/prompts/route.ts");
const { PROMPT_FILES } = await jiti.import("../lib/prompt-files.ts");

async function withAgentDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "prompts-"));
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

test("GET 无文件返回禁用空内容；PUT 启用写文件", async () => {
  await withAgentDir(async (dir) => {
    const res = await GET();
    const entries = (await res.json()).entries;
    assert.equal(entries.length, 3);
    for (const e of entries) {
      assert.equal(e.enabled, false);
      assert.equal(e.content, "");
    }

    // 启用 system：写入内容
    const put = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ key: "system", enabled: true, content: "# 系统文令\n正文" }),
    }));
    assert.equal(put.status, 200);
    const file = join(dir, PROMPT_FILES.system);
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file, "utf8"), "# 系统文令\n正文");

    // GET 反映启用 + 内容
    const res2 = await GET();
    const sys = (await res2.json()).entries.find((e) => e.key === "system");
    assert.equal(sys.enabled, true);
    assert.match(sys.content, /# 系统文令/);
  });
});

test("禁用时编辑保存内容；重新启用写回文件", async () => {
  await withAgentDir(async (dir) => {
    // 先启用写入
    await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ key: "agents", enabled: true, content: "v1" }),
    }));
    // 禁用（文件删除，草稿保留 v1）
    await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ key: "agents", enabled: false }),
    }));
    const file = join(dir, PROMPT_FILES.agents);
    assert.ok(!existsSync(file));

    // 禁用状态编辑保存 v2（不创建文件）
    await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ key: "agents", content: "v2" }),
    }));
    assert.ok(!existsSync(file), "禁用时保存不得创建文件");

    // 重新启用：写回 v2
    await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ key: "agents", enabled: true }),
    }));
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file, "utf8"), "v2");
  });
});

test("非法 key / 类型 → 400", async () => {
  await withAgentDir(async () => {
    const badKey = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ key: "nope", enabled: true }),
    }));
    assert.equal(badKey.status, 400);
    const badEnabled = await PUT(new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ key: "system", enabled: "yes" }),
    }));
    assert.equal(badEnabled.status, 400);
  });
});
