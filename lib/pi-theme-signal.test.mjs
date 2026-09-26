/**
 * 主题变更信号（issue #109）。
 *
 * 覆盖两件容易写错的事：
 * 1. **只认 dark/light**：服务端只把这两个档位映射给插件主题，`system` 与自定义主题名
 *    不动插件主题 —— 认了就会白拉一次请求；
 * 2. **只认远程广播**：本地乐观写入那一刻早于服务端切换插件主题，从那里触发刷新会拉回旧色。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  isShellThemeName,
  notifyPiThemeApplied,
  notifyPiThemeAppliedFromPrefsPayload,
  piThemeModeInPrefsPatch,
  resetPiThemeSignalForTests,
  subscribePiThemeApplied,
} = await jiti.import("./pi-theme-signal.ts");

test("广播载荷里取出「壳的明暗」：两种 patch 形状都认，皮肤与未知档位不算", () => {
  resetPiThemeSignalForTests();
  // 客户端整包 patch：theme 是对象
  assert.equal(piThemeModeInPrefsPatch({ theme: { mode: "dark", style: "chamber" } }), "dark");
  // 插件 setTheme 经 applyShellTheme 广播：点路径
  assert.equal(piThemeModeInPrefsPatch({ "theme.mode": "light" }), "light");
  assert.equal(piThemeModeInPrefsPatch({ theme: { mode: "dark", style: "fusion" } }), "dark", "皮肤一起改也要认 mode");
  // 只改了皮肤 → 与插件 ANSI 无关，不触发
  assert.equal(piThemeModeInPrefsPatch({ theme: { style: "fusion" } }), null);
  assert.equal(piThemeModeInPrefsPatch({ sidebarUi: { collapsed: true } }), null);
  // 服务端不会把 system / 自定义主题名映射给插件主题
  assert.equal(piThemeModeInPrefsPatch({ theme: { mode: "system" } }), null);
  assert.equal(piThemeModeInPrefsPatch({ "theme.mode": "solarized-dark" }), null);
  // 畸形载荷不抛错
  for (const bad of [null, undefined, "theme", 42, [], { theme: null }, { theme: "dark" }]) {
    assert.equal(piThemeModeInPrefsPatch(bad), null);
  }
});

test("同名重复不通知；换档位才通知", () => {
  resetPiThemeSignalForTests();
  const seen = [];
  subscribePiThemeApplied((mode) => seen.push(mode));

  assert.equal(notifyPiThemeApplied("dark"), true, "第一次 dark 要通知");
  assert.equal(notifyPiThemeApplied("dark"), false, "同档位重复（本地写入 + 广播回显）不通知");
  assert.equal(notifyPiThemeApplied("light"), true, "换档位要通知");
  assert.deepEqual(seen, ["dark", "light"]);

  resetPiThemeSignalForTests();
});

test("system / 非字符串档位一律不通知（服务端不会切插件主题）", () => {
  resetPiThemeSignalForTests();
  const seen = [];
  subscribePiThemeApplied((mode) => seen.push(mode));
  assert.equal(notifyPiThemeApplied("system"), false);
  assert.equal(notifyPiThemeApplied("solarized"), false);
  assert.equal(notifyPiThemeApplied(undefined), false);
  assert.equal(notifyPiThemeApplied(null), false);
  assert.deepEqual(seen, []);
  assert.equal(isShellThemeName("dark"), true);
  assert.equal(isShellThemeName("system"), false);
  resetPiThemeSignalForTests();
});

test("单个订阅者抛错不影响其它订阅者；退订后不再收到", () => {
  resetPiThemeSignalForTests();
  const seen = [];
  const unsubscribeBad = subscribePiThemeApplied(() => {
    throw new Error("boom");
  });
  const unsubscribeGood = subscribePiThemeApplied((mode) => seen.push(mode));

  assert.equal(notifyPiThemeApplied("dark"), true, "坏订阅者不该让通知失败");
  assert.deepEqual(seen, ["dark"]);

  unsubscribeBad();
  unsubscribeGood();
  resetPiThemeSignalForTests();
  assert.equal(notifyPiThemeApplied("light"), true);
  assert.deepEqual(seen, ["dark"], "退订后不再收到");
  resetPiThemeSignalForTests();
});

test("只有远程 prefs 广播才通知：type 非 prefs、载荷无主题变更都不算", () => {
  resetPiThemeSignalForTests();
  const seen = [];
  subscribePiThemeApplied((mode) => seen.push(mode));

  // 本地那次乐观写入不经过这里；这里进来的都是服务端广播
  assert.equal(
    notifyPiThemeAppliedFromPrefsPayload({ type: "prefs", changed: { theme: { mode: "light", style: "chamber" } } }),
    true,
  );
  assert.equal(notifyPiThemeAppliedFromPrefsPayload({ type: "prefs", changed: { "theme.mode": "dark" } }), true);
  // 同档位回显 / 无关变更 / 别的流事件
  assert.equal(notifyPiThemeAppliedFromPrefsPayload({ type: "prefs", changed: { "theme.mode": "dark" } }), false);
  assert.equal(notifyPiThemeAppliedFromPrefsPayload({ type: "prefs", changed: { drafts: { a: 1 } } }), false);
  assert.equal(notifyPiThemeAppliedFromPrefsPayload({ type: "running", ids: ["s1"] }), false);
  assert.equal(notifyPiThemeAppliedFromPrefsPayload(null), false);
  assert.equal(notifyPiThemeAppliedFromPrefsPayload("prefs"), false);

  assert.deepEqual(seen, ["light", "dark"]);
  resetPiThemeSignalForTests();
});
