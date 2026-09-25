import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(fileURLToPath(new URL("./useExtensionTerminalInput.ts", import.meta.url)), "utf8");
/** 只看 onKeyDown 的实现（文档注释里也会提到这些名字，不能拿全文件比位置）。 */
const handler = source.slice(source.indexOf("const onKeyDown"));

test("窗口 ① 先判、窗口 ③ 后判：白名单键不会被两个窗口各发一次", () => {
  const panelWindow = handler.indexOf("shouldRouteKeyToExtensionListener(event)");
  const surfaceWindow = handler.indexOf("resolveExtensionSurfaceKeyAction({");
  assert.ok(panelWindow > -1, "缺少窗口 ①（面板收起时的白名单）判定");
  assert.ok(surfaceWindow > -1, "缺少窗口 ③（插件界面显示中）判定");
  assert.ok(panelWindow < surfaceWindow, "顺序反了：白名单键必须先归窗口 ①");
  // 窗口 ③ 的入参里要带上「已被窗口 ① 认领」，否则同一个键会被发两次
  assert.ok(
    handler.includes("claimedByPanelWindow,"),
    "窗口 ③ 不知道按键已被窗口 ① 认领，会重复发送",
  );
});

test("窗口 ③ 按「事件目标有没有 DOM 归属者」让位（输入框/面板 keytrap/按钮优先）", () => {
  assert.ok(handler.includes("isDomOwnedKeyTarget(event.target"), "未按事件目标判断 DOM 归属");
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
