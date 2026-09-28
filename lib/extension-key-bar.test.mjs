import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  EXTENSION_KEY_BAR_KEYS,
  EXTENSION_KEY_BAR_LABEL_KEYS,
  keyBarKeyData,
  resolveExtensionKeyBarChannel,
  shouldShowExtensionKeyBar,
} = await jiti.import("./extension-key-bar.ts");

test("按键条上的键与物理键盘走同一套序列（不是自己编的映射）", () => {
  assert.deepEqual([...EXTENSION_KEY_BAR_KEYS], ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape"]);
  assert.equal(keyBarKeyData("ArrowUp"), "\x1b[A");
  assert.equal(keyBarKeyData("ArrowDown"), "\x1b[B");
  assert.equal(keyBarKeyData("ArrowLeft"), "\x1b[D");
  assert.equal(keyBarKeyData("ArrowRight"), "\x1b[C");
  assert.equal(keyBarKeyData("Enter"), "\r");
  assert.equal(keyBarKeyData("Escape"), "\x1b");
});

test("每个键都有文案 key（少一个就会出现无标签按钮）", () => {
  for (const key of EXTENSION_KEY_BAR_KEYS) {
    assert.equal(typeof EXTENSION_KEY_BAR_LABEL_KEYS[key], "string", `${key} 缺文案 key`);
  }
});

test("通道分派：编辑器接管优先于面板（接管时输入框根本不渲染）", () => {
  const both = { hasEditorTakeover: true, hasVisibleCustomPanel: true, canRouteTerminal: true };
  assert.equal(resolveExtensionKeyBarChannel(both), "editor");
  assert.equal(
    resolveExtensionKeyBarChannel({ hasEditorTakeover: false, hasVisibleCustomPanel: true, canRouteTerminal: true }),
    "panel",
  );
  assert.equal(
    resolveExtensionKeyBarChannel({ hasEditorTakeover: false, hasVisibleCustomPanel: false, canRouteTerminal: true }),
    "terminal",
  );
  assert.equal(
    resolveExtensionKeyBarChannel({ hasEditorTakeover: false, hasVisibleCustomPanel: false, canRouteTerminal: false }),
    "none",
  );
});

test("显示条件：窄视口 + 确有插件界面占着键盘（两条都满足才显示）", () => {
  assert.equal(shouldShowExtensionKeyBar({ isMobile: true, channel: "panel" }), true);
  assert.equal(shouldShowExtensionKeyBar({ isMobile: true, channel: "editor" }), true);
  assert.equal(shouldShowExtensionKeyBar({ isMobile: true, channel: "terminal" }), true);
  // 桌面不显示：物理键盘本来就能按
  assert.equal(shouldShowExtensionKeyBar({ isMobile: false, channel: "panel" }), false);
  // 没有插件界面时不显示：否则挡住输入框且按了没人收
  assert.equal(shouldShowExtensionKeyBar({ isMobile: true, channel: "none" }), false);
});

test("接线：ChatWindow 按通道分派到既有发送函数，且只在窄视口渲染", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const shell = readFileSync(fileURLToPath(new URL("../components/ChatWindow.tsx", import.meta.url)), "utf8");
  assert.ok(shell.includes("resolveExtensionKeyBarChannel({"), "应按通道判定");
  assert.ok(shell.includes("shouldShowExtensionKeyBar({ isMobile, channel: keyBarChannel })"));
  // 三条通道各自用到既有发送入口，没有为按键条新开一套
  const bar = readFileSync(fileURLToPath(new URL("../components/ExtensionKeyBar.tsx", import.meta.url)), "utf8");
  assert.ok(bar.includes("data-extension-key-bar"), "按键条应能被探针识别");
  assert.ok(bar.includes("aria-label={label}"), "每个键都要有可读标签（无障碍）");
  assert.ok(shell.includes("sendExtensionEditorInput(extensionEditorTakeover, data)"));
  assert.ok(shell.includes("sendExtensionCustomInput(extensionCustomUi, data)"));
  assert.ok(shell.includes('{ type: "terminal_input", data }'));
  assert.ok(shell.includes("{showKeyBar ? <ExtensionKeyBar onKey={handleKeyBarKey} /> : null}"));
});
