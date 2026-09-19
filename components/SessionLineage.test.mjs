import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SessionLineage } = await jiti.import("./SessionLineage.tsx");
const { I18nProvider } = await jiti.import("@/lib/i18n");

function session(id, overrides = {}) {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/repo",
    created: "2026-09-15T00:00:00.000Z",
    modified: "2026-09-15T00:00:00.000Z",
    messageCount: 1,
    firstMessage: `msg-${id}`,
    ...overrides,
  };
}

function child(id, parentSessionId, overrides = {}) {
  return session(id, {
    subagent: { parentSessionId, runId: "run-1", runIndex: 0 },
    readOnly: true,
    firstMessage: "(no messages)",
    ...overrides,
  });
}

// SSR（isMobile=false，activity 走 getServerSnapshot 空态）：只看顶栏静态结构。
function render(sessions, current) {
  const catalogStore = { subscribe: () => () => {}, getSnapshot: () => ({ sessions }) };
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(SessionLineage, { catalogStore, session: current, onSelectSession: () => {} }),
    ),
  );
}

test("无子会话：只渲染当前会话标题，不出现斜线与触发器", () => {
  const root = session("root", { name: "修复登录" });
  const html = render([root], root);
  assert.match(html, /修复登录/);
  assert.equal(html.includes('class="session-lineage-sep"'), false);
  assert.equal(html.includes("session-lineage-trigger"), false);
  assert.equal(html.includes("session-lineage-crumb "), false);
});

test("主会话 + 3 个子会话：斜线分隔 + 数量触发器（dsh 语义）", () => {
  const root = session("root", { name: "修复登录" });
  const html = render([
    root,
    child("c1", "root", { modified: "2026-09-15T10:00:00.000Z" }),
    child("c2", "root", { modified: "2026-09-15T09:00:00.000Z" }),
    child("c3", "root", { modified: "2026-09-15T08:00:00.000Z" }),
  ], root);
  assert.match(html, /class="session-lineage-sep"/);
  assert.match(html, /aria-haspopup="tree"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /3 subagent\(s\)/);
  // 当前就是根会话：不作为可点面包屑
  assert.equal(html.includes("session-lineage-crumb "), false);
  assert.match(html, /aria-current="page"/);
});

test("子会话页：父标题可点返回，末段标题与展开按钮合成一个按钮", () => {
  const root = session("root", { name: "主会话" });
  const a = child("a", "root", { modified: "2026-09-15T10:00:00.000Z", name: "调查登录" });
  const a1 = child("a1", "a", { modified: "2026-09-15T11:00:00.000Z", name: "读日志" });
  const html = render([root, a, a1], a1);
  // 面包屑保留祖先层（可点返回），只把末段标题换成合并按钮
  assert.match(html, /session-lineage-crumb instant-tooltip/);
  assert.match(html, /调查登录/);
  assert.match(html, /class="session-lineage-title instant-tooltip"/);
  assert.match(html, /aria-haspopup="tree"/);
  assert.match(html, /aria-label="Switch subagent: 读日志"/);
  assert.equal(html.includes("session-lineage-current"), false);
  // 自己没有后代 → 不出现数量触发器
  assert.equal(html.includes('class="session-lineage-trigger instant-tooltip"'), false);
});

test("子会话页的数量触发器只统计自己的后代（不是整条谱系）", () => {
  const root = session("root", { name: "主会话" });
  const a = child("a", "root", { name: "调查登录" });
  const a1 = child("a1", "a", { modified: "2026-09-15T11:00:00.000Z", name: "读日志" });
  const grand = child("grand", "a1", { name: "翻日志" });
  const html = render([root, a, a1, grand], a1);
  assert.match(html, /class="session-lineage-title instant-tooltip"/);
  assert.match(html, /class="session-lineage-trigger instant-tooltip"/);
  assert.match(html, /1 subagent\(s\)/);
  // 整条谱系是 3（a、a1、grand）：触发器不数它
  assert.equal(html.includes("3 subagent(s)"), false);
});

test("父会话缺失（已删除）时仍渲染合并按钮，没有可跳的父层", () => {
  const orphan = child("orphan", "gone");
  const html = render([orphan], orphan);
  assert.match(html, /class="session-lineage-title instant-tooltip"/);
  assert.equal(html.includes("session-lineage-crumb "), false);
  assert.equal(html.includes('class="session-lineage-trigger instant-tooltip"'), false);
});

test("超长标题单行截断（桌面 30 字符 + 省略号）", () => {
  const root = session("root", { name: "长".repeat(50) });
  const html = render([root], root);
  assert.match(html, new RegExp(`${"长".repeat(29)}…`));
  assert.equal(html.includes("长".repeat(30)), false);
});
