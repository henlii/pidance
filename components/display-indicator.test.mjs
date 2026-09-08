import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

/**
 * 侧栏运行/等待指示视觉契约（v0.2.24）：
 * - 运行中 = 旋转圆环动画（原样保留）；
 * - agent 询问用户（extension 弹窗/ask 暂停）= 与未读点同构的黄色圆点（等待中）。
 */
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { RunningSessionIndicator, RunningDurationText, WaitingSessionIndicator } = await jiti.import("./session-sidebar/display.tsx");
const { I18nProvider } = await jiti.import("../lib/i18n.tsx");

function render(el) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, el));
}

test("RunningSessionIndicator：保留旋转圆环动画（运行中）", () => {
  const html = render(React.createElement(RunningSessionIndicator));
  assert.ok(html.includes("sidebar-running-spin"), "运行中必须保留旋转动画");
  assert.ok(html.includes("border-top-color:transparent"), "空心圆环结构");
  assert.ok(html.includes("var(--status-running)"), "运行色");
});

test("WaitingSessionIndicator：黄色实心圆点（询问用户暂停），无动画", () => {
  const html = render(React.createElement(WaitingSessionIndicator));
  assert.ok(html.includes("var(--status-waiting)"), "颜色指向等待黄变量");
  assert.ok(html.includes("background:currentColor"), "实心圆点");
  assert.ok(html.includes("border-radius:50%"), "圆形");
  assert.ok(!html.includes("sidebar-running-spin"), "等待黄点不带动画");
  assert.ok(html.includes("width:6px") && html.includes("height:6px"), "6px 圆点（对齐未读点）");
  assert.ok(html.includes("Waiting for you"), "等待语义 tooltip（en）");
});

test("RunningDurationText：运行中文案与运行色；非运行不渲染", () => {
  const html = render(
    React.createElement(RunningDurationText, { running: true, now: 1000 }),
  );
  assert.ok(html.includes("var(--status-running)"), "时长文本使用运行色");
  assert.ok(html.includes("Running"), "无 startedAt 时显示运行中文案");
  const idle = render(
    React.createElement(RunningDurationText, { running: false, now: 1000 }),
  );
  assert.equal(idle, "");
});
