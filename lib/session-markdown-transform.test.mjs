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
    // live 宿主只提供**宽度**（32 列）。转换器链一律按磁盘来源取（见下一条用例）：
    // 活宿主手里那份是绑定时的旧插件集，插件增删后不会重建。
    const live = {
      isAlive: () => true,
      sessionFile: filePath,
      getRenderWidth: () => 32,
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
    assert.deepEqual(seen.map((call) => call.isStreaming), [false, false, false],
      "投影窗口里的消息都不算流式：进行中的那条还没入库、不在窗口里；"
      + "宿主暴露的 isStreaming() 是整轮 run 的标记，拿它标窗口末尾会误标");
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

test("投影的链一律来自磁盘：活宿主还握着的那份旧链不会被用（插件卸载后立即失效，issue #106 审查 P1）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-md-stale-"));
  try {
    const filePath = writeFixture(dir);
    const oldChain = createMarkdownTransformerChain([(markdown) => `OLD[${markdown}]`]);
    // 活宿主仍然"握着"卸载前那批转换器 —— 旧实现把它们当权威，卸载后还会继续改写。
    const live = {
      isAlive: () => true,
      sessionFile: filePath,
      getMarkdownTransformers: () => oldChain.transformers,
      getRenderWidth: () => 80,
    };

    // 插件卸载之后的世界：磁盘链解析不到转换器（invalidateMarkdownTransformCache 已生效）。
    const uninstalled = createSessionService({
      resolveSessionPath: async () => filePath,
      getRpcSession: () => live,
      resolveMarkdownTransformers: async () => null,
    });
    const raw = await uninstalled.getContextPage("qa-md-session", { limit: 2 });
    assert.equal(raw.context.messages[0].content[0].text, "窗口内的问题",
      "卸载后投影按原文，不再应用旧链");
    assert.ok(!JSON.stringify(raw.context.messages).includes("OLD["), "旧链一次都不该被调用");

    // 装上新插件：磁盘链换成新的，投影跟着换（仍然不用活宿主手里那份）。
    const newChain = createMarkdownTransformerChain([(markdown) => `NEW[${markdown}]`]);
    const reinstalled = createSessionService({
      resolveSessionPath: async () => filePath,
      getRpcSession: () => live,
      resolveMarkdownTransformers: async () => newChain,
    });
    const fresh = await reinstalled.getContextPage("qa-md-session", { limit: 2 });
    assert.equal(fresh.context.messages[0].content[0].text, "NEW[窗口内的问题]",
      "用磁盘新链，而不是活宿主手里那份旧链");
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
      getRenderWidth: () => 100,
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
    const seen = [];
    const chain = createMarkdownTransformerChain([(markdown, ctx) => {
      seen.push({ markdown, ...ctx });
      return `<${ctx.messageType}:${markdown}>`;
    }]);
    const live = {
      isAlive: () => true,
      sessionFile: filePath,
      getRenderWidth: () => 40,
    };
    const service = createSessionService({
      resolveSessionPath: async () => filePath,
      getRpcSession: () => live,
      resolveMarkdownTransformers: async () => chain,
    });

    const result = await service.getEntryThinking("qa-md-session", "a1", 0);
    assert.equal(result.thinking, "<assistant-thinking:窗口内的思考>",
      "历史块按 assistant-thinking 转换");
    // 这一条以前只断言了输出字符串：isStreaming / availableWidth 传什么都绿（上下文其实没被锁住）。
    assert.deepEqual(seen, [{
      markdown: "窗口内的思考",
      messageType: "assistant-thinking",
      isStreaming: false,
      availableWidth: 40,
    }], "按需加载的思考正文：messageType 正确、isStreaming 不谎报、宽度取宿主上报值");
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
