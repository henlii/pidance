/**
 * 「壳明暗偏好 → 插件主题」同步的验收（issue #97 审查）。
 *
 * 背景：dark/light 在 TUI 里只有一个主题；Web 这边壳的明暗在偏好里、插件 ANSI 在进程级主题里。
 * 断言三件事：
 * - 启动时（第一次渲染之前）按偏好 `theme.mode` 对齐插件主题（否则重启后壳 light、插件 dark）；
 * - 用户改壳明暗后同步插件主题，且**同名不重切**（否则每次 PUT 都重建实例并全量重渲）；
 * - 同步**只读偏好**：不写回文件（写回去会形成「写入 → 广播 → 再写入」的回声）。
 *
 * 隔离：`PI_CODING_AGENT_DIR` 指向临时目录，全程不碰真实 `~/.pi/agent`。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "pidance-theme-sync-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const bridge = await jiti.import("./tui-render-bridge.ts");
const registry = await jiti.import("./pi-theme-registry.ts");
const sync = await jiti.import("./theme-preference-sync.ts");
const { Theme: SdkTheme } = await import("@earendil-works/pi-coding-agent");

const prefsPath = join(agentDir, "pidance-preferences.json");

test.after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

/** 写偏好文件（theme 为 null 表示不写这个键）。 */
function writePrefs(theme) {
  writeFileSync(prefsPath, JSON.stringify(theme ? { theme } : {}), "utf8");
}

function freshState() {
  bridge.setPiThemeConstructor(SdkTheme);
  bridge.resetPiThemeForTests();
  sync.resetPiThemeAlignmentForTests();
  return bridge.loadPiTheme();
}

test("启动对齐：偏好是 light 时插件主题也要是 light（重启后两边不再拆开）", () => {
  freshState();
  assert.equal(bridge.loadPiTheme().name, "dark", "默认仍是内置 dark");
  writePrefs({ mode: "light", style: "chamber" });
  sync.alignPiThemeWithShellPreferenceOnStartup(agentDir);
  assert.equal(bridge.loadPiTheme().name, "light", "启动对齐必须把插件主题设成偏好的明暗");
});

test("启动对齐只做一次：重复调用不再切主题（也不再多一轮重渲）", () => {
  freshState();
  writePrefs({ mode: "light" });
  sync.alignPiThemeWithShellPreferenceOnStartup(agentDir);
  const afterFirst = bridge.loadPiTheme();
  let notifications = 0;
  const unsubscribe = bridge.onPiThemeChange(() => {
    notifications += 1;
  });
  try {
    sync.alignPiThemeWithShellPreferenceOnStartup(agentDir);
    assert.equal(bridge.loadPiTheme(), afterFirst, "第二次调用不得重建主题实例");
    assert.equal(notifications, 0, "没有真正切换就不该通知（否则每次构造宿主都全量重渲）");
  } finally {
    unsubscribe();
  }
});

for (const [label, theme] of [
  ["system（明暗由客户端 prefers-color-scheme 决定，服务端不知道结果）", { mode: "system" }],
  ["偏好里没有 theme 键", null],
  ["mode 是非法值", { mode: "sepia" }],
]) {
  test(`启动对齐不动插件主题：${label}`, () => {
    freshState();
    writePrefs(theme);
    sync.alignPiThemeWithShellPreferenceOnStartup(agentDir);
    assert.equal(bridge.loadPiTheme().name, "dark", "不确定的情况保持默认，不猜");
  });
}

test("用户改壳明暗 → 同步插件主题；已经同名则不动", () => {
  freshState();
  assert.equal(sync.syncPiThemeWithShellPreference({ theme: { mode: "light" } }, agentDir), true);
  assert.equal(bridge.loadPiTheme().name, "light");
  let notifications = 0;
  const unsubscribe = bridge.onPiThemeChange(() => {
    notifications += 1;
  });
  try {
    assert.equal(sync.syncPiThemeWithShellPreference({ theme: { mode: "light" } }, agentDir), false);
    assert.equal(notifications, 0, "同名不重切：每次 PUT 都重建实例会白跑一轮全量重渲");
    assert.equal(sync.syncPiThemeWithShellPreference({ theme: { mode: "dark" } }, agentDir), true);
    assert.equal(bridge.loadPiTheme().name, "dark");
    assert.equal(notifications, 1);
  } finally {
    unsubscribe();
  }
});

test("同步只读偏好：不写回文件（避免「写入 → 广播 → 再写入」的回声）", () => {
  freshState();
  writePrefs({ mode: "light", style: "fusion", locale: "zh-CN" });
  const before = readFileSync(prefsPath, "utf8");
  sync.syncPiThemeWithShellPreference(undefined, agentDir);
  sync.resetPiThemeAlignmentForTests();
  sync.alignPiThemeWithShellPreferenceOnStartup(agentDir);
  assert.equal(readFileSync(prefsPath, "utf8"), before, "同步不得改动偏好文件");
  assert.equal(bridge.loadPiTheme().name, "light", "但插件主题要真的切过去");
});

test("鸭子类型收紧：只有 fg 的对象不当作主题（不会装进全局槽位）", () => {
  freshState();
  const before = bridge.loadPiTheme();
  assert.equal(registry.setPiTheme({ fg: () => "" }, agentDir).success, false);
  assert.equal(registry.setPiTheme({ bg: () => "" }, agentDir).success, false);
  assert.equal(bridge.loadPiTheme(), before, "参数不合规时当前主题不变");
  const light = registry.loadPiThemeByName("light", agentDir);
  assert.equal(registry.setPiTheme(light, agentDir).success, true);
  assert.equal(bridge.loadPiTheme(), light);
});
