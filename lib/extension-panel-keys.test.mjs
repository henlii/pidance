import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { shouldCaptureCustomPanelKey } = await jiti.import("./extension-panel-keys.ts");

test("有选区时 Ctrl/Cmd+C 不转成 TUI 中断", () => {
  assert.equal(shouldCaptureCustomPanelKey({ key: "c", ctrlKey: true, metaKey: false }, "copied"), false);
  assert.equal(shouldCaptureCustomPanelKey({ key: "c", ctrlKey: false, metaKey: true }, "copied"), false);
  assert.equal(shouldCaptureCustomPanelKey({ key: "c", ctrlKey: true, metaKey: false }, ""), true);
});

test("Ctrl/Cmd+A 始终留给浏览器全选", () => {
  assert.equal(shouldCaptureCustomPanelKey({ key: "a", ctrlKey: true, metaKey: false }, ""), false);
  assert.equal(shouldCaptureCustomPanelKey({ key: "ArrowDown", ctrlKey: false, metaKey: false }, "sel"), true);
});
