import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSessionService } = await jiti.import("./session-service.ts");
const { createMarkdownTransformerChain } = await jiti.import("./extension-markdown-transformers.ts");

/** 一个带「用户 → 助手（正文 + 思考）」的最小会话文件，外加窗口外的前置消息。 */
function writeFixture(dir) {
  const filePath = join(dir, "session.jsonl");
  const entries = [
    { type: "session", version: 3, id: "qa-md-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir },
    { type: "message", id: "u0", parentId: null, timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "窗口外的问题" }], timestamp: "2026-01-01T00:00:01.000Z" } },
    { type: "message", id: "a0", parentId: "u0", timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "窗口外的回答" }], timestamp: "2026-01-01T00:00:02.000Z" } },
    { type: "message", id: "u1", parentId: "a0", timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "user", content: [{ type: "text", text: "窗口内的问题" }], timestamp: "2026-01-01T00:00:03.000Z" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:04.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "窗口内的思考" },
          { type: "text", text: "窗口内的回答" },
        ],
        timestamp: "2026-01-01T00:00:04.000Z",
      } },
  ];
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return filePath;
}

test("getContextPage：markdown 转换器只作用于**切片后的窗口**，且上下文按调用点给（issue #106）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-md-window-"));
  try {
    const filePath = writeFixture(dir);
    const seen = [];
    const chain = createMarkdownTransformerChain([(markdown, ctx) => {
      seen.push({ markdown, ...ctx });
      return `<${markdown}>`;
    }]);
    // live 宿主：宽度与流式状态都从这里来（32 列 + 正在流式输出）。
    const live = {
      isAlive: () => true,
      sessionFile: filePath,
      getMarkdownTransformers: () => chain.transformers,
      getRenderWidth: () => 32,
      isStreaming: () => true,
    };
    const service = createSessionService({
      resolveSessionPath: async () => filePath,
      getRpcSession: () => live,
      resolveMarkdownTransformers: async () => chain,
    });

    const page = await service.getContextPage("qa-md-session", { limit: 2 });
    const messages = page.context.messages;

    assert.deepEqual(seen.map((call) => call.markdown), ["窗口内的问题", "窗口内的思考", "窗口内的回答"],
      "只跑窗口内的消息（窗口外的两条不该出现）");
    assert.deepEqual(seen.map((call) => call.messageType), ["user", "assistant-thinking", "assistant"]);
    assert.deepEqual(seen.map((call) => call.availableWidth), [32, 32, 32], "宽度取宿主上报值");
    assert.deepEqual(seen.map((call) => call.isStreaming), [false, true, true],
      "只有窗口末尾那条（entryId 命中）算流式");
    assert.equal(messages[0].content[0].text, "<窗口内的问题>");
    assert.equal(messages[1].content[0].thinking, "<窗口内的思考>");
    assert.equal(messages[1].content[1].text, "<窗口内的回答>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getContextPage：没有转换器 / 解析失败时投影原样返回（不制造失败）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-md-none-"));
  try {
    const filePath = writeFixture(dir);
    const base = { resolveSessionPath: async () => filePath, getRpcSession: () => undefined };

    const withoutChain = createSessionService({ ...base, resolveMarkdownTransformers: async () => null });
    const plain = await withoutChain.getContextPage("qa-md-session", { limit: 2 });
    assert.equal(plain.context.messages[0].content[0].text, "窗口内的问题", "没有转换器 → 原文");

    const failing = createSessionService({
      ...base,
      resolveMarkdownTransformers: async () => {
        throw new Error("plugin load exploded");
      },
    });
    const survived = await failing.getContextPage("qa-md-session", { limit: 2 });
    assert.equal(survived.context.messages[0].content[0].text, "窗口内的问题", "解析失败也不能让只读投影失败");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transformContextMarkdown：首屏路由自己切完尾页后调它，没有转换器时原样（issue #106）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-md-route-"));
  try {
    const filePath = writeFixture(dir);
    const chain = createMarkdownTransformerChain([(markdown) => `[${markdown}]`]);
    const live = {
      isAlive: () => true,
      sessionFile: filePath,
      getMarkdownTransformers: () => chain.transformers,
      getRenderWidth: () => 100,
      isStreaming: () => false,
    };
    const service = createSessionService({
      resolveSessionPath: async () => filePath,
      getRpcSession: () => live,
      resolveMarkdownTransformers: async () => chain,
    });

    const sliced = { messages: [{ role: "user", content: "路由已切好的窗口" }], entryIds: ["u1"] };
    const transformed = await service.transformContextMarkdown("qa-md-session", sliced);
    assert.equal(transformed.messages[0].content, "[路由已切好的窗口]");

    const none = createSessionService({
      resolveSessionPath: async () => filePath,
      getRpcSession: () => undefined,
      resolveMarkdownTransformers: async () => null,
    });
    const untouched = await none.transformContextMarkdown("qa-md-session", sliced);
    assert.equal(untouched, sliced, "没有转换器时原样返回同一个对象");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getEntryThinking：按需加载的思考正文也过转换器（首屏 deferThinking 之后的唯一入口）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-md-thinking-"));
  try {
    const filePath = writeFixture(dir);
    const chain = createMarkdownTransformerChain([(markdown, ctx) => `<${ctx.messageType}:${markdown}>`]);
    const live = {
      isAlive: () => true,
      sessionFile: filePath,
      getMarkdownTransformers: () => chain.transformers,
      getRenderWidth: () => 40,
      isStreaming: () => true,
    };
    const service = createSessionService({
      resolveSessionPath: async () => filePath,
      getRpcSession: () => live,
      resolveMarkdownTransformers: async () => chain,
    });

    const result = await service.getEntryThinking("qa-md-session", "a1", 0);
    assert.equal(result.thinking, "<assistant-thinking:窗口内的思考>",
      "历史块按 assistant-thinking 转换，且 isStreaming 不谎报（恒 false）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("源文件自检：装饰性——确认新模块确实被 session-service 引用（防止接线被删）", () => {
  const source = readFileSync(new URL("./session-service.ts", import.meta.url), "utf8");
  assert.match(source, /applyMarkdownTransformToContext\(context/);
  assert.match(source, /transformMarkdownOnce\(\{/);
  assert.match(source, /resolveMarkdownChainForSession\(/);
});
