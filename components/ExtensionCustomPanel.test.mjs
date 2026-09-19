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

test("custom 面板：GUI 外壳、复制、关闭；空 lines 不崩", () => {
  const html = renderPanel(["hello", "world"]);
  assert.ok(html.includes("extension-panel-overlay"));
  assert.ok(html.includes("extension-panel-ansi"));
  assert.ok(html.includes("hello"));
  assert.ok(html.includes("aria-label=\"Copy\"") || html.includes("aria-label=\"复制\""));
  assert.ok(html.includes("aria-label=\"Close\"") || html.includes("aria-label=\"关闭\""));
  assert.ok(renderPanel(undefined).includes("extension-panel-ansi"));
  assert.ok(renderPanel([1, null, "ok"]).includes("ok"));
});

test("custom 面板：不把整块点击当成焦点陷阱；复制只抄正文", () => {
  assert.ok(!source.includes("closest(\"button\")"));
  assert.ok(source.includes("stripAnsi"));
  assert.ok(source.includes("shouldCaptureCustomPanelKey"));
  assert.ok(source.includes("\"\\x03\""), "关闭仍走 TUI 中断，不得只隐藏");
});
