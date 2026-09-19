/**
 * /api/models-config/test 路由测试：
 * - 入参缺失 → 400 JSON（不得抛给框架）
 * - 上游不可达 → JSON 里必须带得出真因（fetch failed 本身看不出是拒连还是 DNS）
 * - 上游回非 JSON → 仍然 200/JSON，正文片段带回给界面
 * 全程用临时 agentDir + 本地 HTTP 桩，不碰真实 ~/.pi/agent。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { POST } = await jiti.import("../app/api/models-config/test/route.ts");

async function withAgentDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "models-test-route-"));
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

function testRequest(payload) {
  return new Request("http://localhost/api/models-config/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** 起一个一次性 HTTP 桩，返回它的 baseUrl 与关闭函数。 */
async function withStubServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("入参与模型缺失：返回 400 JSON，不抛错", async () => {
  await withAgentDir(async () => {
    const noProvider = await POST(testRequest({}));
    assert.equal(noProvider.status, 400);
    assert.equal((await noProvider.json()).ok, false);

    const noModel = await POST(testRequest({
      providerName: "p",
      provider: { api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-x" },
      model: {},
    }));
    assert.equal(noModel.status, 400);
    assert.equal((await noModel.json()).ok, false);
  });
});

test("上游不可达：错误文案带出连接级原因（不是孤零零的 fetch failed）", async () => {
  await withAgentDir(async () => {
    // 先在回环上占一个随机端口再关掉：保证该端口确定没人监听 → ECONNREFUSED
    const closedPort = await new Promise((resolve) => {
      const probe = createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    const res = await POST(testRequest({
      providerName: "unreachable",
      provider: { api: "openai-completions", baseUrl: `http://127.0.0.1:${closedPort}/v1`, apiKey: "sk-x" },
      model: { id: "some-model" },
    }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.match(body.error, /fetch failed/);
    assert.match(body.error, /ECONNREFUSED|ECONNRESET/);
    assert.match(body.error, new RegExp(`127\\.0\\.0\\.1:${closedPort}`));
  });
});

test("上游返回非 JSON：不崩，正文片段回给界面", async () => {
  await withAgentDir(async () => {
    await withStubServer((req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "upstream boom" } }));
    }, async (baseUrl) => {
      const res = await POST(testRequest({
        providerName: "stub",
        provider: { api: "openai-completions", baseUrl: `${baseUrl}/v1`, apiKey: "sk-x" },
        model: { id: "m1" },
      }));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.status, 502);
      assert.match(body.error, /upstream boom/);
    });

    // 纯文本 500（Next 风格）：正文照样带回来
    await withStubServer((req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal Server Error");
    }, async (baseUrl) => {
      const res = await POST(testRequest({
        providerName: "stub-text",
        provider: { api: "openai-completions", baseUrl: `${baseUrl}/v1`, apiKey: "sk-x" },
        model: { id: "m1" },
      }));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(body.status, 500);
      assert.match(body.error, /Internal Server Error/);
    });
  });
});

test("上游成功：返回耗时与响应正文", async () => {
  await withAgentDir(async () => {
    await withStubServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    }, async (baseUrl) => {
      const res = await POST(testRequest({
        providerName: "stub-ok",
        provider: { api: "openai-completions", baseUrl: `${baseUrl}/v1`, apiKey: "sk-x" },
        model: { id: "m1" },
      }));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.responseText, "OK");
      assert.equal(typeof body.latencyMs, "number");
    });
  });
});

test("服务器现值补全：客户端只带掩码时用 models.json 里的 apiKey", async () => {
  await withAgentDir(async (dir) => {
    let seenAuth;
    await withStubServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    }, async (baseUrl) => {
      writeFileSync(join(dir, "models.json"), JSON.stringify({
        providers: {
          "masked": { api: "openai-completions", baseUrl: `${baseUrl}/v1`, apiKey: "sk-from-file" },
        },
      }), "utf8");
      const res = await POST(testRequest({
        providerName: "masked",
        provider: { api: "openai-completions", baseUrl: `${baseUrl}/v1`, apiKey: "***" },
        model: { id: "m1" },
      }));
      assert.equal((await res.json()).ok, true);
      assert.equal(seenAuth, "Bearer sk-from-file");
    });
  });
});
