import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldCaptureCustomPanelKey, shouldRouteKeyToExtensionListener, resolveExtensionWidgetKeyAction, isPlainCharacterKey,
  nextWidgetInteractionState, isWidgetInteractionLive, isWidgetLeavingKey, isImeComposing, initialState, WIDGET_INTERACTION_TTL_MS,
  resolveExtensionSurfaceKeyAction, isDomOwnedKeyTarget, isBrowserReservedCtrlChord, BROWSER_RESERVED_CTRL_KEYS, isShellReservedCtrlChord, SHELL_RESERVED_CTRL_KEYS, EXTENSION_KEYTRAP_SELECTOR,
  SHELL_KEY_OWNING_SELECTOR, IME_COMPOSITION_GRACE_MS, shouldReturnComposerFocus } = await jiti.import("./extension-panel-keys.ts");

test("有选区时 Ctrl/Cmd+C 不转成 TUI 中断", () => {
  assert.equal(shouldCaptureCustomPanelKey({ key: "c", ctrlKey: true, metaKey: false }, "copied"), false);
  assert.equal(shouldCaptureCustomPanelKey({ key: "c", ctrlKey: false, metaKey: true }, "copied"), false);
  assert.equal(shouldCaptureCustomPanelKey({ key: "c", ctrlKey: true, metaKey: false }, ""), true);
});

test("Ctrl/Cmd+A 始终留给浏览器全选", () => {
  assert.equal(shouldCaptureCustomPanelKey({ key: "a", ctrlKey: true, metaKey: false }, ""), false);
  assert.equal(shouldCaptureCustomPanelKey({ key: "ArrowDown", ctrlKey: false, metaKey: false }, "sel"), true);
});

// ---------------------------------------------------------------------------
// 面板收起后路由给插件监听器（ctx.ui.onTerminalInput）的白名单
// ---------------------------------------------------------------------------

const key = (over) => ({ key: "", ctrlKey: false, altKey: false, metaKey: false, ...over });

test("Escape 与 F1–F12 交给插件（前端在这些键上没有必须保留的语义）", () => {
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "Escape" })), true);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "F1" })), true);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "F12" })), true);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "F13" })), false);
});

test("Ctrl/Alt + 非保留字符键交给插件", () => {
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "u", ctrlKey: true })), true);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "]", ctrlKey: true })), true);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "o", altKey: true })), true);
});

test("浏览器保留的 Ctrl 组合与 Cmd 组合不问插件", () => {
  for (const reserved of ["a", "c", "v", "x", "z", "w", "t", "s", "p", "n", "f", "r", "l", "o"]) {
    assert.equal(
      shouldRouteKeyToExtensionListener(key({ key: reserved, ctrlKey: true })),
      false,
      `Ctrl+${reserved}`,
    );
  }
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "u", metaKey: true })), false);
});

test("方向键/Home/End/翻页/Enter/Tab 留给输入框与滚动", () => {
  for (const kept of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Enter", "Tab", "Backspace", "Delete"]) {
    assert.equal(
      shouldRouteKeyToExtensionListener(key({ key: kept, ctrlKey: true })),
      false,
      `${kept} 不该被路由`,
    );
  }
});

test("普通可打印字符不路由（否则会抢走打字）", () => {
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "a" })), false);
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: "1" })), false);
});

test("Ctrl/Alt + 空格留给浏览器（输入法切换）", () => {
  assert.equal(shouldRouteKeyToExtensionListener(key({ key: " ", ctrlKey: true })), false);
});


// ---------------------------------------------------------------------------
// 插件 widget 的按键决策（hooks/useExtensionWidgetKeys 的执行依据）
// ---------------------------------------------------------------------------
const widgetKey = (overrides = {}) => ({
  key: "ArrowDown", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
  composing: false, interactive: false, ...overrides,
});

test("未进入选择态：只有 ↓/← 拿去问插件，其余键不动", () => {
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowDown" })), "route-activation");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowLeft" })), "route-activation");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowUp" })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowRight" })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "Enter" })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "Escape" })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "j" })), "ignore");
});

test("选择态内：导航白名单路由，其它键立刻退出且不被吞", () => {
  for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "j", "k", "Enter", "Escape"]) {
    assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key, interactive: true })), "route-navigation", key);
  }
  // 非白名单键：退出选择态，按键还给输入框（不问插件）
  for (const key of ["a", "x", "1", " ", "Backspace", "Tab", "Home"]) {
    assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key, interactive: true })), "exit-interaction", key);
  }
});

test("修饰键与选区操作不参与：Shift+Enter 是换行、Shift+方向键是选区", () => {
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "Enter", shiftKey: true, interactive: true })), "exit-interaction");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowDown", shiftKey: true })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowDown", shiftKey: true, interactive: true })), "exit-interaction");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "k", shiftKey: true, interactive: true })), "exit-interaction");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "ArrowDown", ctrlKey: true })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ key: "Enter", metaKey: true, interactive: true })), "ignore");
});

test("输入法合成中一律不参与", () => {
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ composing: true })), "ignore");
  assert.equal(resolveExtensionWidgetKeyAction(widgetKey({ composing: true, interactive: true })), "ignore");
});

test("可打印字符的 TUI 字节：j/k 导航要能编码出字符本身", () => {
  assert.equal(isPlainCharacterKey(widgetKey({ key: "j" })), true);
  assert.equal(isPlainCharacterKey(widgetKey({ key: "k" })), true);
  assert.equal(isPlainCharacterKey(widgetKey({ key: "ArrowDown" })), false);
  assert.equal(isPlainCharacterKey(widgetKey({ key: "j", ctrlKey: true })), false);
});

// ---------------------------------------------------------------------------
// 修复轮（审查阻断项）：本地选择态的迁移与保鲜期
// ---------------------------------------------------------------------------
const routed = (over={}) => ({ action: "route-navigation", key: "ArrowDown", consumed: true, now: 1_000, ...over });

test("阻断项：Esc/Enter 被插件消费也必须清零本地选择态（否则字母键与回车被吞）", () => {
  for (const key of ["Escape", "Enter"]) {
    const next = nextWidgetInteractionState({ interactive: true, lastRoutedAt: 0 }, routed({ key, consumed: true }));
    assert.equal(next.interactive, false, key + " 被消费后本地仍是选择态 = 下一发 j/k/Enter 会被拦下吞掉");
  }
  assert.equal(isWidgetLeavingKey("Escape"), true);
  assert.equal(isWidgetLeavingKey("Enter"), true);
  assert.equal(isWidgetLeavingKey("ArrowDown"), false);
});

test("导航键被消费时保持选择态（不然 j/k 导航只走一步）", () => {
  for (const key of ["ArrowUp", "ArrowDown", "j", "k"]) {
    const next = nextWidgetInteractionState({ interactive: true, lastRoutedAt: 500 }, routed({ key }));
    assert.equal(next.interactive, true, key);
    assert.equal(next.lastRoutedAt, 1_000, key + "：路由时刻要刷新，否则会被保鲜期误判过期");
  }
});

test("激活键按插件是否消费决定选择态", () => {
  const activation = { action: "route-activation", key: "ArrowDown", now: 2_000 };
  assert.equal(nextWidgetInteractionState(initialState(), { ...activation, consumed: true }).interactive, true);
  assert.equal(nextWidgetInteractionState(initialState(), { ...activation, consumed: false }).interactive, false);
});

test("非导航键立刻退出选择态，且不刷新路由时刻", () => {
  const next = nextWidgetInteractionState({ interactive: true, lastRoutedAt: 300 }, routed({ action: "exit-interaction", key: "a", consumed: false, now: 9_000 }));
  assert.equal(next.interactive, false);
  assert.equal(next.lastRoutedAt, 300);
});

test("保鲜期：超过 WIDGET_INTERACTION_TTL_MS 没路由过按键就不算在选择态", () => {
  const state = { interactive: true, lastRoutedAt: 10_000 };
  assert.equal(isWidgetInteractionLive(state, 10_000 + WIDGET_INTERACTION_TTL_MS), true, "刚好到期仍算在内");
  assert.equal(isWidgetInteractionLive(state, 10_001 + WIDGET_INTERACTION_TTL_MS), false, "超期必须视为已离开");
  assert.equal(isWidgetInteractionLive({ interactive: false, lastRoutedAt: 10_000 }, 10_000), false);
});

test("输入法：isComposing / keyCode 229 / 合成结束宽限期都算合成中", () => {
  assert.equal(isImeComposing({ isComposing: true }, 0, 5_000), true);
  assert.equal(isImeComposing({ keyCode: 229 }, 0, 5_000), true, "部分输入法只给 keyCode 229");
  assert.equal(isImeComposing({}, 6_000, 5_000), true, "compositionend 之后仍在宽限期内");
  assert.equal(isImeComposing({}, 6_000, 7_000), false, "宽限期已过");
  assert.equal(isImeComposing({}, 0, 5_000), false);
});

// ---------------------------------------------------------------------------
// 窗口 ③：插件界面**显示中**（可见的 custom 面板 / overlay / 扩展对话框）时的按键归属
//
// 优先级表（hooks/useExtensionTerminalInput.ts 的实现必须按这个顺序判定）：
//   1. 事件目标有 DOM 归属者 → 归 DOM（这一条覆盖「输入框聚焦时维持现状」）
//   2. 输入框聚焦且无面板 → 窗口 ②（useExtensionWidgetKeys）
//   3. 面板被收起 → 窗口 ①（白名单）
//   4. 插件界面显示中 → 窗口 ③
// ---------------------------------------------------------------------------

const surfaceKey = (over) => ({
  key: "",
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  composing: false,
  domOwned: false,
  ...over,
});

test("窗口 ③：事件目标已有 DOM 归属者时不抢（输入框本身 / 面板 keytrap / 按钮）", () => {
  // 这一条同时是「输入框聚焦时维持现状」的实现：输入框聚焦时 keydown 的目标就是那个 textarea。
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "j", domOwned: true })), "ignore");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "ArrowDown", domOwned: true })), "ignore");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Enter", domOwned: true })), "ignore");
  // 没有归属者时同一个键才交给插件
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "j" })), "route");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "ArrowDown" })), "route");
});

test("窗口 ③：输入法合成中不路由（合成提交那一下不能被插件吃掉）", () => {
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Enter", composing: true })), "ignore");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Escape", composing: true })), "ignore");
  // 宽限期本身由钩子用 isImeComposing 计算；这里锁住常量存在且非零
  assert.ok(IME_COMPOSITION_GRACE_MS > 0, "合成结束的宽限期必须是正数");
});

test("窗口 ③：白名单键不在这里判（归窗口 ①，顺序由钩子保证）", () => {
  // 曾经把这个信息塞进入参 `claimedByPanelWindow`，但钩子在调用前就已经 return 了，
  // 那个字段恒为 false —— 死参数会让人以为「重复发送」是在这里防的。顺序由钩子的提前返回
  // 保证（见 hooks/useExtensionTerminalInput.test.mjs）。
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Escape" })), "route");
  assert.equal("claimedByPanelWindow" in surfaceKey({}), false, "入参里不该再有这个恒假的字段");
});

test("窗口 ③：Cmd(Meta) 与 Tab 留给浏览器/系统", () => {
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "c", metaKey: true })), "ignore");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "ArrowUp", metaKey: true })), "ignore");
  // Tab 是无障碍的焦点遍历：面板/对话框里的按钮只能靠它到达
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Tab" })), "ignore");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "Tab", shiftKey: true })), "ignore");
});

test("保留键全表：15 个浏览器 Ctrl 组合在窗口 ① 与窗口 ③ 都不能被拦下", () => {
  const expected = ["a", "c", "v", "x", "z", "y", "p", "s", "f", "n", "t", "w", "r", "l", "o"];
  assert.deepEqual([...BROWSER_RESERVED_CTRL_KEYS].sort(), [...expected].sort());
  for (const letter of expected) {
    assert.equal(isBrowserReservedCtrlChord({ key: letter, ctrlKey: true }), true, "Ctrl+" + letter);
    // 大写也一样（浏览器不区分）
    assert.equal(isBrowserReservedCtrlChord({ key: letter.toUpperCase(), ctrlKey: true }), true, "Ctrl+" + letter.toUpperCase());
    assert.equal(
      shouldRouteKeyToExtensionListener({ key: letter, ctrlKey: true, altKey: false, metaKey: false }),
      false,
      "窗口 ① 拦住了 Ctrl+" + letter,
    );
    assert.equal(
      resolveExtensionSurfaceKeyAction(surfaceKey({ key: letter, ctrlKey: true })),
      "ignore",
      "窗口 ③ 拦住了 Ctrl+" + letter,
    );
  }
  // Ctrl+Space 是输入法切换
  assert.equal(isBrowserReservedCtrlChord({ key: " ", ctrlKey: true }), true);
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: " ", ctrlKey: true })), "ignore");
  // 没被浏览器占用的组合仍然交给插件（窗口 ① 早就这么做了）
  assert.equal(isBrowserReservedCtrlChord({ key: "g", ctrlKey: true }), false);
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "g", ctrlKey: true })), "route");
  // 壳自己的键位（Ctrl+K 命令面板）两个窗口都不让渡 —— 依据 TUI 的 app 保留键位规则
  assert.deepEqual([...SHELL_RESERVED_CTRL_KEYS], ["k"]);
  assert.equal(isShellReservedCtrlChord({ key: "K", ctrlKey: true }), true);
  assert.equal(isShellReservedCtrlChord({ key: "k", ctrlKey: false }), false, "不带 Ctrl 的 k 是普通字符");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "k", ctrlKey: true })), "ignore", "窗口 ③ 抢走了 Ctrl+K");
  assert.equal(
    shouldRouteKeyToExtensionListener({ key: "k", ctrlKey: true, altKey: false, metaKey: false }),
    false,
    "窗口 ① 抢走了 Ctrl+K",
  );
  // Cmd+K（命令面板的另一半）本来就因 Meta 被排除
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "k", metaKey: true })), "ignore");
});

test("窗口 ③：其余按键交给插件的全局监听器", () => {
  for (const key of ["j", "k", "q", "1", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Home", "End", "PageUp", "PageDown", "Backspace", " ", "F1", "F12"]) {
    assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key })), "route", key);
  }
  // Alt+字符 与 Shift 组合（Shift+方向键是选区，但在插件界面里也一样交给插件）
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "x", altKey: true })), "route");
  assert.equal(resolveExtensionSurfaceKeyAction(surfaceKey({ key: "ArrowUp", shiftKey: true })), "route");
});

/**
 * 造一个「真实 DOM 元素」形状的假对象。
 *
 * 旧实现只认一张标签白名单，于是壳自己那几处「聚焦后用方向键做事」的控件（拖宽手柄、
 * 谱系树行、可聚焦的工具输出）会被抢走按键（issue #102 审查的阻断项）。现在的判据是
 * 「焦点落在任何真实元素上」，所以假对象要能表达「谁被聚焦了」。
 */
function fakeDom() {
  const doc = {};
  const body = { ownerDocument: doc, contains: (node) => node === body };
  const documentElement = { ownerDocument: doc, contains: (node) => node === documentElement };
  doc.body = body;
  doc.documentElement = documentElement;
  return { doc, body, documentElement };
}

/** 一个可聚焦的真实元素：`closest` 只认壳模态标记（与真实 DOM 里其它选择器无关）。 */
function focusable({ inModal = false } = {}) {
  const { doc } = fakeDom();
  const node = {
    ownerDocument: doc,
    closest: (selector) => (selector === SHELL_KEY_OWNING_SELECTOR && inModal ? node : null),
    contains: (other) => other === node,
  };
  return node;
}

test("归属判据：插件面板自己的 keytrap 不算「DOM 归属」，按键必须留给插件", () => {
  // 面板打开时（默认 focus: 'panel'）会把焦点放到自己的 textarea keytrap 上，
  // 它拿焦点只是为了让按键有落点。若把它判成 DOM 归属，插件一个键都收不到 ——
  // 用户看到的就是「面板无法操作」。
  const keytrap = {
    ownerDocument: fakeDom().doc,
    closest: (selector) => (selector === EXTENSION_KEYTRAP_SELECTOR ? keytrap : null),
    contains: (other) => other === keytrap,
  };
  assert.equal(isDomOwnedKeyTarget(keytrap, keytrap), false, "keytrap 聚焦时按键要留给插件");
  assert.equal(isDomOwnedKeyTarget(keytrap, null), false);
  assert.equal(isDomOwnedKeyTarget(null, keytrap), false, "焦点在 keytrap、事件目标缺失也不算归属");
  // 对照组：同一时刻若焦点真在壳的控件上，仍归 DOM（不能为了修插件而把壳的控件交出去）。
  const shellControl = focusable();
  assert.equal(isDomOwnedKeyTarget(shellControl, shellControl), true, "壳控件仍必须保住按键");
  assert.equal(isDomOwnedKeyTarget(keytrap, shellControl), false, "目标是 keytrap、焦点在壳控件 → 仍留给插件");
});

test("归属判据：焦点落在任何真实元素上都归 DOM（不只是输入框/按钮）", () => {
  // 壳自己的键盘面：拖宽手柄（role="separator" + tabIndex=0）、谱系树行（role="treeitem"）、
  // 可聚焦的工具输出 <pre tabIndex={0}>。它们聚焦后本来就用方向键做事。
  for (const name of ["拖宽手柄", "谱系树行", "工具输出 pre", "输入框", "壳模态里的控件", "按钮"]) {
    const focused = focusable();
    assert.equal(
      isDomOwnedKeyTarget(focused, focused),
      true,
      name + " 聚焦时按键必须归它（否则窗口 ③ 会抢走）",
    );
  }
});

test("归属判据：没人聚焦（body/documentElement）时不归 DOM，按键交给插件", () => {
  const { body, documentElement } = fakeDom();
  // 窗口 ③ 的主场景：面板正文那个 <pre> 没有 tabIndex，点它焦点落在 body
  const panelBody = { ownerDocument: body.ownerDocument, closest: () => null, contains: () => false };
  assert.equal(isDomOwnedKeyTarget(panelBody, body), false, "焦点在 body → 没有归属者");
  assert.equal(isDomOwnedKeyTarget(body, body), false);
  assert.equal(isDomOwnedKeyTarget(documentElement, documentElement), false, "documentElement 同样不算");
  assert.equal(isDomOwnedKeyTarget(panelBody, null), false, "没有焦点元素");
  assert.equal(isDomOwnedKeyTarget(null, null), false);
  assert.equal(isDomOwnedKeyTarget(undefined, undefined), false);
  assert.equal(isDomOwnedKeyTarget({}, {}), false, "没有 closest/contains 的目标");
});

test("归属判据：目标在焦点元素内部也算归它", () => {
  const focused = focusable();
  const inner = { ownerDocument: focused.ownerDocument, closest: () => null, contains: () => false };
  focused.contains = (other) => other === focused || other === inner;
  assert.equal(isDomOwnedKeyTarget(inner, focused), true);
});

test("归属判据：壳自有模态即使焦点落到 body 也归它（标记与焦点无关）", () => {
  // ViewportDialog 打开时会主动聚焦自己的面板，但用户点到背景上焦点会落回 body；
  // 那条路只能靠专属标记兜住（否则 Escape 关不掉模态）。
  const inModal = focusable({ inModal: true });
  const { body } = fakeDom();
  inModal.ownerDocument = body.ownerDocument;
  assert.equal(isDomOwnedKeyTarget(inModal, body), true);
  // 插件面板外壳（ExtensionPanelChrome）不能用这个标记，它是窗口 ③ 的主场景
  const chrome = readFileSync(new URL("../components/ExtensionPanelChrome.tsx", import.meta.url), "utf8");
  assert.ok(!chrome.includes("data-pidance-modal"), "插件面板外壳不该带壳模态标记");
});

test("壳上那几处控件的 tabIndex 确实存在（假对象要跟现实一致）", () => {
  // 假对象假定这些控件可聚焦；若它们哪天去掉了 tabIndex，上面的判据就失去现实依据。
  const appShell = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  assert.ok(
    /role="separator"[\s\S]{0,200}?tabIndex=\{0\}/.test(appShell),
    "拖宽手柄应带 role=separator + tabIndex=0",
  );
  const lineage = readFileSync(new URL("../components/SessionLineage.tsx", import.meta.url), "utf8");
  assert.ok(/role="treeitem"\s+tabIndex=\{-1\}/.test(lineage), "谱系树行应带 tabIndex");
  const messageView = readFileSync(new URL("../components/MessageView.tsx", import.meta.url), "utf8");
  assert.ok(/<pre\s+tabIndex=\{0\}/.test(messageView), "工具输出应可聚焦");
});

test("归属判据：closest 抛错时按「有归属」处理（拿不准就不抢）", () => {
  const { body } = fakeDom();
  const activeElement = focusable();
  activeElement.ownerDocument = body.ownerDocument;
  activeElement.contains = () => {
    throw new Error("boom");
  };
  assert.equal(isDomOwnedKeyTarget(activeElement, activeElement), true, "目标就是焦点元素");
  const target = {
    ownerDocument: body.ownerDocument,
    contains: () => false,
    closest: () => {
      throw new Error("boom");
    },
  };
  assert.equal(isDomOwnedKeyTarget(target, body), true, "closest 抛错 → 不抢");
});

// ---------------------------------------------------------------------------
// 插件界面关掉后归还输入框焦点（原实现只有源码字符串锁，这里给行为测试）
// ---------------------------------------------------------------------------

test("归还焦点：由有变无且焦点没人接管时才还", () => {
  const { body, documentElement } = fakeDom();
  assert.equal(
    shouldReturnComposerFocus({ wasSurfaceActive: true, surfaceActive: false, activeElement: body }),
    true,
    "面板卸载后焦点落在 body → 该还给输入框",
  );
  assert.equal(
    shouldReturnComposerFocus({ wasSurfaceActive: true, surfaceActive: false, activeElement: null }),
    true,
  );
  assert.equal(
    shouldReturnComposerFocus({
      wasSurfaceActive: true,
      surfaceActive: false,
      activeElement: documentElement,
    }),
    true,
  );
});

test("归还焦点：用户已经在别处打字时不许抢（侧栏搜索框）", () => {
  const searchInput = focusable();
  assert.equal(
    shouldReturnComposerFocus({
      wasSurfaceActive: true,
      surfaceActive: false,
      activeElement: searchInput,
    }),
    false,
  );
  // 界面还开着 / 本来就没开过：都不动手
  assert.equal(
    shouldReturnComposerFocus({ wasSurfaceActive: true, surfaceActive: true, activeElement: null }),
    false,
  );
  assert.equal(
    shouldReturnComposerFocus({ wasSurfaceActive: false, surfaceActive: false, activeElement: null }),
    false,
  );
});
