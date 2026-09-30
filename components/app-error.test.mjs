import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { default: AppError } = await jiti.import("../app/error.tsx");
const { I18nProvider } = await jiti.import("../lib/i18n.tsx");

const render = (message) =>
  renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(AppError, { error: Object.assign(new Error(message), { digest: "d1" }), reset: () => {} })),
  );

test("页面错误边界把异常渲染成可读错误而不是白屏", () => {
  const html = render("boom: 压缩后渲染失败");
  // 关键：错误信息在页面上（用户能直接看到/复制），而不是空白页
  assert.match(html, /boom: 压缩后渲染失败/, "错误信息必须显示出来");
  assert.match(html, /d1/, "digest 一起显示，便于对照服务端日志");
  assert.match(html, /role="alert"/, "要能被无障碍技术播报");
  assert.match(html, />重试<|>Try again</, "要有重试按钮");
  assert.match(html, />刷新页面<|>Reload page</, "要有刷新按钮");
  assert.doesNotMatch(html, /var\(--border\):/, "不该把样式表变量本身当文本渲染出来");
});

test("错误边界文案走 i18n（中英各一份，不是硬编码）", () => {
  const zh = render("x");
  assert.match(zh, /界面出错了|Something went wrong/);
});
