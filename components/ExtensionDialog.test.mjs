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
