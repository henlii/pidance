/**
 * #17 D2 验收：真实 pi-subagents 渲染桥适配（服务端契约层）
 *
 * 加载真实 pi-subagents 扩展源码（settings.json 已启用的 npm 包），mock 最小
 * ExtensionAPI 捕获其注册的 ToolDefinition 与 MessageRenderer，再用 Pidance
 * 渲染桥（lib/tui-render-bridge.ts）headless 调用：
 *   - subagent 工具 renderCall / renderResult
 *   - setWidget 组件工厂
 *   - 自定义消息渲染器（subagent-notify）
 * 验证输出为合法 ANSI 行数组（上限内），且渲染器抛错/缺渲染器时安全回退 null。
 *
 * 用法：node scripts/verify-subagent-render-bridge.mjs
 * 依赖：~/.pi/agent/npm/node_modules/pi-subagents（本地已安装，非测试依赖）。
 * 注意：本脚本是开发期验证工具，alias 到工作区 node_modules 的 @earendil-works
 * 包（optionalDependencies 安装时存在）；不在生产/测试路径中，不参与 SDK
 * allowlist 门禁（见 lib/sdk-import-allowlist.test.mjs）。
 */
import { createJiti } from "jiti";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
// pi-subagents 的 devDependencies 未随包安装；解析到 Pidance 工作区实际使用的
// @earendil-works 包（0.81.1，正是 AgentSession 运行时依赖，契约一致）。
const nm = require("path").resolve(new URL("../node_modules", import.meta.url).pathname);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": new URL("../", import.meta.url).pathname,
    "@earendil-works/pi-coding-agent": require("path").join(nm, "@earendil-works", "pi-coding-agent"),
    "@earendil-works/pi-agent-core": require("path").join(nm, "@earendil-works", "pi-agent-core"),
    "@earendil-works/pi-tui": require("path").join(nm, "@earendil-works", "pi-tui"),
    "@earendil-works/pi-ai": require("path").join(nm, "@earendil-works", "pi-ai"),
    // exports 仅声明 import 条件，jiti CJS 解析不到；精确指向实际文件。
    "@earendil-works/pi-ai/compat": require("path").join(nm, "@earendil-works", "pi-ai", "dist", "compat.js"),
  },
});

const { renderToolCallLines, renderToolResultLines, renderWidgetFactoryLines, renderCustomMessageLines, loadPiTheme } =
  await jiti.import("../lib/tui-render-bridge.ts");

const PI_SUBAGENTS_INDEX = process.env.PI_SUBAGENTS_INDEX ?? require("path").join(
  process.env.HOME,
  ".pi",
  "agent",
  "npm",
  "node_modules",
  "pi-subagents",
  "index.ts",
);

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

console.log(`加载真实插件：${PI_SUBAGENTS_INDEX}`);
const registerSubagentExtension = (await jiti.import(PI_SUBAGENTS_INDEX)).default;
assert.equal(typeof registerSubagentExtension, "function", "插件默认导出应为注册函数");

// 最小 ExtensionAPI mock：只记录注册面，不触发任何执行副作用。
const tools = [];
const messageRenderers = new Map();
let widgetFactory = null;
const eventHandlers = [];
const mockPi = {
  events: { on: (name, handler) => { eventHandlers.push([name, handler]); return () => {}; } },
  on: (name, handler) => {
    eventHandlers.push([name, handler]);
    return () => {};
  },
  registerTool: (tool) => tools.push(tool),
  registerMessageRenderer: (type, renderer) => messageRenderers.set(type, renderer),
  registerCommand: () => {},
  registerShortcut: () => {},
  ui: {
    setWidget: (key, factory) => {
      if (factory) widgetFactory = factory;
      return () => {};
    },
  },
  hasUI: false,
  getConfig: () => ({}),
  getContext: () => ({ cwd: process.cwd(), sessionId: "verify" }),
};

registerSubagentExtension(mockPi);

const subagentTool = tools.find((t) => t.name === "subagent");
assert.ok(subagentTool, "真实插件应注册 subagent 工具");
assert.ok(typeof subagentTool.renderCall === "function", "subagent 应有 renderCall");
assert.ok(typeof subagentTool.renderResult === "function" || typeof subagentTool.ln === "function", "subagent 应有 renderResult");

console.log("真实插件已加载：", subagentTool.label ?? subagentTool.name);
console.log(`消息渲染器注册数：${messageRenderers.size}；事件处理器数：${eventHandlers.length}`);

// ── 1. renderCall：完整形态 ──
check("renderCall（单 agent 调用）产出 ANSI 行", () => {
  const lines = renderToolCallLines(
    subagentTool,
    { action: "execute", agent: "delegate", task: "verify" },
    { isPartial: false, expanded: true, isError: false, resultSlot: false },
  );
  assert.ok(Array.isArray(lines) && lines.length > 0, "应返回非空行数组");
  assert.ok(lines.every((l) => typeof l === "string"), "每行应为字符串");
});

check("renderCall（parallel 形态）不抛错", () => {
  const lines = renderToolCallLines(
    subagentTool,
    { action: "execute", tasks: [{ agent: "a", task: "x" }, { agent: "b", task: "y" }] },
    { isPartial: false, expanded: true, isError: false, resultSlot: false },
  );
  assert.ok(Array.isArray(lines), "应返回行数组（或安全 null，不得抛错）");
});

// ── 2. renderResult：完整与 partial ──
// 字段形态取自真实插件 Details 结构（tui/render.ts 消费面）。
const sampleResult = {
  task: "verify subagent rendering",
  content: [{ type: "text", text: "subagent done" }],
  details: {
    results: [
      {
        sessionFile: "/tmp/fake/run-1/session.jsonl",
        task: "verify subagent rendering",
        finalOutput: "done",
        output: "done",
        exitCode: 0,
        status: "success",
        model: "new-api/deepseek-v4-flash:max",
        startedAt: Date.now() - 5000,
        endedAt: Date.now(),
      },
    ],
  },
  isError: false,
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, totalCostUSD: 0.001 },
};

check("renderResult（完整结果）产出 ANSI 行", () => {
  const lines = renderToolResultLines(
    subagentTool,
    sampleResult,
    { expanded: true, isPartial: false },
    { isPartial: false, expanded: true, isError: false, resultSlot: true, state: {} },
  );
  assert.ok(Array.isArray(lines) && lines.length > 0, "应返回非空行数组");
});

check("renderResult（partial）产出 ANSI 行", () => {
  const lines = renderToolResultLines(
    subagentTool,
    { ...sampleResult, details: { ...sampleResult.details, partial: true } },
    { expanded: true, isPartial: true },
    { isPartial: true, expanded: true, isError: false, resultSlot: true, state: {} },
  );
  assert.ok(Array.isArray(lines) && lines.length > 0, "partial 也应产出行");
});

check("renderResult（isError）不抛错", () => {
  const lines = renderToolResultLines(
    subagentTool,
    { ...sampleResult, isError: true, content: [{ type: "text", text: "boom" }] },
    { expanded: true, isPartial: false },
    { isPartial: false, expanded: true, isError: true, resultSlot: true, state: {} },
  );
  assert.ok(Array.isArray(lines), "错误结果应返回行或安全 null");
});

// ── 3. 上限与超限回退 ──
check("渲染行数超限 → 安全 null（不截断）", () => {
  const fakeDef = {
    renderCall: () => ({ render: () => Array.from({ length: 501 }, () => "x") }),
    renderResult: () => ({ render: () => Array.from({ length: 501 }, () => "x") }),
  };
  assert.equal(renderToolCallLines(fakeDef, {}, {}), null);
  assert.equal(renderToolResultLines(fakeDef, {}, { expanded: true, isPartial: false }, {}), null);
});

check("渲染器抛错 → 安全 null", () => {
  const badDef = {
    renderCall: () => { throw new Error("renderer boom"); },
  };
  assert.equal(renderToolCallLines(badDef, {}, {}), null);
});

check("无渲染器 → 安全 null", () => {
  assert.equal(renderToolCallLines({}, {}, {}), null);
  assert.equal(renderToolResultLines({}, {}, { expanded: true, isPartial: false }, {}), null);
});

// ── 4. 自定义消息渲染器（subagent-notify） ──
check("registerMessageRenderer 注册的渲染器可 headless 渲染", () => {
  const renderer = messageRenderers.get("subagent-notify");
  if (!renderer) return; // 版本差异：无该渲染器时跳过
  const theme = loadPiTheme();
  assert.ok(theme, "主题应可加载");
  const lines = renderCustomMessageLines(renderer, {
    role: "custom",
    customType: "subagent-notify",
    content: "notify body",
  }, theme);
  assert.ok(Array.isArray(lines) && lines.length > 0, "notify 渲染器应产出 ANSI 行");
});

// ── 5. 前端消费面（renderedResultLines 结构约定） ──
check("产出行不含控制字符以外的裸 ANSI 破坏（每行都是合法字符串）", () => {
  const lines = renderToolResultLines(
    subagentTool,
    sampleResult,
    { expanded: true, isPartial: false },
    { isPartial: false, expanded: true, isError: false, resultSlot: true, state: {} },
  );
  assert.ok(lines, "前置渲染应成功");
  for (const line of lines) {
    assert.ok(!line.includes("\n"), "单行内不应含换行");
  }
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
