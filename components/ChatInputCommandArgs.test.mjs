/**
 * 斜杠命令参数补全的替换语义（issue #75）。
 *
 * 从真实 ChatInput 源码里抽出 `applyArgCompletion` 驱动（与 ChatInputSendOwnership
 * 同一手法：不渲染整个输入框，只验证替换区间与光标位置这些**可断言的行为**）：
 * - 替换的是参数区间（命令名之后到光标处），光标之后的正文原样保留；
 * - 不额外补空格（候选 value 自己带空格时才留空格，与 pi-tui 的 applyCompletion 一致）；
 * - 插入后光标停在插入内容末尾，并把焦点还给输入框。
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
      expression = node.initializer.arguments[0].getText(tree);
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
