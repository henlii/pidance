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
const { ExtensionCustomPanel } = await jiti.import("./ExtensionCustomPanel.tsx");
const { I18nProvider } = await jiti.import("../lib/i18n.tsx");

const source = readFileSync(fileURLToPath(new URL("./ExtensionCustomPanel.tsx", import.meta.url)), "utf8");

function renderPanel(lines) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionCustomPanel, {
        request: { type: "extension_ui_request", id: "c1", method: "custom", lines },
        onInput: () => {},
      }),
    ),
  );
}

test("custom 面板：GUI 外壳、复制、标题行折叠；空 lines 不崩", () => {
  const html = renderPanel(["hello", "world"]);
  assert.ok(html.includes("extension-panel-overlay"));
  assert.ok(html.includes("extension-panel-ansi"));
  assert.ok(html.includes("hello"));
  assert.ok(html.includes("aria-label=\"Copy\"") || html.includes("aria-label=\"复制\""));
  // 折叠开关在标题行上（整行可点），不再有独立的「关闭/收起」按钮
  assert.match(html, /class="extension-panel-header"[^>]*role="button"/, "标题行不是折叠开关");
  assert.match(html, /aria-expanded="true"/, "默认应为展开态");
  assert.ok(!/aria-label="关闭"/.test(html), "仍渲染「关闭」按钮");
  assert.ok(renderPanel(undefined).includes("extension-panel-ansi"));
  assert.ok(renderPanel([1, null, "ok"]).includes("ok"));
});

test("custom 面板：不把整块点击当成焦点陷阱；复制只抄正文", () => {
  assert.ok(!source.includes("closest(\"button\")"));
  assert.ok(source.includes("stripAnsi"));
  assert.ok(source.includes("shouldCaptureCustomPanelKey"));
  // 中断不再走标题行按钮（按钮已删）：键盘输入由 keytrap 转发给扩展，扩展自己处理 Esc/Ctrl+C
  assert.ok(!source.includes("onClose"), "custom 面板不该再挂标题行关闭按钮");
});


test("custom 面板：底栏有取消（走 TUI 中断），标题行只负责折叠", () => {
  const html = renderPanel(["hello"]);
  assert.ok(/aria-label="取消"|aria-label="Cancel"/.test(html), "底栏取消丢了：这类面板没有别的鼠标退出口");
  assert.ok(source.includes('"\\x03"'), "取消必须发 TUI 中断（Ctrl+C），不能只是隐藏面板");
});
