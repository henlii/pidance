import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nextActiveFileTabId,
  planWorkspaceFileTabReset,
  shouldResetFileTabsOnCwdChange,
} from "./workspace-file-tabs.ts";

test("cwd 变化才清文件页签；同 cwd / 仅补 projectRoot 不算", () => {
  assert.equal(shouldResetFileTabsOnCwdChange("/a", "/b"), true);
  assert.equal(shouldResetFileTabsOnCwdChange("/a", "/a"), false);
  assert.equal(shouldResetFileTabsOnCwdChange(null, "/a"), true);
  assert.equal(shouldResetFileTabsOnCwdChange("/a", null), true);
  assert.equal(shouldResetFileTabsOnCwdChange(null, null), false);
});

test("全部干净：关掉所有页签并关二级面板", () => {
  const plan = planWorkspaceFileTabReset({
    tabs: [
      { id: "file:1", bufferKey: "k1" },
      { id: "file:2", bufferKey: "k2" },
    ],
    dirtyBufferKeys: new Set(),
  });
  assert.deepEqual(plan.closeIds, ["file:1", "file:2"]);
  assert.deepEqual(plan.removeBufferKeys, ["k1", "k2"]);
  assert.deepEqual(plan.keepTabs, []);
  assert.equal(plan.pendingCloseTabId, null);
  assert.equal(plan.closePanel, true);
  assert.equal(nextActiveFileTabId("file:1", plan.keepTabs), null);
});

test("有 dirty：只关干净页签，留下 dirty 并进入既有确认流", () => {
  const plan = planWorkspaceFileTabReset({
    tabs: [
      { id: "file:clean", bufferKey: "c" },
      { id: "file:dirty", bufferKey: "d" },
    ],
    dirtyBufferKeys: new Set(["d"]),
  });
  assert.deepEqual(plan.closeIds, ["file:clean"]);
  assert.deepEqual(plan.removeBufferKeys, ["c"]);
  assert.deepEqual(plan.keepTabs.map((tab) => tab.id), ["file:dirty"]);
  assert.equal(plan.pendingCloseTabId, "file:dirty");
  assert.equal(plan.closePanel, false);
  assert.equal(nextActiveFileTabId("file:clean", plan.keepTabs), "file:dirty");
  assert.equal(nextActiveFileTabId("file:dirty", plan.keepTabs), "file:dirty");
});

test("源码契约：AppShell 按 cwd 变化执行文件页签重置", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "components", "AppShell.tsx"), "utf8");
  assert.match(src, /shouldResetFileTabsOnCwdChange/);
  assert.match(src, /planWorkspaceFileTabReset/);
});
