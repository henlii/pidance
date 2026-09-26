/**
 * 流式消息的 markdown 转换（issue #106 的第二条渲染边界）。
 *
 * 进行中的助手消息**还没入库**（SDK 在 `message_end` 之后才 appendMessage），所以
 * `buildSessionContext` / 投影窗口里根本没有它 —— 只接投影那条边界的话，整段生成
 * （含流式思考块）都不经过插件转换器，用户看到的始终是原文。
 *
 * 这里直接喂 `handleSessionEvent`，断言的是**发出去的那份副本**：文本被转换、
 * `isStreaming` 按「流式中 / 结束帧」给、原文对象没被改（不写回 SessionManager ⇒ 不双应用）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startSdkSessionHost } = await jiti.import("./sdk-session-host.ts");
const { createMarkdownTransformerChain, invalidateMarkdownTransformCache } = await jiti.import(
  "./extension-markdown-transformers.ts",
);

async function withHost(resolver, run) {
  const cwd = mkdtempSync(join(tmpdir(), "sdk-host-md-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "sdk-host-md-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "__new__stream_md",
      sessionFile: "",
      cwd,
      agentDir,
      toolNames: [], // 无工具，避免扩展噪音
      idleTimeoutMs: 60_000,
      markdownChainResolver: resolver,
    });
    await run(host);
  } finally {
    try {
      await host?.destroyAsync?.();
    } catch {
      /* 已销毁 */
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("流式消息：message_update 按流式转、message_end 按非流转，且绝不改原文（issue #106）", async () => {
  const seen = [];
  const chain = createMarkdownTransformerChain([(markdown, context) => {
    seen.push({ markdown, ...context });
    return `<${markdown}>`;
  }]);

  await withHost(async () => chain, async (host) => {
    const emitted = [];
    const unsubscribe = host.onEvent((event) => emitted.push(event));

    // 进行中的助手消息：正文 + 思考块（思考正文在 SSE 消息里，不走 deferThinking）。
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "流式思考" },
        { type: "text", text: "流式正文" },
      ],
    };
    host.handleSessionEvent({ type: "message_update", message });
    host.handleSessionEvent({ type: "message_end", message });

    const updates = emitted.filter((event) => event.type === "message_update");
    const ends = emitted.filter((event) => event.type === "message_end");
    assert.equal(updates.length, 1);
    assert.equal(ends.length, 1);

    // 发出去的是**转换后的副本**：流式帧与结束帧都要转（TUI 的最终渲染同样以非流转一次）。
    assert.equal(updates[0].message.content[0].thinking, "<流式思考>");
    assert.equal(updates[0].message.content[1].text, "<流式正文>");
    assert.equal(ends[0].message.content[1].text, "<流式正文>");
    assert.notEqual(updates[0].message, message, "发出去的必须是副本");

    // 上下文：正文按 assistant、思考按 assistant-thinking；流式帧 true、结束帧 false。
    assert.deepEqual(
      seen.map((call) => [call.messageType, call.isStreaming]),
      [["assistant-thinking", true], ["assistant", true], ["assistant-thinking", false], ["assistant", false]],
      "每帧按真实 isStreaming 转换，结束帧以非流转一次",
    );
    assert.ok(seen.every((call) => call.availableWidth > 0), "宽度取客户端上报值（默认桥宽）");

    // 原文一字未改：写回 SessionManager 会让读盘投影再转一次（双应用）。
    assert.equal(message.content[0].thinking, "流式思考");
    assert.equal(message.content[1].text, "流式正文");

    unsubscribe();
  });
});

test("流式消息：用户消息按 user 转换（与投影同口径），非消息事件不碰（issue #106）", async () => {
  const chain = createMarkdownTransformerChain([(markdown, context) => `[${context.messageType}]${markdown}`]);
  await withHost(async () => chain, async (host) => {
    const emitted = [];
    const unsubscribe = host.onEvent((event) => emitted.push(event));

    host.handleSessionEvent({ type: "message_update", message: { role: "user", content: "用户的话" } });
    const userUpdate = emitted.filter((event) => event.type === "message_update").at(-1);
    assert.equal(userUpdate.message.content, "[user]用户的话");

    // 工具事件不该被这条路径碰（它们走 tool display meta / 渲染桥）。
    host.handleSessionEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1", args: {} });
    const toolStart = emitted.filter((event) => event.type === "tool_execution_start").at(-1);
    assert.equal(toolStart.toolName, "bash");
    assert.equal(toolStart.message, undefined);

    unsubscribe();
  });
});

test("流式消息：mermaid 围栏原样留给客户端渲染（宿主不拼 SDK 的 ASCII mermaid 转换器）", async () => {
  // 恒等转换器：如果宿主在链首拼了 SDK 的 mermaid 转换器，围栏会被换成 ASCII 图。
  const chain = createMarkdownTransformerChain([(markdown) => markdown]);
  await withHost(async () => chain, async (host) => {
    const emitted = [];
    const unsubscribe = host.onEvent((event) => emitted.push(event));
    const fence = "```mermaid\ngraph TD;\n  A-->B;\n```";
    host.handleSessionEvent({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: fence }] },
    });
    const update = emitted.filter((event) => event.type === "message_update").at(-1);
    assert.equal(update.message.content[0].text, fence,
      "围栏原样传下去 —— Web 端用真 mermaid 渲染，不是终端 ASCII 图（有意分叉）");
    unsubscribe();
  });
});

test("流式消息：插件失效后不再用旧链改写；重新解析落地后按新链（issue #106 审查 P1）", async () => {
  let chain = createMarkdownTransformerChain([(markdown) => `OLD[${markdown}]`]);
  let resolveCalls = 0;
  await withHost(async () => {
    resolveCalls += 1;
    return chain;
  }, async (host) => {
    const emitted = [];
    const unsubscribe = host.onEvent((event) => emitted.push(event));
    const text = () => emitted.filter((event) => event.type === "message_update").at(-1).message.content[0].text;

    host.handleSessionEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "第一帧" }] } });
    assert.equal(text(), "OLD[第一帧]", "启动时解析出的链先生效");
    const callsBeforeInvalidate = resolveCalls;

    // 卸载插件：模块缓存失效（世代号自增），磁盘上已经没有转换器了。
    chain = null;
    invalidateMarkdownTransformCache();
    host.handleSessionEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "卸载后" }] } });
    assert.equal(text(), "卸载后", "失效后宁可原文，也不再用已卸载插件的那份旧链");

    // 等重解析落地：仍然没有转换器 → 依旧原文（但代码已经换成新解析结果）。
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(resolveCalls > callsBeforeInvalidate, "失效后必须重新解析（不能一直用手里那份）");
    host.handleSessionEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "重解析后" }] } });
    assert.equal(text(), "重解析后");

    // 重新装上一个插件（换成新链）后必须按新链走。
    chain = createMarkdownTransformerChain([(markdown) => `NEW[${markdown}]`]);
    invalidateMarkdownTransformCache();
    await new Promise((resolve) => setTimeout(resolve, 30));
    host.handleSessionEvent({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "新插件" }] } });
    assert.equal(text(), "NEW[新插件]");

    unsubscribe();
  });
});
