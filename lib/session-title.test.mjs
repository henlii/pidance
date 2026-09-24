import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  appendTitleRequestToTrailingUser,
  boundTitleMessages,
  generateSessionTitleFromMessages,
  parseGeneratedSessionTitle,
  resolveTitleModelConfig,
} = await jiti.import("./session-title.ts");

function jsonResponse(json) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(json),
  };
}

test("cleans common session title response wrappers", () => {
  assert.equal(parseGeneratedSessionTitle("标题：修复 SSE 重连。"), "修复 SSE 重连");
  assert.equal(parseGeneratedSessionTitle('```json\n{"title":"整理 Session 文件夹"}\n```'), "整理 Session 文件夹");
  assert.equal(parseGeneratedSessionTitle('"Improve worktree session grouping"'), "Improve worktree session grouping");
});

test("rejects responses without a usable title", () => {
  assert.throws(() => parseGeneratedSessionTitle("```\n---\n```"), /usable session title/);
});

test("folds the title request into a trailing user message without mutating the source", () => {
  const source = [
    { role: "assistant", content: [], timestamp: 1 },
    { role: "user", content: [{ type: "text", text: "Fix the running-session race" }], timestamp: 2 },
  ];

  const prepared = appendTitleRequestToTrailingUser(source);

  assert.deepEqual(prepared.map((message) => message.role), ["assistant", "user"]);
  assert.match(prepared[1].content.at(-1).text, /Create a concise title/);
  assert.equal(source[1].content.length, 1);
  assert.notEqual(prepared[1], source[1]);
});

test("leaves a completed conversation unchanged before adding the title turn", () => {
  const source = [
    { role: "user", content: "Fix it", timestamp: 1 },
    { role: "assistant", content: [], timestamp: 2 },
  ];

  assert.equal(appendTitleRequestToTrailingUser(source), source);
});

test("rejects sessions without user messages", async () => {
  await assert.rejects(
    () =>
      generateSessionTitleFromMessages({
        messages: [{ role: "assistant", content: "hello" }],
        provider: "test",
        modelId: "test-model",
        baseUrl: "https://api.example.com",
        apiKey: "secret",
      }),
    /no user messages/,
  );
});

test("posts chat completions and parses the title from the assistant reply", async () => {
  let capturedUrl;
  let capturedBody;
  let capturedHeaders;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    capturedHeaders = init.headers;
    return jsonResponse({
      choices: [{ message: { content: "标题：修复 SSE 重连。" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  };
  try {
    const result = await generateSessionTitleFromMessages({
      messages: [
        { role: "user", content: "修复 SSE 重连" },
        { role: "assistant", content: [{ type: "text", text: "已完成" }] },
      ],
      provider: "test",
      modelId: "test-model",
      baseUrl: "https://api.example.com/",
      apiKey: "secret",
      headers: { "x-custom": "1" },
    });

    assert.equal(capturedUrl, "https://api.example.com/chat/completions");
    assert.equal(capturedHeaders.authorization, "Bearer secret");
    assert.equal(capturedHeaders["x-custom"], "1");
    assert.equal(capturedHeaders["content-type"], "application/json");
    assert.equal(capturedBody.model, "test-model");
    assert.equal(capturedBody.max_tokens, 64);
    // 末条 assistant：追加一条标题请求 user 消息
    assert.deepEqual(capturedBody.messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.match(capturedBody.messages.at(-1).content, /Create a concise title/);
    assert.equal(result.title, "修复 SSE 重连");
    assert.deepEqual(result.usage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("folds the title prompt into a trailing user message (no consecutive users)", async () => {
  let capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return jsonResponse({ choices: [{ message: { content: "Auto name" } }] });
  };
  try {
    await generateSessionTitleFromMessages({
      messages: [
        { role: "user", content: "修复 SSE 重连" },
        { role: "assistant", content: "已完成" },
        { role: "user", content: "再修复 worktree 分组" },
      ],
      provider: "test",
      modelId: "test-model",
      baseUrl: "https://api.example.com",
      apiKey: "secret",
    });

    assert.deepEqual(capturedBody.messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.match(capturedBody.messages.at(-1).content, /再修复 worktree 分组[\s\S]*Create a concise title/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfaces provider HTTP errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => "rate limited" });
  try {
    await assert.rejects(
      () =>
        generateSessionTitleFromMessages({
          messages: [{ role: "user", content: "x" }],
          provider: "test",
          modelId: "test-model",
          baseUrl: "https://api.example.com",
          apiKey: "secret",
        }),
      /rate limited/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveTitleModelConfig reads settings + models.json for the default model", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-title-"));
  try {
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ defaultProvider: "zenmux", defaultModel: "claude-sonnet-4-6" }),
    );
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        providers: {
          zenmux: {
            apiKey: "${TITLE_TEST_API_KEY}",
            baseUrl: "https://zenmux.example.com/v1",
            headers: { "x-provider": "zenmux" },
            models: [{ id: "claude-sonnet-4-6", api: "openai-completions", headers: { "x-model": "cs" } }],
          },
        },
      }),
    );
    process.env.TITLE_TEST_API_KEY = "env-secret";

    const config = resolveTitleModelConfig({
      settingsPath: join(dir, "settings.json"),
      modelsPath: join(dir, "models.json"),
    });

    assert.equal(config.provider, "zenmux");
    assert.equal(config.modelId, "claude-sonnet-4-6");
    assert.equal(config.baseUrl, "https://zenmux.example.com/v1");
    assert.equal(config.api, "openai-completions");
    assert.equal(config.apiKey, "env-secret");
    assert.deepEqual(config.headers, { "x-provider": "zenmux", "x-model": "cs" });
  } finally {
    delete process.env.TITLE_TEST_API_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveTitleModelConfig fails without a default model", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-title-"));
  try {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({}));
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: {} }));
    assert.throws(
      () =>
        resolveTitleModelConfig({
          settingsPath: join(dir, "settings.json"),
          modelsPath: join(dir, "models.json"),
        }),
      /No default model configured/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 有界标题输入（命名请求不再随会话长度线性膨胀） ─────────────────────────

const msg = (role, text) => ({ role, content: [{ type: "text", text }] });
const transcriptLength = (messages) =>
  messages.reduce((sum, m) => sum + Array.from(String(m.content)).length, 0);

test("boundTitleMessages：逐条限长（user 800 / 回复 300 / 末条回复 600）", () => {
  const messages = boundTitleMessages([
    msg("user", "u".repeat(2000)),
    msg("assistant", "a".repeat(2000)),
    msg("user", "q2"),
    msg("assistant", "b".repeat(2000)),
  ]);
  assert.equal(messages.length, 4);
  assert.equal(Array.from(String(messages[0].content)).length, 801, "user 截到 800 + 省略号");
  assert.equal(Array.from(String(messages[1].content)).length, 301, "中间回复截到 300 + 省略号");
  assert.equal(Array.from(String(messages[3].content)).length, 601, "末条回复保留 600 + 省略号");
});

test("boundTitleMessages：总量有上界，且首轮内容保留", () => {
  const messages = [];
  for (let i = 0; i < 400; i++) {
    messages.push(msg("user", `TURN-${i} ${"u".repeat(500)}`));
    messages.push(msg("assistant", `${"a".repeat(400)}`));
  }
  const bounded = boundTitleMessages(messages);
  assert.ok(transcriptLength(bounded) <= 6000, `总长应 ≤ 6000，实际 ${transcriptLength(bounded)}`);
  assert.match(String(bounded[0].content), /TURN-0/, "首轮提问必须保留（标题要的是会话目标）");
  assert.ok(bounded.length >= 2, "不是只留一条");
  assert.ok(
    bounded.some((m) => String(m.content).includes("[…]")),
    "丢掉中段时要留省略标记",
  );
});

test("boundTitleMessages：短会话原样保留（不截断、不插省略号）", () => {
  const messages = [msg("user", "修 SSE 重连"), msg("assistant", "已修")];
  const bounded = boundTitleMessages(messages);
  assert.equal(bounded.length, 2);
  assert.equal(bounded[0].content, "修 SSE 重连");
  assert.ok(!bounded.some((m) => String(m.content).includes("[…]")));
});

test("boundTitleMessages：丢弃 toolResult 与空文本，非 user/assistant 不进标题输入", () => {
  const bounded = boundTitleMessages([
    msg("user", "问题"),
    { role: "toolResult", content: [{ type: "text", text: "工具输出" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "t" }] },
    msg("assistant", "回答"),
  ]);
  assert.deepEqual(bounded.map((m) => m.role), ["user", "assistant"]);
  assert.deepEqual(bounded.map((m) => m.content), ["问题", "回答"]);
});

test("generateSessionTitleFromMessages：120 轮会话的请求体仍是有界的", async () => {
  let capturedBody;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return jsonResponse({ choices: [{ message: { content: "长会话标题" } }] });
  };
  try {
    const messages = [];
    for (let i = 0; i < 120; i++) {
      messages.push({ role: "user", content: `第 ${i} 轮 ${"u".repeat(900)}` });
      messages.push({ role: "assistant", content: `${"a".repeat(900)}` });
    }
    await generateSessionTitleFromMessages({
      messages,
      provider: "test",
      modelId: "test-model",
      baseUrl: "https://api.example.com",
      apiKey: "secret",
    });

    const sent = capturedBody.messages.reduce((sum, m) => sum + Array.from(String(m.content)).length, 0);
    // 含末条折叠进去的标题指令在内，整个请求体 ≤ 6000（预算已把指令长度扣掉）
    assert.ok(sent <= 6000, `请求体应保持有界，实际 ${sent}`);
    assert.match(String(capturedBody.messages[0].content), /第 0 轮/, "首轮目标必须留在请求里");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
