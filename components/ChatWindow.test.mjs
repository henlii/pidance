import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { ProcessDetailsGroup } = await jiti.import("./ChatWindow.tsx");

// t 走 props 注入，这里返回 key 本身即可断言文案键未被替换/新增。
const t = (key) => key;

function renderGroup(children = React.createElement("div", null, "PROCESS_BODY")) {
  return renderToStaticMarkup(
    React.createElement(
      ProcessDetailsGroup,
      { t, messageCount: 3, toolCallCount: 2 },
      children,
    ),
  );
}

test("ProcessDetailsGroup 默认展开：过程内容直接可见", () => {
  const html = renderGroup();

  assert.ok(html.includes("PROCESS_BODY"), "过程子内容默认必须渲染");
  assert.ok(html.includes('aria-expanded="true"'));
  // 展开态下切换按钮的提示应为“隐藏”键
  assert.ok(html.includes('title="chat_hideProcess"'));
  // 摘要行保留 message/toolCall 计数键
  assert.ok(html.includes("chat_processDetails"));
  assert.ok(html.includes("chat_messages"));
  assert.ok(html.includes("chat_toolCalls"));
});

test("ProcessDetailsGroup 保留用户主动收起/展开按钮", () => {
  const html = renderGroup();
  assert.match(html, /<button[^>]*aria-expanded="true"/);

  // 源码契约：切换仍走同一个 setExpanded 取反（收起能力未被删除），
  // 且初始状态为展开。
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  const groupSource = source.slice(
    source.indexOf("function ProcessDetailsGroup"),
    source.indexOf("export function ChatWindow"),
  );
  assert.match(groupSource, /useState\(true\)/);
  assert.match(groupSource, /onClick=\{\(\) => setExpanded\(\(v\) => !v\)\}/);
});

test("扩展面板打开时独占输入区：输入栏与底栏都不渲染", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  // 面板与输入栏互斥：面板打开时不再渲染 ReadOnly/Locked 栏或 ChatInput
  const inputBranch = source.slice(source.indexOf("const chatInputElement"), source.indexOf("const aboveEditorWidgets"));
  assert.match(inputBranch, /\{extensionDialog \? \(/, "面板未与输入栏互斥渲染");
  assert.match(inputBranch, /\) : isReadOnly && session \? \(/, "面板分支未排除只读/锁定栏");
  assert.ok(inputBranch.includes("<ChatInput"), "ChatInput 分支应保留");
  // 底栏（belowEditor widget + 状态条）同样让位
  assert.match(source, /\{!extensionDialog && \(\s*\n\s*<div/, "底栏未随面板一起隐藏");
});

test("ProcessDetailsGroup 无 tool call 时不显示 toolCall 计数", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ProcessDetailsGroup,
      { t, messageCount: 1, toolCallCount: 0 },
      React.createElement("div", null, "X"),
    ),
  );

  assert.ok(!html.includes("chat_toolCalls"));
  assert.ok(html.includes("chat_message<") || html.includes(">chat_message<") || html.includes("chat_message"));
});

test("扩展 widget 内容限高内滚；自定义面板与输入框同宽（共用常量）", () => {
  const source = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  const widgets = source.slice(source.indexOf("function ExtensionWidgets("), source.indexOf("const COLLAPSED_WIDGET_KEYS_STORAGE"));
  // 内容区限高 + 块内滚动，避免超长 widget 把输入区顶出可视区
  assert.ok(widgets.includes("maxHeight: bodyMaxHeight"), "widget 内容缺少限高");
  assert.ok(widgets.includes("overflow: \"auto\""), "widget 内容缺少块内滚动");
  assert.match(widgets, /CHAT_BLOCK_MAX_HEIGHT_MOBILE : CHAT_BLOCK_MAX_HEIGHT/, "限高应复用共享常量");
  // 自定义面板宽度走同一会话列常量（不再是 920）
  // ExtensionCustomPanel 在 ExtensionWidgets 之后：截到文件末尾（该函数是最后一个组件）
  const panel = source.slice(source.indexOf("function ExtensionCustomPanel("));
  assert.ok(panel.includes("min(${CHAT_COLUMN_MAX_WIDTH}px, 100%)"), "自定义面板未与输入框同宽");
  assert.ok(!panel.includes("920"), "自定义面板仍保留旧的 920 宽度");
});

test("思考/工具块与 widget 共用同一内容限高常量", () => {
  const messageView = readFileSync(fileURLToPath(new URL("./MessageView.tsx", import.meta.url)), "utf8");
  assert.ok(messageView.includes("CHAT_BLOCK_MAX_HEIGHT_mobile".replace("_mobile", "_MOBILE")));
  assert.ok(messageView.includes(": CHAT_BLOCK_MAX_HEIGHT;"), "MessageView 未复用共享限高常量");
  assert.ok(!messageView.includes("min(320px, 45vh)"), "MessageView 仍有本地重复的限高字面量");
});
