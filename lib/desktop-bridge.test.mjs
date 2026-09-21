import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const m = await jiti.import("./desktop-bridge.ts");

test("#51 readDesktopBridge：Web（没有 window.pidanceDesktop）返回 null", () => {
  assert.equal(m.readDesktopBridge(globalThis), null);
  assert.equal(m.readDesktopBridge({}), null);
  assert.equal(m.readDesktopBridge({ pidanceDesktop: null }), null);
  assert.equal(m.readDesktopBridge("not-an-object"), null);
});

test("#51 readDesktopBridge：形状不全（缺任意方法）一律当作没有桌面能力", () => {
  const full = {
    isDesktop: true,
    getSettings: () => Promise.resolve({}),
    setSetting: () => Promise.resolve({}),
    notify: () => undefined,
    onOpenSettings: () => () => undefined,
  };
  assert.ok(m.readDesktopBridge({ pidanceDesktop: full }), "完整的桥应该被接受");
  for (const missing of ["getSettings", "setSetting", "notify", "onOpenSettings"]) {
    const partial = { ...full, [missing]: undefined };
    assert.equal(
      m.readDesktopBridge({ pidanceDesktop: partial }),
      null,
      `缺 ${missing} 时不该被当成桌面桥`,
    );
  }
});

test("#51 normalizeDesktopSettings：只认白名单里的 true，其它一律 false", () => {
  assert.deepEqual(m.normalizeDesktopSettings({ openAtLogin: true, minimizeToTray: true, notificationsEnabled: true }), {
    openAtLogin: true,
    minimizeToTray: true,
    notificationsEnabled: true,
  });
  assert.deepEqual(m.normalizeDesktopSettings({ minimizeToTray: 1, notificationsEnabled: "yes", something: true }), {
    openAtLogin: false,
    minimizeToTray: false,
    notificationsEnabled: false,
  });
  assert.deepEqual(m.normalizeDesktopSettings(null), {
    openAtLogin: false,
    minimizeToTray: false,
    notificationsEnabled: false,
  });
});

test("#51 shouldNotifyRunCompletion：只在「页面不可见 + 不是正在看的会话 + 开关打开」时通知", () => {
  const base = { hidden: true, sessionId: "s1", visibleSessionId: "s2", notificationsEnabled: true };
  assert.equal(m.shouldNotifyRunCompletion(base), true, "窗口不可见且不是当前会话 → 通知");
  assert.equal(m.shouldNotifyRunCompletion({ ...base, hidden: false }), false, "正在看页面时不打扰");
  assert.equal(m.shouldNotifyRunCompletion({ ...base, sessionId: "s2" }), false, "正在看那个会话就不必通知");
  assert.equal(m.shouldNotifyRunCompletion({ ...base, notificationsEnabled: false }), false, "开关关掉就不发");
  assert.equal(m.shouldNotifyRunCompletion({ ...base, sessionId: null }), false, "没有会话不发");
});
