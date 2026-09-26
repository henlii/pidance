import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldRouteKeyToExtensionListener } = await jiti.import("../lib/extension-panel-keys.ts");

const source = readFileSync(fileURLToPath(new URL("./useExtensionTerminalInput.ts", import.meta.url)), "utf8");
/** 只看 onKeyDown 的实现（文档注释里也会提到这些名字，不能拿全文件比位置）。 */
const handler = source.slice(source.indexOf("const onKeyDown"));

test("窗口 ① 先判、窗口 ③ 后判：白名单键不会被两个窗口各发一次", () => {
  const panelWindow = handler.indexOf("shouldRouteKeyToExtensionListener(event)");
  const surfaceWindow = handler.indexOf("resolveExtensionSurfaceKeyAction({");
  assert.ok(panelWindow > -1, "缺少窗口 ①（面板收起时的白名单）判定");
  assert.ok(surfaceWindow > -1, "缺少窗口 ③（插件界面显示中）判定");
  assert.ok(panelWindow < surfaceWindow, "顺序反了：白名单键必须先归窗口 ①");
  // 不重复发送靠的是窗口 ① 的分支**提前 return**：走到窗口 ③ 时那个键已经发过了。
  // （曾经用一个恒为 false 的入参 claimedByPanelWindow 表达这件事，是死参数，已删。）
  const panelBranch = handler.slice(panelWindow, surfaceWindow);
  assert.ok(/return;/.test(panelBranch), "窗口 ① 处理后必须 return，否则同一个键会走窗口 ③ 再发一次");
});

test("窗口 ③ 按「焦点落在哪个元素上」让位（不只是输入框/按钮）", () => {
  // 判据是通用的：目标 + document.activeElement。只传目标会退回「标签白名单」那套，
  // 壳自己的拖宽手柄 / 谱系树行 / 可聚焦的工具输出会被抢走按键（issue #102 审查阻断项）。
  assert.ok(handler.includes("isDomOwnedKeyTarget("), "未判断 DOM 归属");
  assert.ok(handler.includes("event.target"), "没用事件目标");
  assert.ok(handler.includes("document.activeElement"), "没把当前焦点元素传进去");
});

test("输入法：合成中与 compositionend 之后的宽限期都不路由（两个窗口都适用）", () => {
  assert.ok(source.includes("isImeComposing(event, compositionEndAtRef.current, now)"), "未用 isImeComposing 判定合成态");
  assert.ok(
    source.includes("compositionEndAtRef.current = Date.now() + IME_COMPOSITION_GRACE_MS"),
    "未使用合成结束的宽限期",
  );
  assert.ok(source.includes('window.addEventListener("compositionend"'), "未监听 compositionend");
  assert.ok(handler.indexOf("if (composing) return;") < handler.indexOf("shouldRouteKeyToExtensionListener(event)"), "输入法判定必须在两个窗口之前");
});

test("没有窗口成立时一次请求都不发（普通打字不能加往返）", () => {
  assert.ok(
    source.includes("if (!sessionId || (!hiddenPanelRouting && !surfaceRouting)) return;"),
    "缺少「两个窗口都不成立就直接返回」的门槛",
  );
});

test("两个窗口都不带 assertFocus（此时编辑器并不聚焦，断言它会骗插件）", () => {
  // 窗口 ② 才带 assertFocus：那里输入框真的聚焦。见本文件的模块注释与 issue #102。
  // 只看处理函数体：文档注释里也写着这个名字，比全文件会得到恒真的结果（#96 那轮的教训）。
  assert.ok(!handler.includes("assertFocus"), "窗口 ①② 不该断言编辑器焦点");
  assert.ok(source.includes('type: "terminal_input"'), "未发送 terminal_input 命令");
});

test("卸载时两个监听器都要摘掉", () => {
  assert.ok(
    source.includes('window.removeEventListener("keydown", onKeyDown, true)'),
    "未摘 keydown",
  );
  assert.ok(
    source.includes('window.removeEventListener("compositionend", onCompositionEnd, true)'),
    "未摘 compositionend",
  );
});

/**
 * 窗口 ① 的判定表达式（含 #107 加进来的接管 keytrap 让位）。
 *
 * 这里抽**真实表达式**求值，而不是拿字符串比对源码：让位条件（事件目标落在接管 keytrap 里）
 * 是个布尔语义，源码断言看不出「反过来写」或「直接短路掉整个窗口 ①」。
 */
function extractPanelWindowCondition() {
  const text = readFileSync(fileURLToPath(new URL("./useExtensionTerminalInput.ts", import.meta.url)), "utf8");
  const tree = ts.createSourceFile("hook.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node)
      && node.name.getText(tree) === "panelWindowClaimsTheKey"
      && node.initializer) {
      expression = node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, "没有找到 panelWindowClaimsTheKey 的判定表达式");
  const js = ts.transpileModule("const value = " + expression + ";", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return (env) => new Function(...Object.keys(env), js + "; return value;")(...Object.values(env));
}

const panelWindow = extractPanelWindowCondition();
/** 一个「白名单键」的事件（Escape 属于 shouldRouteKeyToExtensionListener 的白名单）。 */
const keyEvent = (target) => ({ key: "Escape", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, target });
const OTHER = { id: "other" };
const KEYTRAP = { id: "keytrap" };

function decide({ hiddenPanelRouting = true, keytrap = null, target = OTHER, event = keyEvent(target) } = {}) {
  return panelWindow({
    hiddenPanelRouting,
    shouldRouteKeyToExtensionListener,
    takeoverKeytrap: () => keytrap,
    event,
  });
}

test("窗口 ①：事件目标在接管 keytrap 里时让位（键归被接管的插件编辑器）", () => {
  const keytrap = { contains: (node) => node === KEYTRAP };
  assert.equal(
    decide({ keytrap, target: KEYTRAP, event: keyEvent(KEYTRAP) }),
    false,
    "焦点在接管面板里时，白名单键不该被窗口 ① 抢走（它要进插件的 handleInput）",
  );
});

test("窗口 ①：焦点不在接管面板里时照旧归插件（不能因为「接管显示」就整段停手）", () => {
  const keytrap = { contains: (node) => node === KEYTRAP };
  assert.equal(
    decide({ keytrap, target: OTHER, event: keyEvent(OTHER) }),
    true,
    "焦点在消息列表时，收起面板的白名单键仍要能到插件（评审给的反例）",
  );
  assert.equal(decide({ keytrap: null }), true, "没有接管 keytrap 时行为与引入前完全一致");
});

test("窗口 ①：面板没被收起时本来就不发（确认上面两条不是恒真）", () => {
  assert.equal(decide({ hiddenPanelRouting: false }), false, "hiddenPanelRouting 为假时窗口 ① 不该接管按键");
});
