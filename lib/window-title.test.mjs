import assert from "node:assert/strict";
import test from "node:test";

import {
  createWindowTitleState,
  getWindowTitleState,
  isWindowTitleOverrideActive,
  resetWindowTitleForTests,
  resolveWindowTitle,
  setExtensionWindowTitle,
  setWindowTitleBase,
  setWindowTitleSession,
  subscribeWindowTitle,
  withExtensionWindowTitle,
  withWindowTitleBase,
  withWindowTitleSession,
} from "./window-title.ts";

test("#50/#76 纯规则：扩展标题顶在 base 之上，不再有到期（Pi 的 TUI 也没有）", () => {
  const base = createWindowTitleState("repo - Pidance");
  const overridden = withExtensionWindowTitle(base, "  生成中…  ");
  assert.equal(overridden.override, "生成中…", "两侧空白裁掉");
  assert.equal(resolveWindowTitle(overridden), "生成中…");
  assert.equal(isWindowTitleOverrideActive(overridden), true);
});

test("#76 纯规则：同一会话重复上报保持原引用；切会话立即作废覆盖", () => {
  const base = withWindowTitleSession(createWindowTitleState("repo - Pidance"), "s1");
  const overridden = withExtensionWindowTitle(base, "生成中…");
  assert.equal(withWindowTitleSession(overridden, "s1"), overridden, "同一会话 → 原引用，覆盖不受影响");
  const switched = withWindowTitleSession(overridden, "s2");
  assert.equal(switched.override, null);
  assert.equal(resolveWindowTitle(switched), "repo - Pidance", "切会话后不得残留扩展标题");
  // null（无会话）与 null → null 也不能把覆盖顶掉
  const none = withWindowTitleSession(overridden, null);
  assert.equal(none.override, null, "从会话回到「无会话」也算切换");
});

test("#50 纯规则：项目切换（base 变化）立即作废覆盖；base 未变保持原引用", () => {
  const base = createWindowTitleState("repo - Pidance");
  const overridden = withExtensionWindowTitle(base, "生成中…");
  assert.equal(withWindowTitleBase(overridden, "repo - Pidance"), overridden, "base 未变 → 原引用");
  const switched = withWindowTitleBase(overridden, "other - Pidance");
  assert.equal(switched.override, null);
  assert.equal(resolveWindowTitle(switched), "other - Pidance", "切换后不得残留扩展标题");
});

test("#50 纯规则：空白标题忽略（不覆盖、不抛）", () => {
  const base = createWindowTitleState("repo - Pidance");
  for (const title of ["", "   ", "\n\t"]) {
    assert.equal(withExtensionWindowTitle(base, title), base);
  }
  assert.equal(resolveWindowTitle(base), "repo - Pidance");
});

test("#50 模块状态：base / 会话 / 扩展标题都通过订阅通知，解析值符合规则", () => {
  resetWindowTitleForTests();
  let notified = 0;
  const unsubscribe = subscribeWindowTitle(() => { notified += 1; });
  assert.equal(resolveWindowTitle(getWindowTitleState()), "Pidance", "初始 base");

  setWindowTitleBase("repo - Pidance");
  assert.equal(notified, 1);
  assert.equal(resolveWindowTitle(getWindowTitleState()), "repo - Pidance");

  setWindowTitleSession("s1");
  assert.equal(notified, 2);
  assert.equal(resolveWindowTitle(getWindowTitleState()), "repo - Pidance");

  setExtensionWindowTitle("子代理跑完了");
  assert.equal(notified, 3);
  assert.equal(resolveWindowTitle(getWindowTitleState()), "子代理跑完了");

  // 同值重复写入不通知（避免无谓重渲染）
  setWindowTitleBase("repo - Pidance");
  setWindowTitleSession("s1");
  assert.equal(notified, 3);

  // 空标题不通知、不改状态
  setExtensionWindowTitle("   ");
  assert.equal(notified, 3);
  assert.equal(resolveWindowTitle(getWindowTitleState()), "子代理跑完了");

  // 切会话 → 覆盖作废并通知
  setWindowTitleSession("s2");
  assert.equal(notified, 4);
  assert.equal(resolveWindowTitle(getWindowTitleState()), "repo - Pidance");

  unsubscribe();
  setWindowTitleBase("repo2 - Pidance");
  assert.equal(notified, 4, "退订后不再通知");
  resetWindowTitleForTests();
});
