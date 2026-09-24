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
    assert.ok(html.includes(">Pidance Activity</span>"), JSON.stringify(details));
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
  assert.ok(html.includes(">Extension Debug</span>"));
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

  assert.ok(html.includes(">Extension Notice</span>"));
  assert.ok(html.includes("⚠ 插件控制提示"));
  assert.ok(html.includes("第二行"));
  assert.ok(!html.includes("原始文本"));
  assert.ok(!html.includes("&quot;raw&quot;"));
  assert.ok(!html.includes('aria-label="Copy message"'));
  assert.ok(!html.includes('aria-label="Show details"'));
  assert.match(html, /font-family:var\(--font-mono\)/);
  // 插件渲染行必须保结构（pre）：换行会把方框/表格拆散，超宽交给横向滚动
  assert.match(html, /white-space:pre"/);
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

test("custom fallback 语义保持：compaction 仍走专用压缩卡片，且默认收起（折叠行给摘要首行）", () => {
  const message = {
    role: "custom",
    customType: "compaction",
    content: "摘要第一行\n摘要第二行",
    display: true,
    details: { tokensBefore: 100, firstKeptEntryId: "x" },
  };
  const html = renderMessage(message);

  // 走专用卡片（不是通用扩展消息回退），标题行可见、可展开。
  assert.ok(html.includes(">Compaction</span>"), "标题行应显示压缩标签");
  assert.ok(!html.includes(">pidance.activity</span>"));
  // 默认收起：折叠开关是收起态，正文不整段渲染（首屏就是一行）。
  assert.ok(html.includes('aria-expanded="false"'), "初始应为收起态");
  assert.ok(html.includes('aria-label="Compaction · Expand"'));
  assert.ok(!html.includes("Conversation compacted"), "收起时正文不渲染");
  // 折叠行统一口径：本块不会流式输出，所以取摘要首行（不跟随末行）。
  assert.ok(html.includes("摘要第一行"), "收起时给摘要首行");
  assert.ok(!html.includes("摘要第二行"), "收起时不渲染整段摘要");
});

test("branch_summary 也是可折叠块，且默认收起（折叠行给摘要首行）", () => {
  const html = renderMessage({
    role: "custom",
    customType: "branch_summary",
    content: "分支摘要首行\n分支摘要末行",
    display: true,
    details: {},
  });

  assert.ok(html.includes(">Branch summary</span>"), "标题行应显示分支摘要标签");
  assert.ok(html.includes('aria-expanded="false"'), "初始应为收起态");
  assert.ok(html.includes("分支摘要首行"), "收起时给摘要首行");
  assert.ok(!html.includes("分支摘要末行"), "收起时不渲染整段摘要");
});

test("扩展自定义消息默认收起：正文不整段渲染，只给一行预览", () => {
  const html = renderMessage({
    role: "custom",
    customType: "some-extension.record",
    content: "extension record body",
    display: true,
    details: {},
  });

  assert.ok(html.includes(">Some Extension Record</span>"), "标题行显示美化后的自定义类型（通用规则，不为个别插件开特例）");
  // 收起态：走预览按钮（一行），不整段渲染 markdown 正文
  assert.ok(!html.includes("markdown-custom-message"), "非智能体直接输出的块默认不整段渲染");
  assert.ok(html.includes("extension record body"), "收起态给一行预览，便于判断要不要展开");
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


function thinkingMessage(text) {
  return { role: "assistant", content: [{ type: "thinking", thinking: text }] };
}

test("思考块：流式中保持折叠，单行显示最后一行输出", () => {
  const html = renderMessage(thinkingMessage("第一行推理\n第二行推理\n最后一行推理"), { isStreaming: true });
  assert.ok(html.includes('aria-expanded="false"'), "流式中不得自动展开");
  // 标签内联在内容前面：整块只有一行，没有独立的标题行
  assert.ok(html.includes("Thinking·"), "标签与内容同一行");
  assert.ok(html.includes("最后一行推理"), "折叠态显示最后一行");
  assert.ok(!html.includes("第二行推理"), "折叠态不渲染整段内容");
});

test("思考块：非流式（历史消息）折叠态显示首行内容", () => {
  const html = renderMessage(thinkingMessage("旧推理第一行\n旧推理末行"));
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes("Thinking·"));
  // 折叠行统一口径：流式结束（历史）取首行，作为不随输出变化的稳定标识。
  assert.ok(html.includes("旧推理第一行"), "历史块折叠态显示首行");
  assert.ok(!html.includes("旧推理末行"), "结束后不再跟随末行");
});

test("思考块：用户展开后渲染完整内容", () => {
  const source = readFileSync(fileURLToPath(new URL("./MessageView.tsx", import.meta.url)), "utf8");
  const block = source.slice(source.indexOf("function ThinkingBlock("), source.indexOf("function ToolCallBlock("));
  // 不随 isStreaming 改写展开态（除用户点击的 toggle 外无 setExpanded），且展开分支渲染完整 bodyText
  const setExpandedCalls = block.match(/setExpanded\(/g) ?? [];
  assert.equal(setExpandedCalls.length, 1, "只允许用户点击触发的 setExpanded");
  assert.ok(block.includes("onToggle={() => void toggle()}"));
  assert.match(block, /summary=\{expanded \? null : collapsedText\}/);
  assert.ok(block.includes("{bodyText}"), "展开态正文从标题下一行开始");
  assert.ok(block.includes("formatBlockLabel"), "思考标签为 思考·");
});

test("实时工具：运行中保持折叠，折叠摘要显示快照输出的最后一行", () => {
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

  // 运行中也不自动展开（折叠/展开只由用户决定）
  assert.ok(html.includes('aria-expanded="false"'));
  // 单行：标签 + 实时输出末行（整段输出与命令行都不渲染，避免出现第二行）
  assert.ok(html.includes("Bash·"));
  assert.ok(html.includes("finished"));
  assert.ok(!html.includes("checking\nfinished"));
  assert.ok(!html.includes("npm run lint -- --fix"), "运行中不显示命令行，只显示实时末行");
  assert.ok(!html.includes("Live output"));
});

test("TUI 渲染桥：ANSI 调用/实时行优先于原始输出；有 result 后工具块收回", () => {
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

  // P2 行为：工具有 result 即已结束，工具块默认收回，不展示调用/实时/结果明细。
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(!html.includes("插件调用"));
  assert.ok(!html.includes("插件实时输出"));
  assert.ok(!html.includes("插件结果"));
  assert.ok(!html.includes("原始实时输出"));
  assert.ok(!html.includes("原始结果"));

  // 无 result 且 running 时，ANSI 调用/实时行优先于原始实时输出。
  const runningMessage = toolMessage("原始命令");
  runningMessage.content[0].renderedCallLines = ["\u001b[36m插件调用\u001b[0m"];
  const runningHtml = renderMessage(runningMessage, {
    toolExecutionSnapshots: [{
      toolCallId: "tool-1",
      toolName: "bash",
      output: "原始实时输出",
      renderedLines: ["\u001b[33m插件实时输出\u001b[0m"],
      startedAt: Date.now() - 500,
      status: "running",
    }],
  });
  // 运行中保持折叠：单行摘要只显示实时输出末行（ANSI 明细需用户展开）
  assert.ok(runningHtml.includes('aria-expanded="false"'));
  assert.ok(runningHtml.includes("Bash·"));
  assert.ok(runningHtml.includes("原始实时输出"));
  assert.ok(!runningHtml.includes("插件调用"));
  assert.ok(!runningHtml.includes("插件实时输出"));

  // 展开态（用户点击后）渲染桥语义不变：ANSI 调用/实时行优先于原始实时输出。
  // SSR 无法点击，这里按源码契约断言展开分支仍走 renderedCallLines / renderedLiveLines。
  const source = readFileSync(fileURLToPath(new URL("./MessageView.tsx", import.meta.url)), "utf8");
  const toolBlock = source.slice(source.indexOf("function ToolCallBlock("), source.indexOf("/** 空数组或畸形数组视为缺失"));
  assert.match(toolBlock, /\{expanded && renderedCallLines && \(/, "展开分支应渲染 ANSI 调用行");
  assert.match(toolBlock, /renderAnsiLines\(renderedLiveLines, "tool-live"\)/, "展开分支应优先渲染 ANSI 实时行");
});

test("实时工具：终态默认折叠为标签、命令行与固定耗时摘要", () => {
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
  // 单行：标签 + 命令行 + 耗时；状态由左侧 3px 状态色边框表达，不再占一行文字
  assert.ok(html.includes("Bash·"));
  assert.ok(html.includes("node test.mjs"));
  assert.ok(!html.includes("Done"), "状态不再单独占一行文字（改由左侧状态色边框表达）");
  assert.ok(html.includes("2.5s"));
  assert.ok(!html.includes("ok</span>"), "终态不把输出末行当摘要，保持命令行稳定");
  assert.ok(!html.includes("Live output"));
  assert.ok(!html.includes(">ok</pre>"));
});

test("块表头：整行按钮带内边距，边缘可点", () => {
  const source = readFileSync(fileURLToPath(new URL("./MessageView.tsx", import.meta.url)), "utf8");
  const header = source.slice(source.indexOf("function BlockHeaderRow("), source.indexOf("function ThinkingBlock("));
  assert.ok(header.includes('data-block-header="true"'));
  assert.ok(header.includes('padding: "6px 10px"'), "内边距在按钮上，点边缘才能 toggle");
  assert.ok(header.includes("width: \"100%\""));
});

test("pwsl 工具标签用实际工具名", () => {
  const html = renderMessage({
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "tool-2", toolName: "pwsl", input: { command: "Get-Date" } }],
  });
  assert.ok(html.includes("Pwsl·"));
  assert.ok(!html.includes("【工具】"));
  assert.ok(!html.includes("【Tool】"));
});

test("历史工具：无快照时保持默认折叠", () => {
  const html = renderMessage(toolMessage("git status"));
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes("git status"));
  assert.ok(!html.includes("Live output"));
});

// 上游拒绝但未给原因：只在错误签名命中时给出提示与手动压缩入口（不自动压缩、不自动重发）
function errorAssistant(errorMessage) {
  return {
    role: "assistant",
    content: [],
    provider: "cpa",
    model: "grok-4.6",
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

test("无 body 的 4xx：给出疑似容量提示与压缩入口，并标注占用为估算", () => {
  const html = renderMessage(
    errorAssistant("OpenAI API error (400): 400 status code (no body)"),
    { contextUsage: { percent: 99, contextWindow: 500000, tokens: 381233 }, onCompactContext: () => {} },
  );

  assert.ok(html.includes("rejected this request without a reason"));
  assert.ok(html.includes("Compact context"));
  assert.ok(html.includes("381,233"), "显示估算占用");
  assert.ok(html.includes("500,000"), "显示声明窗口");
  assert.ok(html.includes("estimated"), "占用必须标注为估算");
});

test("无 body 的 4xx：只读/忙碌（无回调）时不渲染压缩入口，提示仍在", () => {
  const html = renderMessage(errorAssistant("OpenAI API error (413): no body"));
  assert.ok(html.includes("rejected this request without a reason"));
  assert.ok(!html.includes("Compact context"));
});

test("语义明确的 4xx：不给出容量提示（凭证/限流/路由各有其因）", () => {
  for (const status of [401, 403, 404, 429]) {
    const html = renderMessage(errorAssistant(`OpenAI API error (${status}): ${status} status code (no body)`));
    assert.ok(!html.includes("rejected this request without a reason"), `${status} 不应给容量提示`);
    assert.ok(!html.includes("Compact context"), `${status} 不应给压缩入口`);
  }
});

test("带 body 的 400：上游已给原因，不追加容量提示", () => {
  const html = renderMessage(errorAssistant("OpenAI API error (400): invalid request: unknown model"));
  assert.ok(!html.includes("rejected this request without a reason"));
});

test("截断：stopReason=length 且正文为空的回复仍出提示，不整卡隐藏", () => {
  const html = renderMessage({
    role: "assistant",
    model: "gpt-5",
    provider: "openai",
    stopReason: "length",
    content: [],
  });
  assert.ok(html.length > 0, "不得渲染成空白卡片");
  assert.ok(html.includes('role="alert"'), "截断必须给出可视反馈");
  assert.ok(
    html.includes("输出上限") || html.includes("output limit"),
    "文案说明是模型输出上限截断",
  );

  // 回归：同样空正文但不是截断/错误，仍然不渲染（不制造无内容气泡）
  const plain = renderMessage({
    role: "assistant",
    model: "gpt-5",
    provider: "openai",
    stopReason: "end_turn",
    content: [],
  });
  assert.equal(plain, "");
});

test("apply_patch：折叠摘要列出涉及文件，不倾倒 V4A 原文", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/app.ts",
    "@@",
    "-const a = 1;",
    "+const a = 2;",
    "*** End Patch",
  ].join("\n");
  const html = renderMessage(
    {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: "ap-1", toolName: "apply_patch", input: { input: patch } }],
    },
    {
      toolResults: new Map([["ap-1", {
        role: "toolResult",
        toolCallId: "ap-1",
        content: [{ type: "text", text: "Done!" }],
      }]]),
    },
  );
  assert.ok(html.includes("src/app.ts"), "折叠态摘要显示涉及的文件");
  assert.ok(!html.includes("*** Begin Patch"), "折叠态不把整块 V4A 原文倒出来");
});

test("apply_patch 逐文件失败：列出失败原因，且对照 diff 不再报 success", () => {
  const source = readFileSync(fileURLToPath(new URL("./MessageView.tsx", import.meta.url)), "utf8");
  const toolBlock = source.slice(source.indexOf("function ToolCallBlock("), source.indexOf("function getRenderableAnsiLines("));
  assert.match(toolBlock, /getApplyPatchFailures\(effectiveResult\?\.details\)/, "未读出逐文件失败清单");
  assert.match(toolBlock, /getApplyPatchAppliedFiles\(effectiveResult\?\.details\)/, "未列出实际写入的文件");
  const failureSection = toolBlock.slice(
    toolBlock.indexOf("applyPatchFailures.length > 0"),
    toolBlock.indexOf("applyPatchApplied.length > 0"),
  );
  assert.ok(failureSection.length > 0, "失败清单没有渲染分支");
  assert.match(failureSection, /role="alert"/, "失败清单没有可见承载（需读屏可见）");
  assert.match(failureSection, /message_applyPatchFailed/, "失败清单没有标题文案");
  assert.match(failureSection, /applyPatchFailures\.map\(/, "失败清单未逐条渲染");
  const appliedSection = toolBlock.slice(toolBlock.indexOf("applyPatchApplied.length > 0"));
  assert.match(appliedSection, /message_modifiedFiles/, "实际写入的文件没有标题");
  // 对照 diff 的顶边颜色必须跟着结果（失败时是 danger，不是 success）
  assert.match(toolBlock, /<PairedDiffResult files=\{applyPatchFiles\} isError=\{isError\} \/>/);
  const paired = source.slice(source.indexOf("function PairedDiffResult("), source.indexOf("function SplitPatchView("));
  assert.match(paired, /isError \? "var\(--status-danger-border\)" : "var\(--status-success-border\)"/, "PairedDiffResult 边框写死 success");
  // 双语都要有文案键
  for (const locale of ["en", "zh-CN"]) {
    const dict = readFileSync(fileURLToPath(new URL(`../lib/locales/${locale}.ts`, import.meta.url)), "utf8");
    assert.match(dict, /message_applyPatchFailed:/, `${locale} 缺少 message_applyPatchFailed`);
  }
});

test("工具块：结束后折叠行取命令行（首行），不再跟随输出末行", () => {
  const html = renderMessage(toolMessage("npm run build"), {
    toolResults: new Map([["tool-1", {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "bash",
      content: [{ type: "text", text: "compiled\nsucceeded" }],
    }]]),
    toolExecutionSnapshots: [{
      toolCallId: "tool-1",
      toolName: "bash",
      output: "compiled\nsucceeded",
      startedAt: Date.now() - 3000,
      endedAt: Date.now(),
      status: "success",
    }],
  });

  assert.ok(html.includes('aria-expanded="false"'));
  // 折叠行统一口径：结束后取首行；工具块的首行就是命令行（用户确认）。
  assert.ok(html.includes("npm run build"), "结束后折叠行显示命令行");
  assert.ok(!html.includes("succeeded"), "结束后不再显示输出末行");
});

test("工具块：无命令行时结束后折叠行回退到输出首行（空串不能被 ?? 挡住）", () => {
  // getToolCommand 恒返回 string：无参工具给的是空串，`??` 只认 null/undefined，
  // 于是空串会挡住回退分支，折叠行变空。这条用 DOM 渲染盯住修复后的实际显示。
  const message = {
    role: "assistant",
    content: [{ type: "toolCall", toolCallId: "tool-1", toolName: "read_file", input: {} }],
  };
  const html = renderMessage(message, {
    toolResults: new Map([["tool-1", {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read_file",
      content: [{ type: "text", text: "alpha\nbeta" }],
    }]]),
    toolExecutionSnapshots: [{
      toolCallId: "tool-1",
      toolName: "read_file",
      output: "alpha\nbeta",
      startedAt: Date.now() - 2000,
      endedAt: Date.now(),
      status: "success",
    }],
  });

  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes("alpha"), "无命令行时折叠行取输出首行");
  assert.ok(!html.includes("beta"), "折叠行只取首行");
});

test("源码契约：实时输出段只在运行中渲染（结束后不与配对结果重复）", () => {
  // 为何是源码契约：卡片展开态是组件内 useState，SSR 驱动不了；而「展开后同一份输出
  // 只出现一次」只有在展开态同时挂着实时段与结果段时才可观察。行为判据由
  // lib/message-display.test.mjs 的 shouldRenderLiveToolOutput 全覆盖（含「已结束 +
  // 有配对结果 → 关闭实时段」），这里只钉住渲染真的接上了那个开关；端到端观感由
  // 父会话的无头浏览器验收覆盖（展开一张已结束的工具卡数输出出现次数）。
  const source = readFileSync(fileURLToPath(new URL("./MessageView.tsx", import.meta.url)), "utf8");
  const block = source.slice(source.indexOf("function ToolCallBlock("), source.indexOf("function AnsiToolLines("));
  assert.match(block, /shouldRenderLiveToolOutput\(\{/, "实时段的开关要走共享判据");
  assert.match(block, /\{expanded && showLiveOutput && snapshot && \(/, "实时段未被开关收口，会和结果段重复渲染");
  assert.match(block, /message_toolLiveOutput/, "实时段标题仍在（运行中要显示）");
});

test("源码契约：思考块展开正文不再限高/内部滚动，工具块仍受限高保护", () => {
  const source = readFileSync(fileURLToPath(new URL("./MessageView.tsx", import.meta.url)), "utf8");
  const thinking = source.slice(source.indexOf("function ThinkingBlock("), source.indexOf("function ToolCallBlock("));
  assert.match(thinking, /\.\.\.THINKING_BODY_STYLE/, "思考块展开正文改用不限高样式");
  assert.ok(!thinking.includes("streamBlockMaxHeight"), "思考块不得再引用块内限高");
  assert.ok(!thinking.includes("maxHeight"), "思考块展开不得设 max-height");
  assert.ok(!thinking.includes("overflow: \"auto\""), "思考块展开不得内部滚动");
  // 工具块保持有界：实时输出与插件行仍走共享限高
  const tool = source.slice(source.indexOf("function ToolCallBlock("), source.indexOf("function PairedResult("));
  assert.ok(tool.includes("streamBlockMaxHeight"), "工具块仍须限高");
});

function assistantOnlyMessage(content) {
  return { role: "assistant", model: "m", provider: "p", content };
}

test("本轮写入的文件：卡片在回复下方，折叠态显示第一个文件名", () => {
  const html = renderMessage(
    assistantOnlyMessage([{ type: "text", text: "改完了" }]),
    { writtenFiles: ["/repo/src/a.ts", "/repo/src/other/b.ts"] },
  );
  assert.ok(html.includes("Files written this turn"), "卡片标题走 i18n");
  assert.ok(html.includes("a.ts"), "折叠行显示第一个文件名");
  assert.ok(!html.includes("b.ts"), "折叠态不铺开整份列表");
  assert.match(html, /aria-expanded="false"/, "默认收起（只有智能体正文默认展开）");
  // 非过程块的提示文案不能沿用「展开/折叠过程」——那是工具块与思考块的语义。
  assert.ok(html.includes('title="Show all files written this turn"'), "折叠提示仍是「展开过程」，与文件卡内容对不上");
  assert.ok(!html.includes('title="Show process"'), "文件卡不该用过程块的提示文案");
});

test("本轮写入的文件：流式中折叠行取末行（最近写入的那个）", () => {
  const html = renderMessage(
    assistantOnlyMessage([{ type: "text", text: "写文件中" }]),
    { writtenFiles: ["/repo/src/a.ts", "/repo/src/other/b.ts"], isStreaming: true },
  );
  assert.ok(html.includes("b.ts"), "流式中显示最新写入的文件");
  assert.ok(!html.includes("a.ts"), "流式中不显示更早写入的文件");
});

test("本轮写入的文件：没有写入时不渲染卡片，用户消息也不挂", () => {
  for (const props of [{}, { writtenFiles: [] }]) {
    const html = renderMessage(assistantOnlyMessage([{ type: "text", text: "只回答，没动文件" }]), props);
    assert.ok(!html.includes("Files written this turn"), "无写入时不渲染卡片");
  }
  const userHtml = renderMessage({ role: "user", content: "hi" }, { writtenFiles: ["/repo/a.ts"] });
  assert.ok(!userHtml.includes("Files written this turn"), "用户消息不挂这张卡片");
});

test("本轮写入的文件：走通用表头与统一折叠口径，条目可打开且保留全路径", () => {
  const source = readFileSync(fileURLToPath(new URL("./MessageView.tsx", import.meta.url)), "utf8");
  const card = source.slice(source.indexOf("function TurnWrittenFilesCard("), source.indexOf("function FileContextList("));
  assert.ok(card.length > 0, "没有找到卡片组件");
  assert.match(card, /<BlockHeaderRow/, "未复用通用表头（每块自己实现折叠会漂移）");
  assert.match(card, /collapsedSummaryLine\(/, "折叠行没有走统一口径");
  assert.match(card, /onOpenFile\?\.\(filePath\)/, "条目没有打开文件的入口");
  assert.match(card, /title=\{filePath\}/, "长路径没有保留全路径");
  assert.match(card, /aria-label=\{t\("message_openWrittenFile"/, "条目缺少无障碍名");
  assert.match(
    card,
    /toggleTitle=\{\{ expand: t\("message_writtenFilesExpand"\), collapse: t\("message_writtenFilesCollapse"\) \}\}/,
    "文件卡未传自己的折叠提示文案",
  );
  for (const locale of ["en", "zh-CN"]) {
    const dict = readFileSync(fileURLToPath(new URL(`../lib/locales/${locale}.ts`, import.meta.url)), "utf8");
    assert.match(dict, /message_writtenThisTurn:/, `${locale} 缺少 message_writtenThisTurn`);
    assert.match(dict, /message_openWrittenFile:/, `${locale} 缺少 message_openWrittenFile`);
    assert.match(dict, /message_writtenFilesExpand:/, `${locale} 缺少 message_writtenFilesExpand`);
    assert.match(dict, /message_writtenFilesCollapse:/, `${locale} 缺少 message_writtenFilesCollapse`);
  }
});
