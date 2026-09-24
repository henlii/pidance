/**
 * 工具渲染槽的行为验证（issue #69 修复轮）。
 *
 * 为什么不用源码契约：`lib/tool-render-wiring.test.mjs` 只能证明「代码里是这么写的」，
 * 证明不了真实事件流里真的带 `rendered*` 行。这里用**真实的 SdkSessionHost 实例** +
 * **假工具定义**（渲染器形状照抄 SDK 内置 edit：renderResult 就地把 diff 写回 renderCall
 * 建出来的那个组件，并在相同时返回空容器）直接驱动宿主的渲染路径，断言宿主：
 *
 * 1. start 事件带首次 renderCall 的行；
 * 2. result 之后要**重读调用组件**——否则内置 edit 的 diff（只在调用槽里）整段丢掉，
 *    且插件不会再 invalidate；
 * 3. 随事件推出去的行要记账，下一次重算不重复推同一份；
 * 4. update（partial）分支里调用槽的变化也要推给前端。
 *
 * 不调用真实模型：只驱动 `withRenderedToolLines` / `recomputeToolSlots` 这两个内部入口。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { startSdkSessionHost } = await jiti.import("./sdk-session-host.ts");
const { loadPiTheme } = await jiti.import("./tui-render-bridge.ts");

/** 主题加载不到（渲染桥直接回退原事件）时，这些用例没有意义：明确跳过而不是假通过。 */
const themeReady = loadPiTheme() !== null;

/**
 * 模拟 SDK 内置 edit 的渲染器形状：
 * - renderCall 返回**同一个**调用组件实例（TUI 的 `getEditCallRenderComponent` 就是复用）；
 * - renderResult 就地把 diff / partial 写回那个组件：
 *   最终结果与已显示的行相同时返回空容器（`formatEditResult` 返回 undefined → 结果槽什么都不画），
 *   partial 更新时结果槽照常画。
 *
 * 注意 partial 的入参形状：SDK 的 `tool_execution_update` 把 `partialResult` 原样传下来，
 * 所以这里要能处理字符串与对象两种（真实 bash 就是字符串）。
 */
function editLikeDefinition(callComponent) {
  const partialText = (result) => {
    if (typeof result === "string") return result;
    if (result && typeof result === "object" && "partialResult" in result) {
      return String(result.partialResult);
    }
    return null;
  };
  return {
    name: "qa_edit",
    renderCall(args) {
      callComponent.header = `edit ${args.path}`;
      return callComponent;
    },
    renderResult(result, options) {
      const diff = typeof result?.details?.diff === "string" ? result.details.diff : undefined;
      const partial = options?.isPartial === true ? partialText(result) : null;
      if (diff) callComponent.preview = [`+ ${diff}`];
      else if (partial !== null) callComponent.preview = [`… ${partial}`];
      return { render: () => (partial !== null ? [...callComponent.preview] : []) };
    },
  };
}

function newCallComponent() {
  return {
    header: "edit",
    preview: null,
    render() {
      return [this.header, ...(this.preview ?? [])];
    },
  };
}

async function withHost(run) {
  const cwd = mkdtempSync(join(tmpdir(), "tool-render-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "tool-render-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "__new__test",
      sessionFile: "",
      cwd,
      agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
    });
    const emitted = [];
    const unsubscribe = host.onEvent((event) => emitted.push(event));
    const session = host.session;
    const original = session.getToolDefinition;
    try {
      await run({ host, emitted, session, original, callComponentOf: () => callComponentRef.value });
    } finally {
      session.getToolDefinition = original;
      unsubscribe();
      await host.destroyAsync?.().catch(() => {});
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

/** 把假定义挂到会话上：只有本用例的渲染路径会问它。 */
function installFakeTool(session, original, def) {
  session.getToolDefinition = (name) => (name === def.name ? def : original.call(session, name));
}

const callComponentRef = { value: null };

test("start 事件带首次 renderCall 的行（真实宿主路径，不是源码契约）", { skip: !themeReady }, async () => {
  await withHost(async ({ host, session, original }) => {
    const callComponent = newCallComponent();
    callComponentRef.value = callComponent;
    installFakeTool(session, original, editLikeDefinition(callComponent));

    const event = host.withRenderedToolLines({
      type: "tool_execution_start",
      toolCallId: "qa1",
      toolName: "qa_edit",
      args: { path: "a.ts" },
    });
    assert.deepEqual(event.renderedCallLines, ["edit a.ts"], "start 要带 renderCall 的行");
  });
});

test("result 就地写回调用组件后必须重读调用槽（内嵌 edit 的 diff 只在那儿）", { skip: !themeReady }, async () => {
  await withHost(async ({ host, emitted, session, original }) => {
    const callComponent = newCallComponent();
    callComponentRef.value = callComponent;
    installFakeTool(session, original, editLikeDefinition(callComponent));

    const start = host.withRenderedToolLines({
      type: "tool_execution_start",
      toolCallId: "qa1",
      toolName: "qa_edit",
      args: { path: "a.ts" },
    });
    assert.deepEqual(start.renderedCallLines, ["edit a.ts"], "此时还没有 diff");
    assert.equal(callComponent.preview, null, "调用组件上还没有预览（异步 diff 未回来）");

    // 关键时序：diff **由 renderResult 自己写回调用组件**（异步预览还没回来就被结果盖过
    // ——正是审查指出的阻断场景），而结果渲染器同时返回空容器（diff 与预览相同 → SDK
    // 内置 edit 的 formatEditResult 返回 undefined）。此时 diff 只在调用槽里。
    const end = host.withRenderedToolLines({
      type: "tool_execution_end",
      toolCallId: "qa1",
      toolName: "qa_edit",
      result: { content: [{ type: "text", text: "ok" }], details: { diff: "-old\n+new" } },
      isError: false,
    });

    assert.equal(end.renderedResultLines, undefined, "相同时结果槽不该有行");
    const update = emitted.find((event) => event.type === "rendered_lines_update" && event.toolCallId === "qa1");
    assert.ok(update, "result 之后调用槽有变化就必须推 rendered_lines_update");
    assert.deepEqual(update.renderedCallLines, ["edit a.ts", "+ -old\n+new"], "推的必须是写回之后的调用行");

    // 记账：紧接着再重算一次，行没变 → 不该再推。
    assert.equal(host.recomputeToolSlots("qa1"), null, "同一份行不得重复推");
  });
});

test("异步预览先落地时也不重复推（结果 diff 与预览相同）", { skip: !themeReady }, async () => {
  await withHost(async ({ host, emitted, session, original }) => {
    const callComponent = newCallComponent();
    callComponentRef.value = callComponent;
    installFakeTool(session, original, editLikeDefinition(callComponent));

    host.withRenderedToolLines({
      type: "tool_execution_start",
      toolCallId: "qa1",
      toolName: "qa_edit",
      args: { path: "a.ts" },
    });
    // 异步预览先到（真实的 edit 路径：computeEditsDiff().then(...)）
    const afterPreview = host.withRenderedToolLines({
      type: "tool_execution_update",
      toolCallId: "qa1",
      toolName: "qa_edit",
      args: { path: "a.ts" },
      partialResult: "preview",
    });
    assert.deepEqual(afterPreview.renderedLines, ["… preview"]);
    callComponent.preview = ["+ -old\n+new"];
    const emittedBefore = emitted.length;

    const end = host.withRenderedToolLines({
      type: "tool_execution_end",
      toolCallId: "qa1",
      toolName: "qa_edit",
      result: { content: [{ type: "text", text: "ok" }], details: { diff: "-old\n+new" } },
      isError: false,
    });
    assert.equal(end.renderedResultLines, undefined, "diff 与预览相同 → 结果槽没有行");
    // 调用槽的新行（写回后的 diff）在这一帧还没推过 → 应该推；内容与预览不同也算变化。
    const pushed = emitted.slice(emittedBefore).find((event) => event.type === "rendered_lines_update");
    assert.deepEqual(pushed?.renderedCallLines, ["edit a.ts", "+ -old\n+new"]);
  });
});

test("renderCall 里同步 invalidate() 不能白跑：重算要发生在调用凭据已就位之后", { skip: !themeReady }, async () => {
  await withHost(async ({ host, emitted, session, original }) => {
    // 假渲染器：首次 renderCall 里同步 invalidate（异步预览之外的另一条真实路径），
    // 每次调用返回**新组件**、内容在创建时就固定（`call#N`）。
    // 若宿主在记住 callRenderer 之前就放行重算，那次重算会因为「没有 renderCall 凭据」
    // 而空跑，内容停在 call#1；即便重算发生了，start 事件也必须带上最新的 call#2，
    // 不能拿较早那次的快照盖上去（客户端按事件顺序应用）。
    let renders = 0;
    installFakeTool(session, original, {
      name: "qa_edit",
      renderCall(_args, _theme, context) {
        const n = (renders += 1);
        if (n === 1) context.invalidate();
        return { render: () => [`call#${n}`] };
      },
      renderResult() {
        return undefined;
      },
    });

    const start = host.withRenderedToolLines({
      type: "tool_execution_start",
      toolCallId: "qa1",
      toolName: "qa_edit",
      args: { path: "a.ts" },
    });
    assert.ok(renders >= 2, `同步 invalidate 必须被履行（实际 renderCall 次数 ${renders}）`);
    assert.deepEqual(start.renderedCallLines, ["call#2"], "start 事件要以重算后的最新行为准");
    const pushed = emitted.filter(
      (event) => event.type === "rendered_lines_update" && Array.isArray(event.renderedCallLines),
    );
    assert.ok(pushed.length >= 1, "重算出来的行要推给前端");
    assert.deepEqual(pushed.at(-1).renderedCallLines, ["call#2"], "最后落到客户端的就是最新行");
  });
});

test("随事件推出去的行要记账：下一次重算不重复推（update 分支）", { skip: !themeReady }, async () => {
  await withHost(async ({ host, emitted, session, original }) => {
    const callComponent = newCallComponent();
    callComponentRef.value = callComponent;
    installFakeTool(session, original, editLikeDefinition(callComponent));

    host.withRenderedToolLines({
      type: "tool_execution_start",
      toolCallId: "qa1",
      toolName: "qa_edit",
      args: { path: "a.ts" },
    });
    const update = host.withRenderedToolLines({
      type: "tool_execution_update",
      toolCallId: "qa1",
      toolName: "qa_edit",
      args: { path: "a.ts" },
      partialResult: "half",
    });
    assert.deepEqual(update.renderedLines, ["… half"], "update 事件带的是结果槽的行");

    const before = emitted.filter((event) => event.type === "rendered_lines_update").length;
    assert.equal(host.recomputeToolSlots("qa1"), null, "刚推过的行不得再算成变化");
    assert.equal(
      emitted.filter((event) => event.type === "rendered_lines_update").length,
      before,
      "重算不得重复推事件",
    );
  });
});

test("update 分支里调用槽的变化也要推给前端（事件本身只带结果槽）", { skip: !themeReady }, async () => {
  await withHost(async ({ host, emitted, session, original }) => {
    const callComponent = newCallComponent();
    callComponentRef.value = callComponent;
    installFakeTool(session, original, editLikeDefinition(callComponent));

    host.withRenderedToolLines({
      type: "tool_execution_start",
      toolCallId: "qa1",
      toolName: "qa_edit",
      args: { path: "a.ts" },
    });
    // partial 渲染同样会就地把内容写回调用组件（edit 预览就是这条路径）
    const update = host.withRenderedToolLines({
      type: "tool_execution_update",
      toolCallId: "qa1",
      toolName: "qa_edit",
      args: { path: "a.ts" },
      partialResult: "half",
    });

    assert.ok(update.renderedLines, "结果槽随事件走");
    const callUpdate = emitted.find(
      (event) => event.type === "rendered_lines_update" && Array.isArray(event.renderedCallLines),
    );
    assert.ok(callUpdate, "调用槽的变化必须用 rendered_lines_update 补一帧");
    assert.deepEqual(callUpdate.renderedCallLines, ["edit a.ts", "… half"]);
  });
});
