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

test("进入子会话：面包屑根 → 子 → 孙，触发器统计整个谱系", () => {
  const root = session("root", { name: "主会话" });
  const a = child("a", "root", { modified: "2026-09-15T10:00:00.000Z" });
  const a1 = child("a1", "a", { modified: "2026-09-15T11:00:00.000Z" });
  const html = render([root, a, a1], a1);
  // 根与 a 可点，a1 是当前位置
  assert.equal((html.match(/session-lineage-crumb instant-tooltip/g) ?? []).length, 2);
  assert.match(html, /Switch to 主会话/);
  assert.match(html, /aria-current="page"/);
  // 目录挂在根上：a + a1 都在
  assert.match(html, /2 subagent\(s\)/);
  assert.equal((html.match(/class="session-lineage-sep"/g) ?? []).length, 3);
});

test("父会话缺失（已删除）时仍显示当前子会话自身", () => {
  const orphan = child("orphan", "gone");
  const html = render([orphan], orphan);
  assert.match(html, /aria-current="page"/);
  assert.equal(html.includes("session-lineage-trigger"), false);
});

test("超长标题单行截断（桌面 30 字符 + 省略号）", () => {
  const root = session("root", { name: "长".repeat(50) });
  const html = render([root], root);
  assert.match(html, new RegExp(`${"长".repeat(29)}…`));
  assert.equal(html.includes("长".repeat(30)), false);
});
