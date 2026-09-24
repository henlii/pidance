/**
 * 能力提示的水合重放（issue #93）。
 *
 * 背景：宿主自己发的降级提示（`notifyUnsupported` / `notifyLimitedSupport`）走一次性
 * SSE 事件，而 host 启动、扩展加载、注册监听器都发生在浏览器订阅之前 —— 那一刻没有
 * 订阅者，事件直接丢掉，这条「可见降级」提示在实践中用户永远看不到
 * （实测：服务端日志 5 次、页面 DOM 0 次）。修法与 pendingExtensionRequests /
 * activeCustomUi 同一路子：状态快照带上、hydration 时补一遍。
 *
 * 手法沿用 hooks/useAgentSessionTabActivation.test.mjs：从源码里抽出真实回调，
 * 用注入的 addNotice 驱动它；去重用真实的通知队列。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { pickCapabilityNotices } = await jiti.import("../lib/extension-ui-bridge.ts");
const { createNoticeQueueStore } = await jiti.import("../lib/notice-queue-store.ts");

/** 抽出 hook 源码里的 `const applyCapabilityNotices = useCallback((state) => {…})`。 */
function extractApplyCapabilityNotices(env) {
  const text = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("hook.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node)
      && node.name.getText(tree) === "applyCapabilityNotices"
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && node.initializer.arguments.length > 0) {
      expression = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, "Missing applyCapabilityNotices in useAgentSession.ts");
  const js = ts.transpileModule(`const extracted = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), `${js}; return extracted;`)(...Object.values(env));
}

function makeEnv() {
  const store = createNoticeQueueStore();
  store.activate("s1");
  const calls = [];
  return {
    store,
    calls,
    env: {
      pickCapabilityNotices,
      addNotice: (notice) => {
        calls.push(notice);
        store.enqueue({ sessionId: "s1", ...notice });
      },
    },
  };
}

const notice = (id) => ({ id, message: `Extension UI "x" is limited`, notifyType: "warning" });

test("订阅前发出的能力提示：hydration 时补进来（宿主提示必须可见）", () => {
  const { env, calls, store } = makeEnv();
  const apply = extractApplyCapabilityNotices(env);
  apply({
    sessionId: "s1",
    extensionCapabilityNotices: [{ ...notice("n1"), message: 'Extension UI "onTerminalInput" is limited by the Pidance web client: …' }],
  });
  assert.equal(calls.length, 1, "快照里有能力提示就必须补进通知队列");
  assert.equal(calls[0].id, "n1");
  assert.equal(calls[0].type, "warning", "能力提示是 warning，走重要档位（可见且不被自动过期）");
  assert.equal(store.queueLength("s1"), 1);
});

test("水合必须显式带上状态自己的会话 id：不能靠「此刻激活的是哪个会话」", () => {
  const { env, calls, store } = makeEnv();
  const apply = extractApplyCapabilityNotices(env);
  // 冷挂载：会话切换与首次 loadSession 同 tick 时，通知队列的"当前会话"可能还停在
  // 上一个会话/空。那时若省略 sessionId，通知会进错队列，这条提示永远不会显示。
  apply({ sessionId: "s1", extensionCapabilityNotices: [notice("n1")] });
  assert.equal(calls[0].sessionId, "s1", "必须把状态自己的 sessionId 传给 addNotice");
  assert.equal(store.queueLength("s1"), 1, "归属正确的会话才显示得出来");
  // 旧 Host 不带 sessionId 时退回"当前会话"（不凭空造一个 id）
  apply({ extensionCapabilityNotices: [notice("n2")] });
  assert.equal(calls[1].sessionId, null, "缺 sessionId 时按既有语义走当前会话（null = 当前）");
});

test("同一条在订阅前后各到一次：按 id 去重，只显示一条", () => {
  const { env, store } = makeEnv();
  const apply = extractApplyCapabilityNotices(env);
  // SSE 到达（同 id）→ hydration 又补一遍（真实顺序：先订阅到的、后快照补的）
  store.enqueue({ sessionId: "s1", id: "n1", message: "x", type: "warning" });
  const state = { extensionCapabilityNotices: [notice("n1")] };
  apply(state);
  apply(state);
  assert.equal(store.queueLength("s1"), 1, "同 id 到两次只显示一条（否则每次 hydrate 都多一条）");
});

test("插件自己的 notify 不在重放集合里：状态里没有该字段就不补任何东西", () => {
  const { env, calls, store } = makeEnv();
  const apply = extractApplyCapabilityNotices(env);
  apply({});
  apply(null);
  apply({ extensionCapabilityNotices: undefined });
  assert.deepEqual(calls, [], "缺字段（旧 Host）不得凭空造通知");
  assert.equal(store.queueLength("s1"), 0);
});

test("两条 hydration 路径都要补能力提示（否则冷挂载那条仍然看不到）", () => {
  const text = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("hook.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const bodies = { applyExtensionUiProjection: "", applyAgentStateSnapshot: "" };
  function visit(node) {
    if (ts.isVariableDeclaration(node)
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && node.initializer.arguments.length > 0) {
      const name = node.name.getText(tree);
      if (name in bodies) bodies[name] = node.initializer.arguments[0].getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  for (const [name, body] of Object.entries(bodies)) {
    assert.ok(body.length > 0, `Missing ${name} in useAgentSession.ts`);
    assert.match(body, /applyCapabilityNotices\(state\)/, `${name} 必须补能力提示（冷挂载与热状态各一条路径）`);
  }
});
