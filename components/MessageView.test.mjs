import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

// SSR 渲染断言：初始状态即可验证卡片结构、回退与安全语义；
// 交互（copy/setTimeout）不在本测试范围。
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("../lib/i18n.tsx");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

function activityMessage(details, extra = {}) {
  return {
    role: "custom",
    customType: "pidance.activity",
    content: typeof details?.title === "string" ? details.title : "activity",
    display: true,
    details,
    ...extra,
  };
}

function validDetails(overrides = {}) {
  return {
    version: 1,
    kind: "result",
    title: "Deploy finished",
    content: "line1\nline2",
    ...overrides,
  };
}

test("pidance.activity：四种 kind 都走专用卡片，token 可见且色彩可区分", () => {
  const leftBorders = new Set();
  for (const kind of ["result", "warning", "error", "output"]) {
    const html = renderMessage(activityMessage(validDetails({ kind })));

    // section landmark + 数据枚举 kind token（非新增 UI 文案）
    assert.ok(html.includes(`aria-label="${kind}: Deploy finished"`), kind);
    assert.ok(html.includes(`>${kind}</span>`), kind);
    assert.ok(html.includes("Deploy finished"), kind);
    // 图标存在但 aria-hidden，不作为唯一 kind 区分
    assert.match(html, /<svg[^>]*aria-hidden="true"/, kind);

    const border = html.match(/border-left:2px solid ([^;]+);/);
    assert.ok(border, kind);
    leftBorders.add(border[1]);
  }
  assert.equal(leftBorders.size, 4, "四种 kind 的左边框色必须可区分");
});

test("pidance.activity：title/content 为纯文本，恶意 HTML/script 不注入", () => {
  const html = renderMessage(activityMessage(validDetails({
    title: "<img src=x onerror=alert(1)>",
    content: "<script>alert(2)</script>",
  })));

  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  // onerror 只允许作为转义文本出现，不允许是真实事件属性
  assert.doesNotMatch(html, /onerror="/);
  assert.ok(html.includes("&lt;script&gt;alert(2)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});

test("pidance.activity：content 换行保留在 pre-wrap 容器内", () => {
  const html = renderMessage(activityMessage(validDetails({ content: "line1\nline2" })));

  assert.ok(html.includes("line1\nline2"));
  assert.match(html, /<pre[^>]*white-space:pre-wrap/);
});

test("pidance.activity：长 content 不截断，内部滚动且键盘可达", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `row-${i}`);
  const html = renderMessage(activityMessage(validDetails({ kind: "output", content: lines.join("\n") })));

  assert.ok(html.includes("row-0"));
  assert.ok(html.includes("row-399"), "长内容不得截断");
  assert.match(html, /<pre[^>]*tabindex="0"/);
  assert.match(html, /max-height:min\(320px, 45vh\)/);
  assert.match(html, /overflow:auto/);
});

test("pidance.activity：source/requestId 展示，metadata 只取原始键值预览不整对象倾倒", () => {
  const html = renderMessage(activityMessage(validDetails({
    source: "deploy.sh",
    requestId: "req-abc-123",
    metadata: { url: "https://example.com", retries: 2, nested: { a: 1 } },
  })));

  assert.ok(html.includes("deploy.sh"));
  assert.ok(html.includes("req-abc-123"));
  assert.ok(html.includes("url=https://example.com"));
  assert.ok(html.includes("retries=2"));
  // 嵌套对象不倾倒
  assert.ok(!html.includes("nested"));
  assert.ok(!html.includes("&quot;a&quot;"));
});

test("pidance.activity：复制按钮复用现有 aria 文案", () => {
  const html = renderMessage(activityMessage(validDetails()));
  assert.ok(html.includes('aria-label="Copy message"'));
});

test("pidance.activity：非法 details 安全回退通用 custom view", () => {
  const cases = [
    null,
    "nope",
    validDetails({ version: 2 }),
    validDetails({ kind: "evil" }),
    validDetails({ title: "" }),
    { version: 1, kind: "result", content: "no title" },
  ];
  for (const details of cases) {
    const html = renderMessage(activityMessage(details));

    // 不出现专用卡片 landmark；回退到通用 custom view（header 显示 customType）
    assert.ok(!html.includes("<section"), JSON.stringify(details));
    assert.ok(html.includes(">pidance.activity</span>"), JSON.stringify(details));
    assert.ok(html.includes('aria-label="Show details"'), JSON.stringify(details));
  }
});

test("其它 customType 不误识别为 activity 卡片", () => {
  const message = {
    role: "custom",
    customType: "extension_debug",
    content: "debug payload",
    display: true,
    details: validDetails(),
  };
  const html = renderMessage(message);

  assert.ok(!html.includes("<section"));
  assert.ok(html.includes(">extension_debug</span>"));
});

test("custom 渲染桥：合法 ANSI 行优先，隐藏原始内容、详情与复制区", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension_notice",
    content: "原始文本",
    display: true,
    details: { raw: true },
    renderedLines: ["\u001b[33m⚠ 插件控制提示\u001b[0m", "第二行"],
  });

  assert.ok(html.includes(">extension_notice</span>"));
  assert.ok(html.includes("⚠ 插件控制提示"));
  assert.ok(html.includes("第二行"));
  assert.ok(!html.includes("原始文本"));
  assert.ok(!html.includes("&quot;raw&quot;"));
  assert.ok(!html.includes('aria-label="Copy message"'));
  assert.ok(!html.includes('aria-label="Show details"'));
  assert.match(html, /font-family:var\(--font-mono\)/);
  assert.match(html, /white-space:pre-wrap/);
});

test("custom 渲染桥：空数组和非法载荷回退现有文本与详情逻辑", () => {
  for (const renderedLines of [[], ["合法行", 42], "非法载荷"]) {
    const html = renderMessage({
      role: "custom",
      customType: "extension_notice",
      content: "回退文本",
      display: true,
      details: { fallback: true },
      renderedLines,
    });

    assert.ok(html.includes("回退文本"));
    assert.ok(html.includes('aria-label="Copy message"'));
    assert.ok(html.includes('aria-label="Show details"'));
  }
});

test("custom fallback 语义保持：compaction 仍走专用压缩卡片", () => {
  const message = {
    role: "custom",
    customType: "compaction",
    content: "summary body",
    display: true,
    details: { tokensBefore: 100, firstKeptEntryId: "x" },
  };
  const html = renderMessage(message);

  assert.ok(html.includes("Conversation compacted"));
  assert.ok(!html.includes(">pidance.activity</span>"));
});

test("源码契约：MessageView 不使用 dangerouslySetInnerHTML", () => {
  const source = readFileSync(fileURLToPath(new URL("./MessageView.tsx", import.meta.url)), "utf8");
  assert.ok(!source.includes("dangerouslySetInnerHTML"));
});

function toolMessage(command = "fallback command") {
  return {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "tool-1", toolName: "bash", input: { command } }],
  };
}

test("实时工具：运行中默认展开终端输出，并优先展示快照命令", () => {
  const html = renderMessage(toolMessage(), {
    toolExecutionSnapshots: [{
      toolCallId: "tool-1",
      toolName: "bash",
      command: "npm run lint -- --fix",
      output: "checking\nfinished",
      startedAt: Date.now() - 1250,
      status: "running",
      truncated: true,
    }],
  });

  assert.ok(html.includes('aria-expanded="true"'));
  assert.ok(html.includes("npm run lint -- --fix"));
  assert.ok(html.includes("checking\nfinished"));
  assert.ok(html.includes("Live output"));
  assert.ok(html.includes("Output truncated at 64 KB"));
  assert.match(html, /<pre[^>]*tabindex="0"[^>]*max-height:min\(320px, 45vh\)/);
});

test("TUI 渲染桥：ANSI 调用、实时与结果行优先于原始输出和结构化结果", () => {
  const message = toolMessage("原始命令");
  message.content[0].renderedCallLines = ["\u001b[36m插件调用\u001b[0m"];
  const html = renderMessage(message, {
    toolResults: new Map([["tool-1", {
      role: "toolResult",
      toolCallId: "tool-1",
      content: [{ type: "text", text: "原始结果" }],
      renderedResultLines: ["\u001b[32m插件结果\u001b[0m"],
    }]]),
    toolExecutionSnapshots: [{
      toolCallId: "tool-1",
      toolName: "bash",
      output: "原始实时输出",
      renderedLines: ["\u001b[33m插件实时输出\u001b[0m"],
      startedAt: Date.now() - 500,
      status: "running",
    }],
  });

  assert.ok(html.includes("插件调用"));
  assert.ok(html.includes("插件实时输出"));
  assert.ok(html.includes("插件结果"));
  assert.ok(!html.includes("原始实时输出"));
  assert.ok(!html.includes("原始结果"));
  assert.match(html, /color:[^;]*(?:rgb|#|var\()/);
});

test("实时工具：终态默认折叠为状态、命令与固定耗时摘要", () => {
  const html = renderMessage(toolMessage("node test.mjs"), {
    toolExecutionSnapshots: [{
      toolCallId: "tool-1",
      toolName: "bash",
      output: "ok",
      startedAt: 1000,
      endedAt: 3500,
      status: "success",
    }],
  });

  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes("node test.mjs"));
  assert.ok(html.includes("Done"));
  assert.ok(html.includes("2.5s"));
  assert.ok(!html.includes("Live output"));
  assert.ok(!html.includes(">ok</pre>"));
});

test("历史工具：无快照时保持默认折叠", () => {
  const html = renderMessage(toolMessage("git status"));
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes("git status"));
  assert.ok(!html.includes("Live output"));
});
