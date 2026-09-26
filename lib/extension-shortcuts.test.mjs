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
  assert.deepEqual(shortcutAvailability("f5"), { available: true }, "F 键不与输入冲突");
  assert.deepEqual(shortcutAvailability("shift+f5"), { available: true });
  assert.deepEqual(
    shortcutAvailability("ctrl+alt+n"),
    { available: true },
    "带 Alt 的 Ctrl 组合不是浏览器快捷键（AltGr 例外也说明不能一刀切）",
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
 * 为什么这件事落在我们头上：Pidance 没有键位配置界面，给 `getShortcuts` 传的是**用户覆盖**（通常为空），
 * SDK 的 `buildBuiltinKeybindings` 只会按这份配置**自己列出**内置键位 —— 于是它那份保留表在这里是空转的。
 * 真正拦住这些键的是我们自己的三张表（浏览器 / 壳 / 打字冲突）。
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
