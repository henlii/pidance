/**
 * 补全请求调度（issue #101）：防抖合并、只认最新一次、被取代的请求真的 abort 掉。
 * 用假计时器，不依赖真实时间。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildCompletionMenuEntries,
  buildCompletionRequest,
  createCompletionScheduler,
  decideCompletionDisplay,
  pluginCompletionStateForOutcome,
} = await jiti.import("./completion-request.ts");

/** 假计时器：手动 flush。 */
function fakeTimers() {
  const queue = new Map();
  let nextId = 1;
  return {
    setTimeout(handler, ms) {
      const id = nextId++;
      queue.set(id, { handler, ms });
      return id;
    },
    clearTimeout(handle) {
      queue.delete(handle);
    },
    /** 跑掉所有到期的挂起任务（按注册顺序）。 */
    flush() {
      const entries = [...queue.entries()];
      queue.clear();
      for (const [, { handler }] of entries) handler();
    },
    pending: () => queue.size,
    delays: () => [...queue.values()].map((entry) => entry.ms),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("防抖：窗口内连打只发一次请求（发的是最后一次输入）", async () => {
  const timers = fakeTimers();
  const sent = [];
  const outcomes = [];
  const scheduler = createCompletionScheduler({
    debounceMs: 120,
    timers,
    request: async (input) => {
      sent.push(input);
      return { kind: "items", items: [{ value: input, label: input }], prefix: "@" };
    },
    onOutcome: (outcome, input, stale) => outcomes.push({ outcome, input, stale }),
  });

  scheduler.schedule("@a");
  scheduler.schedule("@ab");
  scheduler.schedule("@abc");
  assert.equal(sent.length, 0, "防抖窗口内一次都不该发");
  assert.deepEqual(timers.delays(), [120], "只有最后一次的计时器还在");

  timers.flush();
  await tick();
  assert.deepEqual(sent, ["@abc"], "只发最后一次");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].stale, false);
});

test("被取代的请求：真的 abort，且它的响应被标成 stale（不得覆盖新结果）", async () => {
  const timers = fakeTimers();
  const signals = [];
  const outcomes = [];
  const resolvers = [];
  const scheduler = createCompletionScheduler({
    debounceMs: 120,
    timers,
    request: (_input, signal) => {
      signals.push(signal);
      return new Promise((resolve) => resolvers.push(resolve));
    },
    onOutcome: (outcome, input, stale) => outcomes.push({ outcome, input, stale }),
  });

  scheduler.schedule("@a");
  timers.flush();
  await tick();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);

  // 第二次输入：上一次必须被 abort（插件的原生搜索靠这个信号停下来）
  scheduler.schedule("@ab");
  assert.equal(signals[0].aborted, true, "被取代的请求必须 abort");
  timers.flush();
  await tick();
  assert.equal(signals.length, 2);

  // 新请求先回来 → 采用
  resolvers[1]({ kind: "items", items: [{ value: "new", label: "new" }], prefix: "@ab" });
  await tick();
  // 旧请求后回来 → 标 stale，调用方据此丢弃
  resolvers[0]({ kind: "items", items: [{ value: "old", label: "old" }], prefix: "@a" });
  await tick();

  assert.deepEqual(
    outcomes.map((entry) => ({ input: entry.input, stale: entry.stale })),
    [{ input: "@ab", stale: false }, { input: "@a", stale: true }],
  );
});

test("请求抛错（含 abort 引起的失败）→ 当 error 上报，调用方回退本地补全", async () => {
  const timers = fakeTimers();
  const outcomes = [];
  const scheduler = createCompletionScheduler({
    debounceMs: 120,
    timers,
    request: async () => {
      throw new Error("network");
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  scheduler.schedule("@a");
  timers.flush();
  await tick();
  assert.deepEqual(outcomes, [{ kind: "error" }]);
});

test("cancel：清掉挂起的计时器并 abort 在途请求（关菜单时用）", async () => {
  const timers = fakeTimers();
  const signals = [];
  const outcomes = [];
  const scheduler = createCompletionScheduler({
    debounceMs: 120,
    timers,
    request: (_input, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  });

  scheduler.schedule("@a");
  assert.equal(timers.pending(), 1);
  scheduler.cancel();
  assert.equal(timers.pending(), 0, "cancel 要清掉挂起的计时器");
  assert.equal(scheduler.inflightCount(), 0);

  timers.flush();
  await tick();
  assert.equal(signals.length, 0, "cancel 之后不该再发出请求");

  scheduler.schedule("@b");
  timers.flush();
  await tick();
  assert.equal(signals.length, 1);
  scheduler.cancel();
  assert.equal(signals[0].aborted, true, "cancel 要 abort 在途请求");
  assert.equal(scheduler.inflightCount(), 0);
  assert.deepEqual(outcomes, [], "cancel 后到达的结果不该再回调（序号已作废）");
});

test("显示决策：插件给候选用插件；明确空则不回退；其余一律回退本地", () => {
  const items = [{ value: "a.ts", label: "a.ts" }];
  assert.deepEqual(decideCompletionDisplay({ kind: "items", items, prefix: "@a" }), {
    source: "plugin",
    items,
    prefix: "@a",
  });
  // 插件明确说「没有候选」→ 不回退（否则我们自己的文件补全会把它的意图盖掉）
  assert.deepEqual(decideCompletionDisplay({ kind: "empty" }), { source: "none", items: [], prefix: "" });
  for (const outcome of [
    { kind: "none" },
    { kind: "invalid" },
    { kind: "no-provider" },
    { kind: "error" },
    { kind: "unavailable" },
    { kind: "superseded" },
    { kind: "invalid-request" },
  ]) {
    assert.deepEqual(
      decideCompletionDisplay(outcome),
      { source: "local", items: [], prefix: "" },
      `${outcome.kind} 应回退本地补全`,
    );
  }
});

test("该不该问插件：没注册 provider 时一次都不问（零往返）", () => {
  const base = { text: "@a", cursor: 2, triggerCharacters: ["@"], cwd: "/tmp" };
  assert.equal(buildCompletionRequest({ ...base, providerCount: 0 }), null, "没有 provider 就不该有请求上下文");
  assert.notEqual(buildCompletionRequest({ ...base, providerCount: 1 }), null);
});

test("该不该问插件：@ token 或插件声明的触发字符才算触发", () => {
  const base = { providerCount: 1, cwd: "/tmp" };
  // @ 词元（`@` 必须出现在行首或空白之后，与本地菜单同一判据）
  assert.deepEqual(
    buildCompletionRequest({ ...base, text: "看看 @src/ap", cursor: 11, triggerCharacters: [] }),
    { lines: ["看看 @src/ap"], cursorLine: 0, cursorCol: 10 },
  );
  // 普通打字：没触发的字符，不问
  assert.equal(buildCompletionRequest({ ...base, text: "看看 src", cursor: 6, triggerCharacters: [] }), null);
  // 插件声明的触发字符：光标前那个字符即可
  assert.deepEqual(
    buildCompletionRequest({ ...base, text: "/mc", cursor: 3, triggerCharacters: ["/"] }),
    { lines: ["/mc"], cursorLine: 0, cursorCol: 3 },
  );
  assert.equal(buildCompletionRequest({ ...base, text: "/mc", cursor: 3, triggerCharacters: ["#"] }), null);
  // 没有 cwd 时 @ 那条路不成立（与本地菜单一致），但声明的触发字符仍然算
  assert.equal(buildCompletionRequest({ ...base, cwd: null, text: "@a", cursor: 2, triggerCharacters: [] }), null);
  assert.notEqual(buildCompletionRequest({ ...base, cwd: null, text: "/a", cursor: 2, triggerCharacters: ["/"] }), null);
});

test("该不该问插件：多行文本的 cursorLine/cursorCol 按光标算", () => {
  const request = buildCompletionRequest({
    text: "第一行\n看看 @src",
    cursor: "第一行\n看看 @src".length,
    providerCount: 1,
    triggerCharacters: [],
    cwd: "/tmp",
  });
  assert.deepEqual(request, { lines: ["第一行", "看看 @src"], cursorLine: 1, cursorCol: 7 });
});

test("该不该问插件：越界光标被夹进文本范围（不产生非法行号）", () => {
  const request = buildCompletionRequest({
    text: "@a",
    cursor: 99,
    providerCount: 1,
    triggerCharacters: [],
    cwd: "/tmp",
  });
  assert.deepEqual(request, { lines: ["@a"], cursorLine: 0, cursorCol: 2 });
});

// ---------------------------------------------------------------------------
// issue #101 审查：在途/明确空都不给本地文件项；超时要回退；词边界要对齐 TUI
// ---------------------------------------------------------------------------

test("菜单条目：pending 与 none 一律为空——在途期间不能让用户提交本地文件项", () => {
  const files = [{ path: "src/a.ts" }, { path: "src/b.ts" }];
  // 这条正是审查阻断 2：插件明确回 [] 之前的那几百毫秒里，本地文件项是可提交的。
  assert.deepEqual(buildCompletionMenuEntries({ status: "pending" }, files), []);
  assert.deepEqual(buildCompletionMenuEntries({ status: "none" }, files), []);
  assert.deepEqual(
    buildCompletionMenuEntries({ status: "local" }, files).map((entry) => entry.entry.path),
    ["src/a.ts", "src/b.ts"],
    "明确回退时才给文件项",
  );
  const plugin = buildCompletionMenuEntries(
    { status: "plugin", items: [{ value: "x", label: "x" }], prefix: "@" },
    files,
  );
  assert.deepEqual(plugin.map((entry) => entry.kind), ["plugin"], "插件候选优先，不混文件项");
});

test("结果 → 状态：只有 items 进 plugin，empty 进 none，其余一律回退本地", () => {
  assert.deepEqual(
    pluginCompletionStateForOutcome({ kind: "items", items: [{ value: "v", label: "v" }], prefix: "@" }),
    { status: "plugin", items: [{ value: "v", label: "v" }], prefix: "@" },
  );
  assert.deepEqual(pluginCompletionStateForOutcome({ kind: "empty" }), { status: "none" });
  for (const outcome of [
    { kind: "none" },
    { kind: "invalid" },
    { kind: "no-provider" },
    { kind: "error" },
    { kind: "timeout" },
    { kind: "unavailable" },
    { kind: "superseded" },
    { kind: "invalid-request" },
  ]) {
    assert.deepEqual(pluginCompletionStateForOutcome(outcome), { status: "local" }, JSON.stringify(outcome));
  }
});

test("超时：到点 abort 插件的搜索并按失败结算（只结算一次）", async () => {
  const timers = fakeTimers();
  const outcomes = [];
  const signals = [];
  let resolveRequest = null;
  const scheduler = createCompletionScheduler({
    debounceMs: 120,
    timeoutMs: 800,
    timers,
    request: (_input, signal) => {
      signals.push(signal);
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  });

  scheduler.schedule("@a");
  timers.flush();
  await tick();
  assert.deepEqual(timers.delays(), [800], "请求发出后挂上超时计时器");
  assert.equal(outcomes.length, 0);

  timers.flush();
  assert.deepEqual(outcomes, [{ kind: "timeout" }], "超时按失败结算（调用方回退本地）");
  assert.equal(signals[0].aborted, true, "插件的搜索必须被叫停");

  // 迟到的成功响应不得再结算一遍（否则会覆盖超时后的状态）
  resolveRequest({ kind: "items", items: [{ value: "x", label: "x" }], prefix: "@" });
  await tick();
  assert.equal(outcomes.length, 1, "一次请求只结算一次");
});

test("cancel 之后到达的响应被标成 stale（调用方据此丢弃，不覆盖新状态）", async () => {
  const timers = fakeTimers();
  const outcomes = [];
  let resolveRequest = null;
  const scheduler = createCompletionScheduler({
    debounceMs: 120,
    timers,
    request: () => new Promise((resolve) => { resolveRequest = resolve; }),
    onOutcome: (outcome, _input, stale) => outcomes.push({ outcome, stale }),
  });

  scheduler.schedule("@a");
  timers.flush();
  await tick();
  scheduler.cancel();
  resolveRequest({ kind: "items", items: [{ value: "x", label: "x" }], prefix: "@" });
  await tick();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].stale, true, "cancel 之后的结果必须标成过期");
});

test("词边界：CJK 标点也分词（你和 #foo 之间不该被算成同一个词）", () => {
  const base = { providerCount: 1, triggerCharacters: ["#"], cwd: null };
  assert.ok(
    buildCompletionRequest({ ...base, text: "你好，#foo", cursor: 7 }),
    "全角逗号是词边界 → 词首是 # → 触发（TUI 同口径）",
  );
  assert.equal(
    buildCompletionRequest({ ...base, text: "你好#foo", cursor: 6 }),
    null,
    "没有分隔符时词首是「你」，不触发",
  );
  assert.ok(buildCompletionRequest({ ...base, text: "hi #foo", cursor: 7 }), "空白照旧是边界");
});
