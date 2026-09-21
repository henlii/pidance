import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTENSION_TITLE_TTL_MS,
  createWindowTitleState,
  getWindowTitleState,
  isWindowTitleOverrideActive,
  resetWindowTitleForTests,
  resolveWindowTitle,
  setExtensionWindowTitle,
  setWindowTitleBase,
  subscribeWindowTitle,
  windowTitleOverrideRemainingMs,
  withExtensionWindowTitle,
  withWindowTitleBase,
} from "./window-title.ts";

test("#50 纯规则：覆盖期内用扩展标题，到期回落项目标题", () => {
  const base = createWindowTitleState("repo - Pidance");
  const overridden = withExtensionWindowTitle(base, "  生成中…  ", 1_000_000);
  assert.equal(overridden.override, "生成中…", "两侧空白裁掉");
  assert.equal(resolveWindowTitle(overridden, 1_000_000), "生成中…");
  assert.equal(resolveWindowTitle(overridden, 1_000_000 + EXTENSION_TITLE_TTL_MS - 1), "生成中…");
  // 到期（含边界）→ 回落 base
  assert.equal(resolveWindowTitle(overridden, 1_000_000 + EXTENSION_TITLE_TTL_MS), "repo - Pidance");
  assert.equal(isWindowTitleOverrideActive(overridden, 1_000_000 + EXTENSION_TITLE_TTL_MS), false);
  assert.equal(windowTitleOverrideRemainingMs(overridden, 1_000_500), EXTENSION_TITLE_TTL_MS - 500);
  assert.equal(windowTitleOverrideRemainingMs(overridden, 1_000_000 + EXTENSION_TITLE_TTL_MS), 0);
});

test("#50 纯规则：项目/会话切换（base 变化）立即作废覆盖；base 未变保持原引用", () => {
  const base = createWindowTitleState("repo - Pidance");
  const overridden = withExtensionWindowTitle(base, "生成中…", 1_000_000);
  assert.equal(withWindowTitleBase(overridden, "repo - Pidance"), overridden, "base 未变 → 原引用");
  const switched = withWindowTitleBase(overridden, "other - Pidance");
  assert.equal(switched.override, null);
  assert.equal(resolveWindowTitle(switched, 1_000_100), "other - Pidance", "切换后不得残留扩展标题");
});

test("#50 纯规则：空白标题忽略（不覆盖、不抛）", () => {
  const base = createWindowTitleState("repo - Pidance");
  for (const title of ["", "   ", "\n\t"]) {
    assert.equal(withExtensionWindowTitle(base, title, 1_000_000), base);
  }
  assert.equal(resolveWindowTitle(base, 1_000_000), "repo - Pidance");
});

test("#50 模块状态：base 与扩展标题都通过订阅通知，解析值符合规则", () => {
  resetWindowTitleForTests();
  let notified = 0;
  const unsubscribe = subscribeWindowTitle(() => { notified += 1; });
  assert.equal(resolveWindowTitle(getWindowTitleState()), "Pidance", "初始 base");

  setWindowTitleBase("repo - Pidance");
  assert.equal(notified, 1);
  assert.equal(resolveWindowTitle(getWindowTitleState()), "repo - Pidance");

  setExtensionWindowTitle("子代理跑完了");
  assert.equal(notified, 2);
  assert.equal(resolveWindowTitle(getWindowTitleState()), "子代理跑完了");

  // 同值重复写入不通知（避免无谓重渲染）
  setWindowTitleBase("repo - Pidance");
  assert.equal(notified, 2);

  // 空标题不通知、不改状态
  setExtensionWindowTitle("   ");
  assert.equal(notified, 2);
  assert.equal(resolveWindowTitle(getWindowTitleState()), "子代理跑完了");

  unsubscribe();
  setWindowTitleBase("repo2 - Pidance");
  assert.equal(notified, 2, "退订后不再通知");
  resetWindowTitleForTests();
});
