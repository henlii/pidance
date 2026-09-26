/**
 * 插件编辑器接管面板（issue #107）的静态结构。
 *
 * SSR 只证明「该在的东西在」：退出按钮（接管期间**唯一**的鼠标出口，键盘 Esc 归插件自己）、
 * keytrap（按键入口）、插件渲染出来的正文、以及收起后的细条与回到插件的入口。
 * 真正的按键/提交行为在 lib/web-extension-ui.test.mjs（服务端）与
 * hooks/useAgentSessionEditorTakeover.test.mjs（发送管线）里测。
 */
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
const { ExtensionEditorTakeover, ExtensionEditorTakeoverBar } = await jiti.import("./ExtensionEditorTakeover.tsx");
const { I18nProvider } = await jiti.import("../lib/i18n.tsx");

const source = readFileSync(fileURLToPath(new URL("./ExtensionEditorTakeover.tsx", import.meta.url)), "utf8");

function renderTakeover(lines = ["EDITOR BODY"], extra = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionEditorTakeover, {
        request: { type: "extension_ui_request", id: "e1", method: "editorComponent", lines, ...extra },
        onInput: () => {},
        onExit: () => {},
      }),
    ),
  );
}

test("接管面板：插件正文、keytrap 与「返回输入框」都在", () => {
  const html = renderTakeover();
  assert.match(html, /EDITOR BODY/, "插件渲染的行要显示出来");
  assert.match(html, /extension-panel-keytrap/, "要有按键入口（按键交给插件的 handleInput）");
  // 退出按钮：接管期间我们的输入框不渲染，没有它用户可能被困在插件编辑器里。
  assert.match(html, /返回输入框|Back to input box/, "必须有可见退出路径（不用 Esc：Esc 归插件）");
  assert.match(html, /data-extension-editor-takeover="e1"/, "标注当前接管 id，便于定位与调试");
});

test("接管面板：正文是等宽 ANSI 块（与 custom 面板同一套渲染），不是纯文本拼出来的", () => {
  const html = renderTakeover(["\u001b[31mRED\u001b[0m"]);
  // 主题色由 lib/ansi 解析成内联 style（具体色值来自主题，这里只要求「颜色真的落到 span 上」）。
  assert.match(html, /<span style="color:#[0-9a-f]{3,8}">RED<\/span>/i, "ANSI 颜色要落到 span 上");
  assert.match(source, /parseAnsiLine/, "复用 lib/ansi 的解析（不自己造一套）");
  assert.match(source, /RenderedLineBlocks/, "复用行/图片渲染（与面板同一套）");
});

test("接管面板：脚本/编码相关的属性要给对（终端输入是原样数据，不能被输入法或自动纠正改动）", () => {
  const html = renderTakeover();
  assert.match(html, /autoCapitalize="off"/);
  assert.match(html, /autoCorrect="off"/);
  assert.match(html, /spellCheck="false"/);
});

test("接管面板：不做高度截断（插件编辑器的界面就是它自己，裁掉等于看不见状态行）", () => {
  assert.equal(
    /maxHeight:\s*(?!none)/.test(source.split("export function ExtensionEditorTakeover(")[1] ?? ""),
    false,
    "接管面板不该给自己的正文加高度上限",
  );
});

test("收起细条：说明插件编辑器已收起，并给回到它的入口", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ExtensionEditorTakeoverBar, { onReenter: () => {} })),
  );
  assert.match(html, /插件编辑器已收起|Plugin editor is hidden/);
  assert.match(html, /回到插件编辑器|Use plugin editor/);
  assert.match(html, /role="status"/, "细条是状态说明（读屏会念）");
});
