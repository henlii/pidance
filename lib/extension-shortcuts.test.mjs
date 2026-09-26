/**
 * 扩展快捷键的可用性判定与按键匹配（issue #105）。
 *
 * 这里锁的是**纯规则**：宿主（设置清单）与客户端（按键匹配）都读同一份结论，
 * 所以任何一条判反了都必须在两边同时可见 —— 单测就盯这些边界。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  normalizeShortcutKey,
  shortcutAvailability,
  keyIdFromKeyboardEvent,
  matchesExtensionShortcut,
  formatShortcutKey,
  classifyExtensionShortcuts,
  buildEffectiveKeybindings,
  pickBoundShortcut,
  RESERVED_LEGACY_KEYBINDING_NAMES,
  shortcutListState,
} = await jiti.import("./extension-shortcuts.ts");

const event = (overrides) => ({
  key: "a",
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...overrides,
});

test("归一化：小写、修饰符顺序固定、重复去重；认不出的一律 null", () => {
  assert.equal(normalizeShortcutKey("Ctrl+Alt+N"), "ctrl+alt+n");
  assert.equal(normalizeShortcutKey("shift+ctrl+p"), "ctrl+shift+p", "修饰符顺序必须归一");
  assert.equal(normalizeShortcutKey("ctrl+shift+p"), "ctrl+shift+p");
  assert.equal(normalizeShortcutKey("ctrl+ctrl+a"), "ctrl+a", "重复修饰符去重");
  assert.equal(normalizeShortcutKey("super+k"), "super+k");
  assert.equal(normalizeShortcutKey("f12"), "f12");
  // 认不出的：非字符串、空串、未知修饰符、只有修饰符
  assert.equal(normalizeShortcutKey(undefined), null);
  assert.equal(normalizeShortcutKey(""), null);
  assert.equal(normalizeShortcutKey("  "), null);
  assert.equal(normalizeShortcutKey("hyper+a"), null, "未知修饰符不猜");
  assert.equal(normalizeShortcutKey("ctrl+"), null, "只有修饰符没有键");
  assert.equal(normalizeShortcutKey("ctrl+alt"), null, "全是修饰符也不是键");
});

test("可用性：浏览器保留的组合一律不可绑", () => {
  for (const key of ["ctrl+a", "ctrl+c", "ctrl+v", "ctrl+w", "ctrl+t", "ctrl+n", "ctrl+space"]) {
    assert.deepEqual(
      shortcutAvailability(key),
      { available: false, reason: "browser-reserved" },
      `${key} 应交给浏览器`,
    );
  }
  assert.deepEqual(shortcutAvailability("super+t"), { available: false, reason: "browser-reserved" }, "macOS Cmd 同表");
  assert.deepEqual(shortcutAvailability("alt+left"), { available: false, reason: "browser-reserved" }, "Alt+左右是前进后退");
  assert.deepEqual(shortcutAvailability("alt+right"), { available: false, reason: "browser-reserved" });
});

test("可用性：壳自己占用的键不可绑（命令面板 Ctrl/Cmd+K、Escape）", () => {
  assert.deepEqual(shortcutAvailability("ctrl+k"), { available: false, reason: "shell-reserved" });
  assert.deepEqual(shortcutAvailability("super+k"), { available: false, reason: "shell-reserved" });
  assert.deepEqual(shortcutAvailability("escape"), { available: false, reason: "shell-reserved" });
});

test("可用性：打字/编辑键判冲突，F 键与带修饰键判可用", () => {
  for (const key of ["x", "enter", "tab", "space", "up", "down", "home", "end", "pageup", "backspace", "delete"]) {
    assert.deepEqual(
      shortcutAvailability(key),
      { available: false, reason: "typing-conflict" },
      `${key} 在 Web 上分不清打字与快捷键`,
    );
  }
  // 这两条**原来的期望是错的**（issue #105 审查指出）：F5 是浏览器刷新、Ctrl+Alt+N 是壳的新建会话。
  // 改判据而不是改测试口径：绑上之后命中即 preventDefault，等于把刷新/新建会话从用户手里抢走。
  assert.deepEqual(shortcutAvailability("f6"), { available: true }, "F 键不与输入冲突");
  assert.deepEqual(
    shortcutAvailability("f5"),
    { available: false, reason: "browser-reserved" },
    "F5 是刷新（Shift+F5 是强制刷新）",
  );
  assert.deepEqual(shortcutAvailability("shift+f5"), { available: false, reason: "browser-reserved" });
  assert.deepEqual(
    shortcutAvailability("ctrl+alt+n"),
    { available: false, reason: "shell-reserved" },
    "Ctrl+Alt+N 是壳的新建会话（hooks/useKeyboardShortcuts.ts），壳只在有活动项目时处理它，那条条件没法静态表达",
  );
  assert.deepEqual(
    shortcutAvailability("ctrl+p"),
    { available: false, reason: "browser-reserved" },
    "Ctrl+P 是浏览器打印",
  );
  assert.deepEqual(
    shortcutAvailability("alt+x"),
    { available: false, reason: "browser-reserved" },
    "Alt+字母在浏览器里会激活菜单栏（Firefox 尤其），不敢绑",
  );
  assert.deepEqual(shortcutAvailability("ctrl+shift+7"), { available: true });
  assert.deepEqual(
    shortcutAvailability("ctrl+alt+p"),
    { available: true },
    "带 Ctrl 的 Alt 组合不是菜单栏激活，也不是浏览器键",
  );
  assert.deepEqual(
    shortcutAvailability("hyper+a"),
    { available: false, reason: "typing-conflict" },
    "认不出的键如实列不可用，不猜",
  );
});

test("事件匹配：修饰符、Shift 数字反查、Super 映射、认不出的事件不匹配", () => {
  assert.equal(matchesExtensionShortcut("ctrl+alt+n", event({ key: "n", ctrlKey: true, altKey: true })), true);
  assert.equal(matchesExtensionShortcut("ctrl+alt+n", event({ key: "n", ctrlKey: true })), false, "少一个修饰符不匹配");
  assert.equal(
    matchesExtensionShortcut("ctrl+shift+1", event({ key: "!", ctrlKey: true, shiftKey: true })),
    true,
    "Shift 后的符号要反查到数字键",
  );
  assert.equal(
    matchesExtensionShortcut("shift+ctrl+p", event({ key: "P", ctrlKey: true, shiftKey: true })),
    true,
    "插件侧顺序不同也要匹配",
  );
  assert.equal(matchesExtensionShortcut("super+k", event({ key: "k", metaKey: true })), true, "meta → super");
  assert.equal(matchesExtensionShortcut("f5", event({ key: "F5" })), true);
  assert.equal(matchesExtensionShortcut("escape", event({ key: "Escape" })), true);
  assert.equal(matchesExtensionShortcut("ctrl+a", event({ key: "Dead", ctrlKey: true })), false, "认不出的键不匹配");
  assert.equal(keyIdFromKeyboardEvent(event({ key: "Unidentified" })), null);
  assert.equal(keyIdFromKeyboardEvent(event({ key: "ArrowDown" })), "down");
  assert.equal(keyIdFromKeyboardEvent(event({ key: "F12" })), "f12");
});

test("界面文案：修饰符与具名键首字母大写", () => {
  assert.equal(formatShortcutKey("ctrl+alt+n"), "Ctrl+Alt+N");
  assert.equal(formatShortcutKey("shift+ctrl+p"), "Ctrl+Shift+P");
  assert.equal(formatShortcutKey("f5"), "F5");
  assert.equal(formatShortcutKey("escape"), "Escape");
  assert.equal(formatShortcutKey("hyper+a"), "hyper+a", "认不出时原样返回");
});

test("清单：补上可用性、归一化键名、保持宿主给的顺序", () => {
  const entries = classifyExtensionShortcuts([
    { key: "ctrl+alt+p", description: "Panel", extensionPath: "/a" },
    { key: "ctrl+k", description: "Taken", extensionPath: "/a" },
    { key: "x", extensionPath: "/b" },
  ]);
  assert.deepEqual(entries.map((entry) => entry.key), ["ctrl+alt+p", "ctrl+k", "x"]);
  assert.deepEqual(
    entries.map((entry) => entry.available),
    [true, false, false],
  );
  assert.equal(entries[0].description, "Panel");
  assert.equal(entries[1].reason, "shell-reserved");
  assert.equal(entries[2].reason, "typing-conflict");
});

/**
 * SDK 认为「扩展不得覆盖」的 18 个键位（`RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS`）。
 * 这里**从 SDK 源码读它们的默认键**再逐条断言：SDK 把某个默认键换掉而我们的规则没跟上时，
 * 这条会红（否则会静默出现「TUI 里保留、Web 上被插件抢走」的键）。
 *
 * 宿主（issue #105 审查后）给 `getShortcuts` 传的是**有效键位**（pi-tui 的默认键位 + 用户覆盖），
 * 所以 tui.* 的保留键位由 SDK 自己跳过、并且能在设置里显示 SDK 的诊断原文。
 *
 * 但 SDK 的 app.* 默认键位不在 pi-tui 的表里（那份 `KEYBINDINGS` 没从包入口导出），本项目不复制它
 * （平台条件值复制必然漂移），所以这里的用例要保证：**每个保留 id 要么被有效键位覆盖，要么它的默认键
 * 全部被我们自己的表拒掉** —— 两者都不成立时插件就绑得上一个 TUI 会跳过的键，测试必须变红。
 */
test("SDK 保留键位的默认键在 Web 上全部不可用（默认值从 SDK 源码读，漂移即失败）", () => {
  const sources = [
    new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url),
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/keybindings.js",
      import.meta.url,
    ),
  ].map((url) => readFileSync(url, "utf8")).join("\n");

  const reservedIds = [
    "app.interrupt", "app.clear", "app.exit", "app.suspend", "app.thinking.cycle",
    "app.model.cycleForward", "app.model.cycleBackward", "app.model.select", "app.tools.expand",
    "app.thinking.toggle", "app.editor.external", "app.message.copy", "app.message.followUp",
    "tui.input.submit", "tui.select.confirm", "tui.select.cancel", "tui.input.copy",
    "tui.editor.deleteToLineEnd",
  ];

  const failures = [];
  let checked = 0;
  for (const id of reservedIds) {
    const at = sources.indexOf(`"${id}": {`);
    if (at === -1) {
      failures.push(`${id}: 在 SDK 源码里找不到定义（结构变了，这条测试需要重新取默认值）`);
      continue;
    }
    const declaration = /defaultKeys:\s*([^\n]*)/.exec(sources.slice(at, at + 320));
    if (!declaration) {
      failures.push(`${id}: 没解析出 defaultKeys`);
      continue;
    }
    // 表达式里的字符串字面量就是候选键位（三元/数组/平台分支都覆盖到）；
    // 形状过滤掉 description 那种句子。
    const keys = [...declaration[1].matchAll(/"([a-z0-9+]+)"/g)].map((match) => match[1]);
    if (keys.length === 0) continue; // 例如 app.suspend 的 Windows 分支是 []，没有键
    for (const key of keys) {
      checked += 1;
      if (shortcutAvailability(key).available) failures.push(`${id} 的默认键 ${key} 在 Web 上被判可用`);
    }
  }

  assert.ok(checked >= reservedIds.length - 1, `解析到的键位太少（${checked}），解析逻辑可能已经失效`);
  assert.deepEqual(failures, [], failures.join("；"));
});

test("有效键位：默认值 + 用户覆盖，未知 id 也保留（SDK 的冲突判定只认这份）", () => {
  const config = buildEffectiveKeybindings({
    defaults: { "tui.input.submit": "enter", "tui.select.confirm": "enter" },
    userBindings: {
      "tui.input.submit": "ctrl+alt+enter",
      // app.* 不在默认表里（SDK 那份没从包入口导出），用户写了就必须保留：
      // 不保留的话「用户把保留动作改到某个键」这件事对 SDK 就不存在，插件会把那个键绑走。
      "app.interrupt": "f7",
      "future.unknown": ["ctrl+alt+1", "ctrl+alt+2"],
      "tui.select.confirm": undefined,
    },
  });
  assert.equal(config["tui.input.submit"], "ctrl+alt+enter", "用户覆盖必须赢过默认值");
  assert.equal(config["app.interrupt"], "f7", "未知 id 不该被丢掉");
  assert.deepEqual(config["future.unknown"], ["ctrl+alt+1", "ctrl+alt+2"], "数组形状原样保留");
  assert.equal(config["tui.select.confirm"], "enter", "值为 undefined 的条目不该覆盖默认值（也不该整表失效）");
});

test("有效键位：旧名映射到保留 id；现代 id 也在时旧名让位（与 SDK 同规则）", () => {
  const migrated = buildEffectiveKeybindings({
    defaults: {},
    userBindings: { interrupt: "f7", cycleThinkingLevel: "f8" },
  });
  assert.equal(migrated["app.interrupt"], "f7", "旧名 interrupt 必须映射成 app.interrupt");
  assert.equal(migrated["app.thinking.cycle"], "f8");
  assert.equal(migrated["interrupt"], undefined, "不该留下旧名条目");

  const both = buildEffectiveKeybindings({
    defaults: {},
    userBindings: { interrupt: "f7", "app.interrupt": "f9" },
  });
  assert.equal(both["app.interrupt"], "f9", "现代 id 也在时必须让现代 id 生效");
});

test("有效键位：坏值单项跳过，不让一条坏值清空整张表", () => {
  const config = buildEffectiveKeybindings({
    defaults: { "tui.input.submit": "enter" },
    userBindings: {
      "app.interrupt": 42,
      "app.clear": [],
      "app.exit": "",
      "app.model.select": ["ctrl+l", 7, ""],
      "app.tools.expand": "ctrl+alt+o",
    },
  });
  assert.equal(config["app.interrupt"], undefined, "数字值跳过");
  assert.equal(config["app.clear"], undefined, "空数组跳过");
  assert.equal(config["app.exit"], undefined, "空串跳过");
  assert.deepEqual(config["app.model.select"], ["ctrl+l"], "数组里的坏项被剔掉，好项保留");
  assert.equal(config["app.tools.expand"], "ctrl+alt+o", "同一次调用里的好值不受影响");
  assert.equal(config["tui.input.submit"], "enter", "默认值仍在");
});

test("可用性：浏览器占用的功能键与数字/缩放组合不可绑，其余 F 键仍可绑", () => {
  for (const key of ["f5", "f11", "f12", "ctrl+1", "ctrl+9", "ctrl+0", "super+3", "ctrl+-", "ctrl+="]) {
    assert.deepEqual(shortcutAvailability(key), { available: false, reason: "browser-reserved" }, key);
  }
  for (const key of ["f1", "f4", "f6", "f10"]) {
    assert.equal(shortcutAvailability(key).available, true, key);
  }
});

test("可用性：壳的 Ctrl+Alt+N 不可绑（壳只在有活动项目时处理，条件没法静态表达）", () => {
  assert.deepEqual(shortcutAvailability("ctrl+alt+n"), { available: false, reason: "shell-reserved" });
  assert.deepEqual(shortcutAvailability("CTRL+ALT+N"), { available: false, reason: "shell-reserved" });
  // 不带 Alt 的 Ctrl+N 仍是浏览器保留（新窗口），两条都要挡住，但原因不同。
  assert.deepEqual(shortcutAvailability("ctrl+n"), { available: false, reason: "browser-reserved" });
});

test("命中判定：已被处理 / 长按重复 / 输入法合成的按键都不算按下快捷键", () => {
  const shortcuts = [
    { key: "ctrl+alt+7", available: true, extensionPath: "a" },
    { key: "ctrl+p", available: false, reason: "browser-reserved", extensionPath: "b" },
    { key: "f7", available: true, extensionPath: "c" },
  ];
  const base = { key: "7", ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
  assert.equal(pickBoundShortcut(shortcuts, { ...base, altKey: true })?.extensionPath, "a");
  assert.equal(pickBoundShortcut(shortcuts, { ...base, altKey: true, defaultPrevented: true }), null, "别人处理过就让位");
  assert.equal(pickBoundShortcut(shortcuts, { ...base, altKey: true, repeat: true }), null, "长按不算一次按下");
  assert.equal(pickBoundShortcut(shortcuts, { ...base, altKey: true, isComposing: true }), null, "合成期间不算");
  assert.equal(pickBoundShortcut(shortcuts, { ...base, altKey: true, key: "p" }), null, "不可用的键不参与命中");
  assert.equal(
    pickBoundShortcut(shortcuts, { key: "F7", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })?.extensionPath,
    "c",
    "不带修饰符的 F 键也走同一条匹配",
  );
  assert.equal(pickBoundShortcut(shortcuts, { ...base, key: "8", altKey: true }), null, "没绑的键返回 null");
});

test("防漂移：旧名表与 SDK 的 KEYBINDING_NAME_MIGRATIONS 一致（只覆盖保留 id 那部分）", () => {
  const source = readFileSync(
    new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("KEYBINDING_NAME_MIGRATIONS");
  const table = source.slice(start, source.indexOf("};", start));
  const pairs = [...table.matchAll(/([A-Za-z0-9_.]+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
  const reservedIds = new Set([
    "app.interrupt", "app.clear", "app.exit", "app.suspend", "app.thinking.cycle",
    "app.model.cycleForward", "app.model.cycleBackward", "app.model.select", "app.tools.expand",
    "app.thinking.toggle", "app.editor.external", "app.message.copy", "app.message.followUp",
    "tui.input.submit", "tui.select.confirm", "tui.select.cancel", "tui.input.copy",
    "tui.editor.deleteToLineEnd",
  ]);
  const expected = Object.fromEntries(pairs.filter(([, id]) => reservedIds.has(id)));
  assert.deepEqual(
    { ...RESERVED_LEGACY_KEYBINDING_NAMES },
    expected,
    "旧名表漂移了：SDK 的迁移表改了，这里的 17 条要跟着改（否则用户用旧名配的保留键会被插件抢走）",
  );
});

test("设置清单状态：拿不到 state 与「没有插件注册」必须分开（只读 / 没有 live host 时扩展压根没加载）", () => {
  assert.deepEqual(shortcutListState({ sessionId: null }), { kind: "no-session" });
  assert.deepEqual(shortcutListState({ sessionId: "s1", failed: true }), { kind: "failed" });
  // 状态里没有 state 字段 = 非 live host。以前这里会被当成空数组，界面于是显示「没有插件注册」——
  // 那是假的（issue #105 审查 P2）。
  assert.deepEqual(shortcutListState({ sessionId: "s1", payload: {} }), { kind: "no-state" });
  assert.deepEqual(shortcutListState({ sessionId: "s1", payload: { state: {} } }), {
    kind: "ready",
    entries: [],
    diagnostics: [],
  });
  // 显式空数组才是真的「没有插件注册」。
  assert.deepEqual(
    shortcutListState({ sessionId: "s1", payload: { state: { extensionShortcuts: [] } } }),
    { kind: "ready", entries: [], diagnostics: [] },
  );
  const ready = shortcutListState({
    sessionId: "s1",
    payload: {
      state: {
        extensionShortcuts: [{ key: "f7", available: false, reason: "sdk-conflict", extensionPath: "a" }],
        extensionShortcutDiagnostics: [{ message: "Extension shortcut 'f7' ... Skipping." }],
      },
    },
  });
  assert.equal(ready.kind, "ready");
  assert.equal(ready.entries.length, 1);
  assert.equal(ready.diagnostics.length, 1, "SDK 的诊断原文要能透出来给用户对照");
  // 形状不对的字段不该让整块界面崩：按空数组处理。
  const bogus = shortcutListState({
    sessionId: "s1",
    payload: { state: { extensionShortcuts: "nope", extensionShortcutDiagnostics: 42 } },
  });
  assert.deepEqual(bogus, { kind: "ready", entries: [], diagnostics: [] });
});
