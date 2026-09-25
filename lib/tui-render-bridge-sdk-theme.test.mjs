/**
 * SDK 全局主题槽位的验收（issue #69）。
 *
 * 背景：SDK 的主题助手（`renderDiff` / `getMarkdownTheme` …）读的不是传给它们的主题，
 * 而是 SDK 在 `globalThis` 上按 `Symbol.for` 挂的**全局单例**；取不到就抛
 * `Theme not initialized. Call n() first.`。内置 edit 渲染器的 diff 正好画在这条路径上，
 * 于是「只建自己的主题、不写那个槽位」会让调用卡永远只剩头部（异常被渲染桥吞掉）。
 *
 * 本文件用**真实 SDK 的 edit 渲染器**（不是假组件）驱动我们的渲染桥：
 * - 装好槽位后，预览落地再读一次调用槽要能看到 `+`/`-` 的 diff 行；
 * - 槽位缺失时那次渲染失败要报**一次**可见告警，而不是静默。
 *
 * 只读投影：不写 `~/.pi/agent`，不碰 31415/31416；临时文件建在 tmpdir 并清理。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SDK_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const SDK_THEME_KEY_LEGACY = Symbol.for("@mariozechner/pi-coding-agent:theme");

// 渲染桥的主题实例是 SDK 的 `Theme` 类，由宿主注入（issue #97）：测试走同一条注入。
const { setPiThemeConstructor } = await import("./tui-render-bridge.ts");
const { Theme: SdkTheme } = await import("@earendil-works/pi-coding-agent");
setPiThemeConstructor(SdkTheme);

/**
 * 取 SDK 内部 edit 渲染器的路径：包的 `exports` 挡住了子路径导入，
 * 只能从**入口文件**所在目录拼（不硬编码机器路径）。
 */
function sdkEditRendererPath() {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  return join(dirname(entry), "core/tools/renderers/edit.js");
}

const stripAnsi = (line) => String(line).replace(/\u001b\[[0-9;]*m/g, "");
/** diff 行形如 `  -2 line 2` / `  +2 line 2 CHANGED`（含行号，带缩进）。 */
const diffLines = (lines) =>
  (lines ?? []).map((line) => stripAnsi(line).trim()).filter((line) => /^[-+]\d/.test(line));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

/**
 * 造一次 edit 的调用槽渲染：文件真实存在、args 是「把 line 2 改掉」。
 *
 * 返回首帧、「invalidate 后重新调用渲染器」与「直接复读同一个组件」三条路径的行 ——
 * 前者是 TUI 的刷新语义（宿主 `invalidate → recomputeToolSlots` 走的就是它），
 * 后者是宿主持有组件实例后重算其它槽（如 result 之后复读调用槽）用的路径。
 */
async function renderEditCallTwice(bridge, editRenderers, dir) {
  const file = join(dir, "preview.txt");
  writeFileSync(file, "line 1\nline 2\nline 3\n", "utf8");
  const args = { path: file, oldText: "line 2", newText: "line 2 CHANGED" };
  const state = {};
  let lastComponent;
  let invalidated = 0;
  const makeContext = (lastComponentValue) => ({
    state,
    lastComponent: lastComponentValue,
    cwd: dir,
    argsComplete: true,
    executionStarted: true,
    expanded: true,
    isPartial: false,
    isError: false,
    invalidate: () => {
      invalidated += 1;
    },
  });
  const def = { renderCall: editRenderers.renderCall };
  const remember = (component) => {
    lastComponent = component;
  };

  const first = bridge.renderToolCallLines(def, args, makeContext(undefined), remember);
  // diff 是异步算的：算完渲染器自己 invalidate 请求重渲（TUI 的 updateDisplay 就是重跑渲染器）。
  const invalidatedOnce = await waitFor(() => invalidated > 0);
  const secondViaRenderer = bridge.renderToolCallLines(def, args, makeContext(lastComponent), remember);
  const readBack = bridge.renderComponentLines(lastComponent);
  return { first, secondViaRenderer, readBack, invalidatedOnce, lastComponent };
}

test("没接探针时自检返回 null（不假通过、也不误报）", async () => {
  const bridge = await import("./tui-render-bridge.ts");
  bridge.loadPiTheme();
  assert.equal(bridge.verifySdkGlobalTheme(), null, "渲染桥不 import SDK，自检要等宿主注入探针");
});

test("槽位装的是我们的主题实例（新旧两个 Symbol 键都写）", async () => {
  const bridge = await import("./tui-render-bridge.ts");
  const theme = bridge.loadPiTheme();
  assert.ok(theme, "本地主题副本应可加载");
  assert.equal(globalThis[SDK_THEME_KEY], theme, "新版键应指向同一个实例");
  assert.equal(globalThis[SDK_THEME_KEY_LEGACY], theme, "旧版键也应写入（SDK 两个键都设）");
});

test("自检通过：注入 SDK 的主题助手探针后确认槽位可用", async () => {
  const bridge = await import("./tui-render-bridge.ts");
  bridge.loadPiTheme();
  const { renderDiff } = await import("@earendil-works/pi-coding-agent");
  // 宿主就是这么接的：探针是 SDK 自己的主题助手（渲染桥本身不 import SDK）。
  bridge.setSdkThemeProbe(() => {
    renderDiff("+ added\n- removed\n context\n");
  });
  assert.equal(bridge.verifySdkGlobalTheme(), true);
});

test("真实 SDK edit 渲染器：预览落地后调用槽能读出 diff 行", async (t) => {
  const bridge = await import("./tui-render-bridge.ts");
  bridge.loadPiTheme();
  const editRenderers = (await import(sdkEditRendererPath())).editRenderers;
  assert.equal(typeof editRenderers?.renderCall, "function", "应能取到 SDK 的 edit renderCall");

  const dir = mkdtempSync(join(tmpdir(), "pidance-edit-preview-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { first, secondViaRenderer, readBack, invalidatedOnce } = await renderEditCallTwice(
    bridge,
    editRenderers,
    dir,
  );

  assert.ok(Array.isArray(first) && first.length > 0, "首帧应有调用行");
  assert.equal(diffLines(first).length, 0, "首帧时 diff 还没算出来");
  assert.ok(invalidatedOnce, "预览算完后应请求一次重渲（否则调用槽不会刷新）");

  for (const [label, lines] of [
    ["重新调用渲染器", secondViaRenderer],
    ["复读同一个组件", readBack],
  ]) {
    const diffs = diffLines(lines);
    assert.ok(
      diffs.some((line) => /^-\d/.test(line)),
      `${label}应带上删除行，实际：${JSON.stringify(diffs)}`,
    );
    assert.ok(
      diffs.some((line) => /^\+\d/.test(line)),
      `${label}应带上新增行，实际：${JSON.stringify(diffs)}`,
    );
  }
});

test("槽位缺失时渲染失败报一次可见告警（不再静默吞掉）", async (t) => {
  const bridge = await import("./tui-render-bridge.ts");
  bridge.loadPiTheme();
  const editRenderers = (await import(sdkEditRendererPath())).editRenderers;

  // 装好的槽位在测试里摘掉：模拟「SDK 改了键名」或运行期被清掉。
  const savedPrimary = globalThis[SDK_THEME_KEY];
  const savedLegacy = globalThis[SDK_THEME_KEY_LEGACY];
  bridge.resetRenderBridgeWarningsForTests();
  const warnings = [];
  bridge.setRenderBridgeWarningSink((message) => warnings.push(message));
  delete globalThis[SDK_THEME_KEY];
  delete globalThis[SDK_THEME_KEY_LEGACY];
  t.after(() => {
    globalThis[SDK_THEME_KEY] = savedPrimary;
    globalThis[SDK_THEME_KEY_LEGACY] = savedLegacy;
  });

  const dir = mkdtempSync(join(tmpdir(), "pidance-edit-preview-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { secondViaRenderer } = await renderEditCallTwice(bridge, editRenderers, dir);

  assert.equal(secondViaRenderer, null, "槽位缺失时重渲读不出行（渲染器抛错）");
  assert.equal(warnings.length, 1, `应恰好报一次告警，实际：${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /theme/i);
  assert.match(warnings[0], /edit/i, "告警要说明影响（例如内置 edit 的 diff）");
});
