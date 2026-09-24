/**
 * 工具渲染桥的事件接线契约（issue #69）。
 *
 * 为什么用源码契约：这条链路的正确性取决于**事件名**——SDK 只发
 * `tool_execution_start/update/end`，而 `tool_call` / `tool_result` 是扩展钩子事件，
 * 不会到达会话订阅者。之前宿主按后者接线，于是 renderCall 与最终 renderResult
 * 从未被调用，插件渲染内容在 Web 端整段消失（线上实测：一条事件都没带 rendered* 字段）。
 *
 * 这类「接线到不存在的事件名」的回归没有便宜的运行时断言（要起真实会话 + 假模型发
 * 工具调用），所以这里钉住源码契约；行为由 lib/tool-render-scheduler.test.mjs 的
 * 「invalidate → 重调渲染器」用例覆盖。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hostSource = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("./types.ts", import.meta.url), "utf8");

test("宿主按 SDK 真实事件名接线：start 渲染 renderCall、end 渲染最终 renderResult", () => {
  assert.match(hostSource, /case "tool_execution_start":/, "缺 tool_execution_start 分支");
  assert.match(hostSource, /case "tool_execution_end":/, "缺 tool_execution_end 分支");
  assert.doesNotMatch(hostSource, /case "tool_call":/, "tool_call 是扩展钩子事件，不得再接在会话事件上");
  assert.doesNotMatch(hostSource, /case "tool_result":/, "tool_result 同上");

  const startBlock = hostSource.slice(
    hostSource.indexOf(`case "tool_execution_start":`),
    hostSource.indexOf(`case "tool_execution_update":`),
  );
  assert.match(startBlock, /renderToolCallLines\(/, "start 分支必须调用 renderCall");
  assert.match(startBlock, /renderedCallLines:/, "start 分支必须把渲染行附到事件上");

  const updateBlock = hostSource.slice(
    hostSource.indexOf(`case "tool_execution_update":`),
    hostSource.indexOf(`case "tool_execution_end":`),
  );
  assert.match(updateBlock, /entry\.resultRenderer = \{/, "partial 更新要记住 renderResult 入参（重渲用）");
  assert.match(updateBlock, /this\.renderToolSlotsNow\(/, "partial 更新走统一重算入口");
  assert.match(updateBlock, /renderedLines:/, "partial 更新附 renderedLines");

  const endBlock = hostSource.slice(
    hostSource.indexOf(`case "tool_execution_end":`),
    hostSource.indexOf(`case "message_start":`),
  );
  assert.match(endBlock, /entry\.resultRenderer = \{/, "end 分支要记住最终 renderResult 入参");
  assert.match(endBlock, /this\.renderToolSlotsNow\(/, "end 分支走统一重算入口");
  assert.match(endBlock, /renderedResultLines:/, "end 分支必须附最终渲染行");

  // 统一重算入口：先 call 后 result（对齐 TUI 的 updateDisplay —— renderResult 会就地
  // 把 diff/预览写回 call 组件，调用槽必须跟着刷新，否则展开的工具块停在旧预览）。
  const slotsStart = hostSource.indexOf("private renderToolSlotsNow(");
  assert.ok(slotsStart > 0, "缺 renderToolSlotsNow");
  const slotsBlock = hostSource.slice(slotsStart, hostSource.indexOf("private emitRenderedLinesUpdate("));
  const callAt = slotsBlock.indexOf("renderToolCallLines(");
  const resultAt = slotsBlock.indexOf("renderToolResultLines(");
  assert.ok(callAt > 0 && resultAt > 0, "两个槽都要在统一入口里渲染");
  assert.ok(callAt < resultAt, "必须先调 renderCall 再调 renderResult");
});

test("渲染器的 invalidate 走调度器（按 SDK 语义重调渲染器，而不是只重渲缓存组件）", () => {
  assert.match(hostSource, /invalidate: \(\) => \{\s*\n\s*this\.scheduleToolRerender\(toolCallId\);/, "invalidate 必须进调度器");
  assert.match(hostSource, /createToolRenderScheduler</, "宿主用调度器限频/去重");
  assert.doesNotMatch(hostSource, /renderWidgetComponentLines\(entry\.last(Call|Result)Component/, "不得退回「只重渲缓存组件」");
});

test("线上事件契约（types.ts）与 SDK 事件名一致", () => {
  assert.match(typesSource, /type: "tool_execution_start"; renderedCallLines\?: string\[\]/);
  assert.match(typesSource, /type: "tool_execution_end"; renderedResultLines\?: string\[\]/);
  assert.match(typesSource, /type: "rendered_lines_update"/, "重渲事件名要留在契约里");
});
