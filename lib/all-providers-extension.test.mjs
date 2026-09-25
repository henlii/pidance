/**
 * /api/auth/all-providers 的扩展 provider 接线。
 *
 * 验收点：扩展注册的 provider（含未认证的）必须出现在「设置/登录」的 provider 来源里，
 * 且不能覆盖内置/models.json 已有的同名条目；扩展加载失败只降级、不把列表整页搞崩。
 *
 * 注入假加载器：不加载真实扩展、不读凭据、不触网。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { createAllProvidersHandler } = await jiti.import("./all-providers-route.ts");

async function withAgentDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "all-providers-"));
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

const request = (cwd) =>
  new Request(`http://localhost/api/auth/all-providers?cwd=${encodeURIComponent(cwd ?? process.cwd())}`);

test("扩展 provider 出现在来源里，标记 source=extension", async () => {
  await withAgentDir(async () => {
    const handler = createAllProvidersHandler(async () => ({
      providers: [
        { id: "acme-gateway", displayName: "Acme Gateway", source: "extension", modelCount: 2 },
      ],
    }));
    const res = await handler(request());
    assert.equal(res.status, 200);
    const body = await res.json();
    const entry = body.providers.find((p) => p.id === "acme-gateway");
    assert.ok(entry, "扩展 provider 应出现在列表里");
    assert.equal(entry.displayName, "Acme Gateway");
    assert.equal(entry.source, "extension");
    assert.equal(entry.modelCount, 2);
    assert.equal(entry.configured, false, "未认证也要能出现（否则没法配 Key）");
  });
});

test("与内置同 id 时不覆盖已有条目（来源以用户已能看到的为准）", async () => {
  await withAgentDir(async () => {
    const handler = createAllProvidersHandler(async () => ({
      providers: [{ id: "anthropic", displayName: "扩展叫法", source: "extension", modelCount: 9 }],
    }));
    const body = await (await handler(request())).json();
    const entries = body.providers.filter((p) => p.id === "anthropic");
    assert.equal(entries.length, 1, "不应出现重复条目");
    assert.notEqual(entries[0].displayName, "扩展叫法");
    assert.notEqual(entries[0].source, "extension");
  });
});

test("扩展加载失败：列表照常返回，原因单独带出", async () => {
  await withAgentDir(async () => {
    const handler = createAllProvidersHandler(async () => ({ providers: [], error: "boom" }));
    const res = await handler(request());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.providers));
    assert.equal(body.extensionProvidersError, "boom");
  });
});

test("没有扩展 provider 时不带错误字段（响应保持干净）", async () => {
  await withAgentDir(async () => {
    const handler = createAllProvidersHandler(async () => ({ providers: [] }));
    const body = await (await handler(request())).json();
    assert.equal("extensionProvidersError" in body, false);
  });
});
