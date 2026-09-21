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

const { ExtensionDialog } = await jiti.import("./ExtensionDialog.tsx");
const { I18nProvider } = await jiti.import("../lib/i18n.tsx");

const sourcePath = fileURLToPath(new URL("./ExtensionDialog.tsx", import.meta.url));
const source = readFileSync(sourcePath, "utf8");

function request(method, fields = {}) {
  return {
    type: "extension_ui_request",
    id: fields.id ?? "req-1",
    method,
    title: fields.title ?? "请选择",
    ...fields,
  };
}

function renderCard(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionDialog, props),
    ),
  );
}

// ── SSR / source contract（对齐 TUI 原生 select：纯列表 + 点击即返回）─────────

test("SSR select：纯选项列表，无 Submit、无 Other 输入框，保留 Cancel", () => {
  const html = renderCard({
    request: request("select", { options: ["一", "二", "3. Type something."] }),
    onRespond: () => {},
  });

  assert.ok(html.includes("一"));
  assert.ok(html.includes("二"));
  // 哨兵是普通选项：原样展示，不被特殊化为输入框
  assert.ok(html.includes("3. Type something."));
  // 无 locale 附加 Other 项、无 textarea（无手动输入框）、无 Submit 按钮
  assert.ok(!html.includes(">Other<"));
  assert.ok(!html.includes(">其他<"));
  assert.ok(!html.includes("<textarea"));
  assert.ok(!html.includes("aria-label=\"Submit\""));
  assert.ok(!html.includes("aria-label=\"提交\""));
  // Cancel 保留（对应 TUI Esc 取消）
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
  // 选项点击即返回（对齐 TUI extension-selector 的 Enter 即返回）
  assert.ok(source.includes("respondOnce({ value: option })"));
});

test("SSR select：空 options 时仅保留 Cancel，不崩溃", () => {
  const html = renderCard({
    request: request("select", { options: [] }),
    onRespond: () => {},
  });
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
});

test("SSR confirm：原交互保留 Cancel + Confirm", () => {
  const html = renderCard({
    request: request("confirm", { message: "确认继续？" }),
    onRespond: () => {},
  });
  assert.ok(html.includes("确认继续？"));
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
  assert.ok(html.includes("aria-label=\"Confirm\"") || html.includes("aria-label=\"确认\""));
});

test("SSR input：原交互保留 input + Submit/Cancel", () => {
  const html = renderCard({
    request: request("input", { placeholder: "输入内容" }),
    onRespond: () => {},
  });
  assert.ok(html.includes("input"));
  assert.ok(html.includes("placeholder=\"输入内容\""));
  assert.ok(html.includes("aria-label=\"Submit\"") || html.includes("aria-label=\"提交\""));
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
});

test("SSR editor：textarea + Submit/Cancel，prefill 回填", () => {
  const html = renderCard({
    request: request("editor", { prefill: "草稿内容" }),
    onRespond: () => {},
  });
  assert.ok(html.includes("<textarea"));
  assert.ok(html.includes("草稿内容"));
  assert.ok(html.includes("aria-label=\"Submit\"") || html.includes("aria-label=\"提交\""));
  assert.ok(html.includes("aria-label=\"Cancel\"") || html.includes("aria-label=\"取消\""));
});

test("source contract：respondOnce 每 id 一次、无卸载 effect 响应、无多题协议", () => {
  // respondOnce 有幂等守卫（respondedRequestRef）
  assert.ok(source.includes("respondedRequestRef.current === boundRequestId"));
  // 组件无卸载时伪造响应的 effect
  assert.ok(!/useEffect[\s\S]*onRespond/.test(source));
  // 无多题/步骤字段
  const html = renderCard({
    request: request("select", { options: ["一"] }),
    onRespond: () => {},
  });
  assert.doesNotMatch(html, /questions|answers|queue|Next|步骤/);
});

test("source contract：inert 覆盖 disabled/expired/responded", () => {
  assert.ok(source.includes("const inert = disabled || expired || responded;"));
});

test("SSR/source：面板与输入框同宽同中线，内容区可滚动", () => {
  const html = renderCard({
    request: request("select", { options: ["一"] }),
    onRespond: () => {},
  });
  assert.match(html, /width:min\(\d+px, 100%\)/, "面板未使用与输入框一致的宽度（取自共享常量）");
  assert.ok(!html.includes("min(560px, 100%)"), "面板仍保留旧的窄栏宽度");
  assert.ok(html.includes("extension-panel-body"), "内容区走 GUI 外壳滚动区");
  assert.ok(html.includes("extension-panel-footer"), "操作区固定在面板底部");
  // 面板自身不再带 padding：由 ChatWindow 按输入框同款内边距与 820 宽度包裹
  const chatWindow = readFileSync(fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url)), "utf8");
  const block = chatWindow.slice(
    chatWindow.indexOf("const chatInputElement"),
    chatWindow.indexOf("const aboveEditorWidgets"),
  );
  assert.ok(block.includes("CHAT_INPUT_SIDE_PADDING"), "扩展面板未按输入框同款内边距包裹");
  assert.ok(block.includes("maxWidth: CHAT_COLUMN_MAX_WIDTH"), "扩展面板未按输入框同款宽度包裹");
});

// ── 提问区可读性：右上「关闭」只留给非 select；面板可展开/收回 ────────────────

test("SSR select：不再渲染右上「关闭」（它与取消等价，且取消会中止执行）", () => {
  const select = renderCard({
    request: request("select", { options: ["一"] }),
    onRespond: () => {},
  });
  assert.ok(!/>关闭</.test(select) && !/>Close</.test(select), "select 仍渲染「关闭」按钮");
  assert.ok(!/aria-label="关闭"/.test(select), "select 的「关闭」按钮仍在 DOM 里");
  assert.ok(/aria-label="取消"|aria-label="Cancel"/.test(select), "select 丢了「取消」按钮");

  // 非 select（input/editor/confirm）保留「关闭」：那是它们唯一的取消入口之外的习惯动作
  const input = renderCard({
    request: request("input", { placeholder: "写点什么" }),
    onRespond: () => {},
  });
  assert.ok(/aria-label="关闭"|aria-label="Close"/.test(input), "非 select 弹窗应保留「关闭」");
});

test("SSR：面板带展开/收回开关，初始为收回态", () => {
  const html = renderCard({
    request: request("select", { options: ["一"] }),
    onRespond: () => {},
  });
  assert.match(html, /aria-expanded="false"/, "缺展开开关的初始态");
  assert.ok(/aria-label="展开"|aria-label="Expand"/.test(html), "缺「展开」按钮");
  assert.ok(!html.includes("extension-panel-shell--expanded"), "初始不应是展开态");
  assert.ok(/aria-label="收回"|aria-label="Collapse"/.test(html) === false, "收回文案只在展开后出现");
});

test("CSS 契约：提问区可滚、展开态提高高度上限（含窄屏规则）", () => {
  const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
  // 规则从行首开始才是基础规则（避免匹配到 `.extension-panel-shell--expanded .extension-panel-title`）
  const titleMatch = /^\.extension-panel-title \{([^}]*)\}/m.exec(css);
  assert.ok(titleMatch, "找不到 .extension-panel-title");
  const titleRule = titleMatch[1];
  assert.match(titleRule, /overflow-y:\s*auto/, "提问区（标题）不可滚动 —— 长提问会被外壳裁掉");
  assert.match(titleRule, /max-height:\s*min\(30vh, 240px\)/, "提问区缺高度上限");
  assert.match(css, /\.extension-panel-shell--expanded\s*\{\s*max-height:\s*min\(78vh, 900px\)/, "缺展开态高度");
  // 展开必须同时抬高提问区上限，否则长提问仍停在收起态的小滚动区里
  assert.match(css, /\.extension-panel-shell--expanded \.extension-panel-title\s*\{\s*max-height:\s*60vh/, "展开态未抬高提问区上限");
  assert.ok(
    css.includes("calc(100dvh - 96px - env(safe-area-inset-top) - env(safe-area-inset-bottom))"),
    "缺窄屏展开态高度（移动端展开后要顶到视口可用高度）",
  );
});
