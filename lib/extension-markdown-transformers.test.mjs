/**
 * 插件 markdown 转换器（issue #106）单测。
 *
 * 重点不是「函数能不跑」，而是**与 SDK 的语义一致**：链式传递、非字符串忽略、
 * 抛错只跳过这一个；上下文（messageType / isStreaming / availableWidth）按调用点给对；
 * 缓存键把「内容 / 宽度 / 流式状态 / 类型 / 插件版本」都算进去。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  applyMarkdownTransformers,
  collectMarkdownTransformers,
  createMarkdownTransformerChain,
  fingerprintTransformers,
  hashContent,
  invalidateMarkdownTransformCache,
  resolveMarkdownTransformerChain,
  transformContextMarkdown,
  transformMarkdownOnce,
  MARKDOWN_TRANSFORM_MEMO_MAX,
} = await jiti.import("./extension-markdown-transformers.ts");

function context(overrides = {}) {
  return { messageType: "assistant", isStreaming: false, availableWidth: 100, ...overrides };
}

// ── 收集 ──────────────────────────────────────────────────────────────────
test("收集：按扩展顺序取 markdownTransformer，非函数与缺失一律跳过", () => {
  const a = () => "a";
  const b = () => "b";
  const transformers = collectMarkdownTransformers([
    { markdownTransformer: a },
    {},                                   // 没注册
    { markdownTransformer: "not-a-fn" },  // 写坏了
    { markdownTransformer: b },
    null,
  ]);
  assert.deepEqual(transformers, [a, b], "顺序与 SDK 的 flatMap 一致，坏的跳过而不是整批失败");
});

test("收集：空扩展列表 → 空数组（调用方据此零成本跳过）", () => {
  assert.deepEqual(collectMarkdownTransformers([]), []);
});

// ── 链式应用（与 SDK 的 applyMarkdownTransformers 逐条对齐）────────────────
test("应用：按顺序链式传递，后一个拿到前一个的输出", () => {
  const seen = [];
  const first = (markdown) => {
    seen.push(markdown);
    return markdown + "-1";
  };
  const second = (markdown) => {
    seen.push(markdown);
    return markdown + "-2";
  };
  assert.equal(applyMarkdownTransformers("x", context(), [first, second]), "x-1-2");
  assert.deepEqual(seen, ["x", "x-1"], "第二个转换器拿到的是第一个的输出");
});

test("应用：返回非字符串被忽略（保持当前值），不是变成 undefined", () => {
  const bad = () => undefined;
  const bad2 = () => 42;
  const good = (markdown) => markdown + "!";
  assert.equal(applyMarkdownTransformers("x", context(), [bad, bad2, good]), "x!");
  assert.equal(applyMarkdownTransformers("x", context(), [bad, bad2]), "x");
});

test("应用：抛错只跳过这一个，后面的转换器继续跑（SDK 的语义）", () => {
  const boom = () => {
    throw new Error("plugin exploded");
  };
  const good = (markdown) => markdown + "+ok";
  assert.equal(applyMarkdownTransformers("x", context(), [boom, good]), "x+ok");
  assert.equal(applyMarkdownTransformers("x", context(), [good, boom]), "x+ok");
});

// 有意分叉的护栏（见 docs/ui-vs-tui.md）：SDK 的链首还有一个 mermaid 转换器，它把 ```mermaid
// 围栏换成本地渲染的 ASCII 图（实测输出形如 ` ┌───┐` 的行内 code span，还按 availableWidth 裁剪）。
// Web 端由 components/MarkdownBody.tsx 用真 mermaid 渲染 SVG，接上它会把围栏换掉、把更好的路径挡死。
// 这条断言保证「没人把那个转换器接进这条链」—— 一旦接上，围栏会被破坏，这里立刻变红。
test("有意分叉：解析出来的链只有扩展转换器，mermaid 围栏原样通过（不接 SDK 的 ASCII 图转换器）", async () => {
  const markdown = "before\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n\nafter\n";
  const identity = (text) => text;
  const chain = await resolveMarkdownTransformerChain({
    cwd: "/tmp/mermaid-parity",
    loaderFactory: loaderWith([{ markdownTransformer: identity }], { calls: 0 }),
    bypassCache: true,
  });
  assert.ok(chain, "有转换器就该有链");
  assert.deepEqual(chain.transformers, [identity], "链里**只有**扩展注册的那一个（不掺 SDK 的 mermaid 转换器）");
  const result = applyMarkdownTransformers(markdown, context(), chain.transformers);
  assert.equal(result, markdown, "围栏必须原样保留 —— SDK 那个转换器会把它换成 ASCII 图");
  assert.ok(!/[\u250c\u2500\u2502\u2514\u2518]/.test(result), "不该出现本地渲染的盒线字符");
  assert.ok(result.includes("```mermaid"), "围栏本身要留住，客户端才有得渲染");
});

// ── 链解析与缓存 ──────────────────────────────────────────────────────────
/**
 * 注入用的 loader **工厂**（契约是 `(cwd, agentDir) => loader`，不是 loader 本身 ——
 * 直接传 loader 会被当成返回值而不是回调，加载失败降级成 null，测试会以「没有链」的形式失败）。
 */
function loaderWith(extensions, counter) {
  return () => () => {
    counter.calls += 1;
    return Promise.resolve({
      extensions,
      runtime: {},
      errors: [],
    });
  };
}

test("链解析：没有扩展注册转换器 → null（调用方零成本跳过）", async () => {
  const counter = { calls: 0 };
  const chain = await resolveMarkdownTransformerChain({
    cwd: "/tmp/x",
    loaderFactory: loaderWith([{ markdownTransformer: undefined }], counter),
    bypassCache: true,
  });
  assert.equal(chain, null);
  assert.equal(counter.calls, 1, "还是要加载一次才知道没有");
});

test("链解析：有注册 → 链 + 可用指纹；空数组构造链也返回 null", async () => {
  const fn = (markdown) => markdown;
  const chain = await resolveMarkdownTransformerChain({
    cwd: "/tmp/x",
    loaderFactory: loaderWith([{ markdownTransformer: fn }], { calls: 0 }),
    bypassCache: true,
  });
  assert.ok(chain, "有转换器就要有链");
  assert.deepEqual(chain.transformers, [fn]);
  assert.equal(typeof chain.fingerprint, "string");
  assert.ok(chain.fingerprint.length > 0);
  assert.equal(createMarkdownTransformerChain([]), null, "空链按「没有」处理");
});

test("链解析：加载失败 → null，不抛", async () => {
  const chain = await resolveMarkdownTransformerChain({
    cwd: "/tmp/x",
    loaderFactory: () => () => Promise.reject(new Error("loader down")),
    bypassCache: true,
  });
  assert.equal(chain, null);
});

test("链缓存：同一 (cwd, agentDir) 只加载一次；bypassCache 每次都加载", async () => {
  const counter = { calls: 0 };
  const loaderFactory = loaderWith([{ markdownTransformer: (m) => m }], counter);
  const options = { cwd: "/tmp/cache-key", loaderFactory };
  await resolveMarkdownTransformerChain(options);
  await resolveMarkdownTransformerChain(options);
  assert.equal(counter.calls, 1, "第二次应命中链缓存");
  await resolveMarkdownTransformerChain({ ...options, bypassCache: true });
  assert.equal(counter.calls, 2, "bypassCache 必须真的重新加载");
});

test("链缓存：失效入口后重新加载", async () => {
  const counter = { calls: 0 };
  const options = {
    cwd: "/tmp/cache-key-invalidate",
    loaderFactory: loaderWith([{ markdownTransformer: (m) => m }], counter),
  };
  await resolveMarkdownTransformerChain(options);
  invalidateMarkdownTransformCache();
  await resolveMarkdownTransformerChain(options);
  assert.equal(counter.calls, 2, "失效后必须重新解析（插件可能刚换过）");
});

// ── 指纹与内容 hash ──────────────────────────────────────────────────────
test("指纹：同一批函数稳定，换了函数就变（插件重载的判据）", () => {
  const a = (m) => m;
  const b = (m) => m;
  assert.equal(fingerprintTransformers([a, b]), fingerprintTransformers([a, b]));
  assert.notEqual(fingerprintTransformers([a]), fingerprintTransformers([b]));
});

test("hashContent：同内容稳定、不同内容不同、空串也有值", () => {
  assert.equal(hashContent("abc"), hashContent("abc"));
  assert.notEqual(hashContent("abc"), hashContent("abd"));
  assert.equal(typeof hashContent(""), "string");
});

// ── 单条变换的缓存键 ─────────────────────────────────────────────────────
test("单条缓存：同输入只跑一次；宽度 / 流式 / 类型 / 内容任一变化都重算", () => {
  const calls = [];
  const chain = createMarkdownTransformerChain([(markdown, ctx) => {
    calls.push(`${markdown}|${ctx.availableWidth}|${ctx.isStreaming}|${ctx.messageType}`);
    return markdown + "!";
  }]);
  invalidateMarkdownTransformCache();
  const base = { chain, messageId: "e1", markdown: "x", context: context() };
  assert.equal(transformMarkdownOnce(base), "x!");
  assert.equal(transformMarkdownOnce(base), "x!", "同输入应命中缓存");
  assert.equal(calls.length, 1, "缓存命中不该再跑插件代码");

  transformMarkdownOnce({ ...base, context: context({ availableWidth: 80 }) });
  transformMarkdownOnce({ ...base, context: context({ isStreaming: true }) });
  transformMarkdownOnce({ ...base, context: context({ messageType: "assistant-thinking" }) });
  transformMarkdownOnce({ ...base, markdown: "y" });
  transformMarkdownOnce({ ...base, messageId: "e2" });
  assert.equal(calls.length, 6, "宽度 / 流式 / 类型 / 内容 / 消息 id 都要区分（加上首次共 6 次）");
});

test("单条缓存：useCache=false 时每次都跑（反向验证用得到）", () => {
  let calls = 0;
  const chain = createMarkdownTransformerChain([(markdown) => {
    calls += 1;
    return markdown;
  }]);
  const base = { chain, messageId: "e1", markdown: "x", context: context(), useCache: false };
  transformMarkdownOnce(base);
  transformMarkdownOnce(base);
  assert.equal(calls, 2);
});

test("单条缓存：有界（插件把 API 当循环用也不会无界增长）", () => {
  const chain = createMarkdownTransformerChain([(markdown) => markdown]);
  invalidateMarkdownTransformCache();
  for (let i = 0; i < MARKDOWN_TRANSFORM_MEMO_MAX + 20; i += 1) {
    transformMarkdownOnce({ chain, messageId: "e" + i, markdown: "x", context: context() });
  }
  const memo = globalThis.__piPidanceMarkdownTransformMemo;
  assert.ok(memo && memo.size <= MARKDOWN_TRANSFORM_MEMO_MAX, `记忆化必须有界（实际 ${memo ? memo.size : "无"}）`);
});

test("单条缓存：失效入口清掉记忆化", () => {
  let calls = 0;
  const chain = createMarkdownTransformerChain([(markdown) => {
    calls += 1;
    return markdown;
  }]);
  const base = { chain, messageId: "e1", markdown: "x", context: context() };
  transformMarkdownOnce(base);
  invalidateMarkdownTransformCache();
  transformMarkdownOnce(base);
  assert.equal(calls, 2, "失效后必须重算");
});

// ── 上下文变换（渲染边界）────────────────────────────────────────────────
function chainOf(transformers) {
  const chain = createMarkdownTransformerChain(transformers);
  assert.ok(chain, "测试用的链不该是空的");
  return chain;
}

function recordingTransformer() {
  const calls = [];
  const transformer = (markdown, ctx) => {
    calls.push({ markdown, ...ctx });
    return `<${markdown}>`;
  };
  return { transformer, calls };
}

test("上下文：用户字符串正文按 user 变换，isStreaming 恒 false", () => {
  const { transformer, calls } = recordingTransformer();
  invalidateMarkdownTransformCache();
  const input = { messages: [{ role: "user", content: "hello" }], entryIds: ["e1"] };
  const output = transformContextMarkdown(input, { chain: chainOf([transformer]), availableWidth: 92 });
  assert.equal(output.messages[0].content, "<hello>");
  assert.deepEqual(calls, [{ markdown: "hello", messageType: "user", isStreaming: false, availableWidth: 92 }]);
  assert.equal(input.messages[0].content, "hello", "输入对象不能被改");
});

test("上下文：用户消息的块数组（文本块）也会变换", () => {
  const { transformer } = recordingTransformer();
  invalidateMarkdownTransformCache();
  const input = {
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", data: "x" }] }],
    entryIds: ["e1"],
  };
  const output = transformContextMarkdown(input, { chain: chainOf([transformer]), availableWidth: 100 });
  assert.equal(output.messages[0].content[0].text, "<hi>");
  assert.deepEqual(output.messages[0].content[1], { type: "image", data: "x" }, "非文本块不动");
});

test("上下文：助手正文按 assistant、思考块按 assistant-thinking，工具调用块不动", () => {
  const { transformer, calls } = recordingTransformer();
  invalidateMarkdownTransformCache();
  const input = {
    messages: [{
      role: "assistant",
      content: [
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "reasoning" },
        { type: "toolCall", id: "t1", name: "bash", arguments: {} },
      ],
    }],
    entryIds: ["e1"],
  };
  const output = transformContextMarkdown(input, { chain: chainOf([transformer]), availableWidth: 100 });
  assert.equal(output.messages[0].content[0].text, "<answer>");
  assert.equal(output.messages[0].content[1].thinking, "<reasoning>");
  assert.equal(output.messages[0].content[2].name, "bash", "工具调用块保持原样");
  assert.deepEqual(calls.map((call) => call.messageType), ["assistant", "assistant-thinking"]);
  assert.deepEqual(calls.map((call) => call.isStreaming), [false, false]);
});

// 审查 P1 改掉了这条语义：投影窗口里**谁都不算流式**。进行中的那条助手消息还没入库、
// 根本不在窗口里，窗口末尾通常是刚落盘的用户消息或上一条已结束的助手消息；宿主暴露的
// isStreaming() 是**整轮 run** 的标记，拿它标窗口末尾会把历史消息错标成流式。
// 真正的流式正文走 SSE 那条边界（lib/sdk-session-host.ts 的 withTransformedMessage）。
test("上下文：投影窗口里的消息一律不带 isStreaming（流式正文走 SSE 那条边界）", () => {
  const { transformer, calls } = recordingTransformer();
  invalidateMarkdownTransformCache();
  const input = {
    messages: [
      { role: "assistant", content: [{ type: "text", text: "old" }] },
      { role: "assistant", content: [{ type: "text", text: "live" }] },
    ],
    entryIds: ["e1", "e2"],
  };
  transformContextMarkdown(input, { chain: chainOf([transformer]), availableWidth: 100 });
  assert.deepEqual(
    calls.map((call) => ({ text: call.markdown, isStreaming: call.isStreaming })),
    [{ text: "old", isStreaming: false }, { text: "live", isStreaming: false }],
    "投影是已落盘的过去时：流式标记只由 SSE 边界给",
  );
});

test("上下文：toolResult / custom / 未知角色不动（SDK 只转换用户与助手的 markdown）", () => {
  const { transformer, calls } = recordingTransformer();
  invalidateMarkdownTransformCache();
  const input = {
    messages: [
      { role: "toolResult", content: [{ type: "text", text: "output" }] },
      { role: "custom", customType: "x", content: "custom body" },
      { role: "bashExecution", command: "ls" },
    ],
    entryIds: ["e1", "e2", "e3"],
  };
  const output = transformContextMarkdown(input, { chain: chainOf([transformer]), availableWidth: 100 });
  assert.equal(output, input, "什么都没改就返回原对象");
  assert.equal(calls.length, 0, "不该给这些角色跑转换器");
});

test("上下文：没有任何改动时返回原对象（不制造无谓的新引用）", () => {
  const chain = chainOf([(markdown) => markdown]);
  invalidateMarkdownTransformCache();
  const input = { messages: [{ role: "assistant", content: [{ type: "text", text: "same" }] }], entryIds: ["e1"] };
  assert.equal(transformContextMarkdown(input, { chain, availableWidth: 100 }), input);
});

test("上下文：空 / 畸形输入原样返回，不抛", () => {
  const chain = chainOf([(markdown) => markdown + "!"]);
  for (const value of [null, undefined, 42, "text", {}, { messages: "nope" }, { messages: [] }]) {
    assert.equal(transformContextMarkdown(value, { chain, availableWidth: 100 }), value);
  }
});

test("上下文：延迟加载的思考正文（thinking 为空串）不在这里变换，留给按需加载那条路径", () => {
  const { transformer, calls } = recordingTransformer();
  invalidateMarkdownTransformCache();
  const input = {
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "", deferred: true }] }],
    entryIds: ["e1"],
  };
  const output = transformContextMarkdown(input, { chain: chainOf([transformer]), availableWidth: 100 });
  assert.equal(output, input);
  assert.equal(calls.length, 0, "空正文不该触发转换器（否则会把空串变成插件给的东西）");
});

test("上下文：两个转换器链式作用在同一条消息上", () => {
  invalidateMarkdownTransformCache();
  const input = { messages: [{ role: "user", content: "x" }], entryIds: ["e1"] };
  const output = transformContextMarkdown(input, {
    chain: chainOf([(markdown) => markdown + "-1", (markdown) => markdown + "-2"]),
    availableWidth: 100,
  });
  assert.equal(output.messages[0].content, "x-1-2");
});

test("上下文：转换器抛错时该条退回原文（不影响其它消息）", () => {
  invalidateMarkdownTransformCache();
  const boom = () => {
    throw new Error("nope");
  };
  const input = {
    messages: [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ],
    entryIds: ["e1", "e2"],
  };
  const output = transformContextMarkdown(input, { chain: chainOf([boom]), availableWidth: 100 });
  assert.equal(output, input, "全是原文 → 原对象");
  assert.equal(output.messages[0].content, "first");
});
