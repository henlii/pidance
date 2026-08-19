/**
 * D3：用用户已安装插件验收渲染桥（不装 pi-subagents，不改 ~/.pi/agent）。
 *
 * 覆盖：
 *   - pi-web-access web_search：renderCall / renderResult（含 isPartial）
 *   - @juicesharp/rpiv-todo todo：renderCall / renderResult
 *   - 超限 / 抛错 / 无渲染器 → null
 *
 * 现有插件均未 registerMessageRenderer（那条只有 pi-subagents）；该路径仍由
 * lib/tui-render-bridge 单测覆盖。
 *
 * 用法：node scripts/verify-installed-render-bridge.mjs
 */
import { createJiti } from "jiti";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const workspaceNm = path.resolve(new URL("../node_modules", import.meta.url).pathname);
const PI_NM = process.env.PI_AGENT_NPM ?? path.join(homedir(), ".pi", "agent", "npm", "node_modules");
const sdkNm = path.join(workspaceNm, "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": new URL("../", import.meta.url).pathname,
    "@earendil-works/pi-coding-agent": path.join(workspaceNm, "@earendil-works", "pi-coding-agent"),
    "@earendil-works/pi-agent-core": path.join(sdkNm, "pi-agent-core"),
    "@earendil-works/pi-tui": path.join(sdkNm, "pi-tui"),
    "@earendil-works/pi-ai": path.join(sdkNm, "pi-ai"),
    "@earendil-works/pi-ai/compat": path.join(sdkNm, "pi-ai", "dist", "compat.js"),
  },
});

const { renderToolCallLines, renderToolResultLines } = await jiti.import("../lib/tui-render-bridge.ts");

const WEB_ACCESS = path.join(PI_NM, "pi-web-access", "index.ts");
const RPIV_TODO = path.join(PI_NM, "@juicesharp", "rpiv-todo", "index.ts");

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✔ ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  ✘ ${name}: ${error.message}`);
  }
}

function mockPi() {
  const tools = [];
  return {
    tools,
    api: {
      events: { on: () => () => {} },
      on: () => () => {},
      registerTool: (tool) => tools.push(tool),
      registerMessageRenderer: () => {},
      registerCommand: () => {},
      registerShortcut: () => {},
      ui: { setWidget: () => () => {} },
      hasUI: false,
      getConfig: () => ({}),
      getContext: () => ({ cwd: process.cwd(), sessionId: "verify-installed" }),
    },
  };
}

console.log(`插件根：${PI_NM}`);

const web = mockPi();
const registerWeb = (await jiti.import(WEB_ACCESS)).default;
assert.equal(typeof registerWeb, "function");
registerWeb(web.api);
const searchTool = web.tools.find((t) => typeof t.renderCall === "function" && /search/i.test(t.name ?? t.label ?? ""));
assert.ok(searchTool, "pi-web-access 应注册带 renderCall 的 search 工具");
console.log(`已加载 pi-web-access：${searchTool.name}（共 ${web.tools.length} 个工具）`);

const todo = mockPi();
const registerTodo = (await jiti.import(RPIV_TODO)).default;
assert.equal(typeof registerTodo, "function");
registerTodo(todo.api);
const todoTool = todo.tools.find((t) => t.name === "todo");
assert.ok(todoTool, "rpiv-todo 应注册 todo 工具");
console.log(`已加载 @juicesharp/rpiv-todo：${todoTool.name}`);

check("web_search renderCall 产出 ANSI 行", () => {
  const lines = renderToolCallLines(
    searchTool,
    { query: "pidance render bridge" },
    { isPartial: false, expanded: true, isError: false, resultSlot: false },
  );
  assert.ok(Array.isArray(lines) && lines.length > 0, "应返回非空行");
  assert.ok(lines.every((l) => typeof l === "string"));
});

check("web_search renderResult（完整）不抛错", () => {
  const lines = renderToolResultLines(
    searchTool,
    {
      content: [{ type: "text", text: "ok" }],
      details: {
        queryCount: 1,
        successfulQueries: 1,
        totalResults: 1,
        queries: [{ query: "pidance", provider: "exa", answer: "ok", sources: [{ title: "t", url: "https://example.com" }], error: null }],
      },
      isError: false,
    },
    { expanded: true, isPartial: false },
    { isPartial: false, expanded: true, isError: false, resultSlot: true, state: {} },
  );
  assert.ok(lines === null || (Array.isArray(lines) && lines.every((l) => typeof l === "string")));
});

check("web_search renderResult（partial）不抛错", () => {
  const lines = renderToolResultLines(
    searchTool,
    {
      content: [{ type: "text", text: "" }],
      details: { phase: "searching", progress: 0.4, currentQuery: "pidance" },
      isError: false,
    },
    { expanded: true, isPartial: true },
    { isPartial: true, expanded: true, isError: false, resultSlot: true, state: {} },
  );
  assert.ok(lines === null || Array.isArray(lines));
});

check("todo renderCall 产出 ANSI 行", () => {
  const lines = renderToolCallLines(
    todoTool,
    { action: "create", subject: "verify installed plugin render" },
    { isPartial: false, expanded: true, isError: false, resultSlot: false },
  );
  assert.ok(Array.isArray(lines) && lines.length > 0);
});

check("todo renderResult 不抛错", () => {
  const lines = renderToolResultLines(
    todoTool,
    {
      content: [{ type: "text", text: "created" }],
      details: { action: "create", params: { action: "create", subject: "x" }, tasks: [{ id: 1, subject: "x", status: "pending" }], nextId: 2 },
      isError: false,
    },
    { expanded: true, isPartial: false },
    { isPartial: false, expanded: true, isError: false, resultSlot: true, state: {} },
  );
  assert.ok(lines === null || Array.isArray(lines));
});

check("渲染行数超限 → null", () => {
  const fakeDef = { renderCall: () => ({ render: () => Array.from({ length: 501 }, () => "x") }) };
  assert.equal(renderToolCallLines(fakeDef, {}, {}), null);
});

check("渲染器抛错 → null", () => {
  assert.equal(renderToolCallLines({ renderCall: () => { throw new Error("boom"); } }, {}, {}), null);
});

check("无渲染器 → null", () => {
  assert.equal(renderToolCallLines({}, {}, {}), null);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
