/**
 * 斜杠命令参数补全的替换语义（issue #75）。
 *
 * 从真实 ChatInput 源码里抽出三个片段驱动（与 ChatInputSendOwnership 同一手法：
 * 不渲染整个输入框，只验证**可断言的行为**与**会被静默破坏的接线**）：
 * - `argQuery`：prefix 只看「光标所在行、光标之前」（与 pi-tui 的 getSuggestions 一致）；
 * - `applyArgCompletion`：替换参数区间（命令名之后到光标处），光标后的正文与其它行原样保留，
 *   不额外补空格（候选 value 自己带空格时才留空格，与 pi-tui 的 applyCompletion 一致）；
 * - `handleKeyDown`：候选到位后 Tab/Enter 必须拦住（否则 Enter 会把没补全的正文直接发出去），
 *   Escape 要作废在途请求。React 的闭包依赖不在 node 里跑，所以另有一条 AST 契约断言
 *   `useCallback` 的依赖数组包含这四个名字 —— 缺了它们就是同一个 bug 复发。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const SOURCE = new URL("./ChatInput.tsx", import.meta.url);

function callback(name, env) {
  const text = readFileSync(SOURCE, "utf8");
  const tree = ts.createSourceFile("ChatInput.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer
      && ts.isCallExpression(node.initializer)) {
      // 两种形状：`useCallback((e) => {...}, deps)` 取参数 0；`(() => {...})()` 取被调用的那个函数。
      const callee = node.initializer.expression;
      if (node.initializer.arguments.length > 0) {
        expression = node.initializer.arguments[0].getText(tree);
      } else if (ts.isParenthesizedExpression(callee)) {
        expression = callee.expression.getText(tree);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, `Missing callback: ${name}`);
  const js = ts.transpileModule(`const extracted = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(env), `${js}; return extracted;`)(...Object.values(env));
}

/** 最小输入框环境：记录 setValue 与光标，textarea 只需 selectionStart/focus/setSelectionRange。 */
function composer(value, caret = null, argQuery = { name: "mcp", prefix: value.slice(value.indexOf(" ") + 1) }) {
  const state = { value, caret: caret ?? value.length, focused: false, selection: null };
  const textarea = {
    selectionStart: state.caret,
    style: {},
    scrollHeight: 40,
    focus() { state.focused = true; },
    setSelectionRange(start) { state.selection = start; state.caret = start; },
  };
  const env = {
    argQuery,
    value,
    textareaRef: { current: textarea },
    setValue: (next) => { state.value = next; },
    setArgActiveIndex: () => {},
    requestAnimationFrame: (fn) => fn(),
  };
  return { apply: callback("applyArgCompletion", env), state };
}

test("光标在末尾：替换整段参数并停在末尾（issue #75）", () => {
  const { apply, state } = composer("/mcp token set ");
  apply({ value: "token set serverA", label: "serverA" });
  assert.equal(state.value, "/mcp token set serverA");
  assert.equal(state.selection, "/mcp token set serverA".length, "光标停在插入内容末尾");
  assert.equal(state.focused, true, "插入后焦点回到输入框");
});

test("候选 value 自带尾部空格时保留该空格（pi-tui 同语义）", () => {
  const { apply, state } = composer("/mcp rec", 8);
  apply({ value: "reconnect ", label: "reconnect" });
  assert.equal(state.value, "/mcp reconnect ", "不额外补空格，也不吃掉候选自带的空格");
  assert.equal(state.selection, "/mcp reconnect ".length);
});

test("在参数中途插入：只替换到光标处，保留光标后的参数正文", () => {
  const { apply, state } = composer("/mcp enable serXver", 16);
  apply({ value: "enable serverA", label: "serverA" });
  assert.equal(state.value, "/mcp enable serverAver", "光标后的 'ver' 属于用户续写，保留");
  assert.equal(state.selection, "/mcp enable serverA".length);
});


/** argQuery 是个 IIFE，与 useCallback 一样用同一个抽取器。 */
function argQueryFor({ value, caret = null, commands = [{ name: "mcp", hasArgumentCompletions: true }] }) {
  const textarea = { selectionStart: caret ?? value.length };
  return callback("argQuery", { value, textareaRef: { current: textarea }, slashCommands: commands })();
}

/** handleKeyDown 的环境：只给参数菜单分支与「会不会发出去」需要的桩。 */
function keydownEnv({ argMenuOpen = true, argItems = [{ value: "token set ", label: "set" }], argActiveIndex = 0, isMobile = false } = {}) {
  const calls = { applied: [], prevented: 0, sent: 0, items: [], seq: 0, loading: [] };
  const env = {
    COMPOSITION_END_ENTER_GRACE_MS: 100,
    isComposingRef: { current: false },
    lastCompositionEndAtRef: { current: 0 },
    argMenuOpen,
    argItems,
    argActiveIndex,
    applyArgCompletion: (item) => calls.applied.push(item),
    setArgActiveIndex: () => {},
    argRequestSeqRef: { current: 0 },
    setArgItems: (next) => calls.items.push(next),
    setArgLoading: (next) => calls.loading.push(next),
    slashMenuOpen: false,
    slashQuery: null,
    filteredSlashCommands: [],
    slashActiveIndex: 0,
    applySlashCommand: () => {},
    getNextSlashIndex: () => 0,
    setSlashActiveIndex: () => {},
    setSlashMenuOpen: () => {},
    // 菜单可见性现在由 atMenuActive 汇总（`@` token 或插件结果），候选列表是统一的
    // atMenuItems（文件项 / 插件项，issue #101）。
    atMenuActive: false,
    atMenuOpen: false,
    atQuery: null,
    atMenuItems: [],
    atActiveIndex: 0,
    applyMenuItem: () => {},
    setAtActiveIndex: () => {},
    setAtMenuOpen: () => {},
    isStreaming: false,
    isMobile,
    streamingEnterDefault: "send",
    value: "/mcp tok",
    hasReadyUploads: false,
    queuedMessages: null,
    onSteer: undefined,
    onFollowUp: undefined,
    onAbort: undefined,
    onSendQueueAsSteer: undefined,
    flushQueueAsSteer: () => {},
    sendQueued: () => {},
    handleSend: () => { calls.sent += 1; },
    handlePromptWithStreamingBehavior: () => {},
  };
  const handler = callback("handleKeyDown", env);
  const event = (key, extra = {}) => ({
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    nativeEvent: { isComposing: false, keyCode: 0 },
    preventDefault: () => { calls.prevented += 1; },
    ...extra,
  });
  return { handler, calls, event, env };
}

test("argQuery：prefix 只看光标所在行、光标之前（pi-tui 同口径）", () => {
  assert.deepEqual(argQueryFor({ value: "/mcp tok" }), { name: "mcp", prefix: "tok" });
  assert.deepEqual(argQueryFor({ value: "/mcp tokZZZ", caret: 8 }), { name: "mcp", prefix: "tok" }, "光标之后的正文不算 prefix");
  assert.deepEqual(argQueryFor({ value: "/mcp ", caret: 5 }), { name: "mcp", prefix: "" }, "空 prefix 也参与（列第一级候选）");
  // 多行：只看光标那一行，不会因为别处有换行就整条失效
  assert.deepEqual(argQueryFor({ value: "/mcp a\n/mcp b" }), { name: "mcp", prefix: "b" });
  assert.equal(argQueryFor({ value: "/mcp a\nhello" }), null, "光标那行不是命令参数时不参与");
  assert.equal(argQueryFor({ value: "/plain tok", commands: [{ name: "plain" }] }), null, "没声明参数补全的命令不参与");
  assert.equal(argQueryFor({ value: "mcp tok" }), null, "命令名必须在行首");
});

test("handleKeyDown：候选到位后 Tab/Enter 拦截补全，不会把没补全的正文发出去（issue #75 阻断 1）", () => {
  for (const key of ["Enter", "Tab"]) {
    const { handler, calls, event } = keydownEnv();
    handler(event(key));
    assert.equal(calls.applied.length, 1, key + " 必须应用候选");
    assert.equal(calls.sent, 0, key + " 不能直接发消息");
    assert.ok(calls.prevented > 0, key + " 要拦下默认行为");
  }
});

test("handleKeyDown：没有候选时 Enter 照常走发送路径（不误拦）", () => {
  const { handler, calls, event } = keydownEnv({ argItems: [] });
  handler(event("Enter"));
  assert.equal(calls.applied.length, 0);
  assert.equal(calls.sent, 1, "没有候选就不该拦 Enter");
});

test("handleKeyDown：Escape 清空候选并作废在途请求（否则响应回来会把菜单又打开）", () => {
  const { handler, calls, event, env } = keydownEnv();
  handler(event("Escape"));
  assert.deepEqual(calls.items.at(-1), [], "候选要清空");
  assert.ok(env.argRequestSeqRef.current > 0, "序号必须递增（在途响应据此丢弃）");
  assert.ok(calls.prevented > 0);
});

test("源码契约：handleKeyDown 的依赖数组包含参数菜单的四个名字（阻断 1 不再复发）", () => {
  const source = readFileSync(SOURCE, "utf8");
  const tree = ts.createSourceFile("ChatInput.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let deps = null;
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && node.name.getText(tree) === "handleKeyDown"
      && node.initializer
      && ts.isCallExpression(node.initializer)
      && node.initializer.arguments.length > 1
    ) {
      deps = node.initializer.arguments[1].getText(tree);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(deps, "没有找到 handleKeyDown 的依赖数组");
  for (const name of ["argMenuOpen", "argItems", "argActiveIndex", "applyArgCompletion"]) {
    assert.ok(new RegExp("(^|[\\s,[])" + name + "([,\\]])").test(deps), "依赖数组缺 " + name + "：闭包会停在候选还没到的那一帧");
  }
});

test("源码契约：前缀变化时清空候选并作废在途请求（否则会显示不相干的旧候选/菜单自己弹回来）", () => {
  const source = readFileSync(SOURCE, "utf8");
  const idx = source.indexOf("const argQueryKey =");
  assert.ok(idx > 0, "缺 argQueryKey（前缀变化的判定）");
  const block = source.slice(idx, source.indexOf("}, [argQueryKey]);", idx) + "}, [argQueryKey]);".length);
  assert.ok(block.includes("argRequestSeqRef.current += 1"), "递增序号：在途响应据此丢弃");
  assert.ok(block.includes("setArgItems([])"), "旧候选要立刻清掉");
  assert.ok(block.includes("}, [argQueryKey]);"), "只绑前缀键，不绑每次新建的对象");
});

test("源码契约：取候选的 effect 依赖稳定原始值，而不是每次新建的 argQuery（否则每帧重发一次请求）", () => {
  const source = readFileSync(SOURCE, "utf8");
  assert.ok(
    source.includes("}, [argCommandName, argPrefix, onLoadCommandArgumentCompletions]);"),
    "effect 依赖必须是 name/prefix 的原始值 + 回调",
  );
  const effectStart = source.indexOf("if (argCommandName === null || argPrefix === null");
  const effectBody = source.slice(effectStart, source.indexOf("}, [argCommandName", effectStart));
  assert.ok(!effectBody.includes("argQuery"), "effect 体内不得引用 argQuery 对象（会被 exhaustive-deps 记一条）");
});
