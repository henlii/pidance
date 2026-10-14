import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

/**
 * 「会话在等用户操作」这条侧栏黄点信号的判定。
 *
 * 2026-10-14 用户复现：扩展面板（ctx.ui.custom，插件自绘）把会话卡住时，侧栏只显示「运行中」，
 * 黄点没了 —— 因为那条路径只统计 pending 对话框，而面板根本没有请求对象可报。
 */
test("等用户操作：对话框 pending 与插件自绘面板都算", async () => {
  const { isSessionWaitingForUser } = await jiti.import("./live-session-registry.ts");
  assert.equal(isSessionWaitingForUser({ requests: [{ id: "r1" }], openCustomPanel: false }), true, "有对话框");
  assert.equal(isSessionWaitingForUser({ requests: [], openCustomPanel: true }), true, "只有插件面板");
  assert.equal(isSessionWaitingForUser({ requests: [], openCustomPanel: false }), false, "两样都没有");
});

test("等用户操作：聚合时不能只看 pending 对话框", () => {
  const source = readFileSync(new URL("./live-session-registry.ts", import.meta.url), "utf8");
  // 只报 requests 会让面板阻塞的会话漏掉；面板开着要单独认。
  assert.match(source, /const openCustomPanel = requests\.length === 0 && host\.hasOpenExtensionPanel\(\);/);
  assert.match(source, /if \(!isSessionWaitingForUser\(\{ requests, openCustomPanel \}\)\) continue;/);
  assert.match(source, /\.\.\.\(openCustomPanel \? \{ customPanel: true \} : \{\}\),/);
  const host = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");
  assert.match(host, /hasOpenExtensionPanel\(\): boolean \{[\s\S]{0,200}return Boolean\(this\.extensionUi\?\.customSnapshot\);/);
});
