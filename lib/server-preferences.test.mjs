import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * 墓碑删除语义（客户端侧）：删除 = 内存置 null + PUT 显式 null，
 * 服务端 merge 遇 null 删键 —— 解决「发送后草稿残留服务端，sync 复活」。
 */
const jiti = createJiti(import.meta.url);
const m = await jiti.import("./server-preferences.ts");

const savedFetch = globalThis.fetch;
function installMockFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ method, url: String(url), body: options.body ? JSON.parse(String(options.body)) : undefined });
    if (responder) return responder(url, options);
    if (method === "GET") {
      return new Response(JSON.stringify({ prefs: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return calls;
}

test("server-preferences：删除以 null 墓碑 PUT，读侧归一 undefined", async () => {
  const calls = installMockFetch();
  try {
    await m.ensureServerPrefsLoaded();
    // 模拟一次草稿写入（同 clearDraft 路径）
    m.setServerPref("drafts.s1", { value: "残留文本", images: [], updatedAt: Date.now() });
    assert.equal(m.getServerPref("drafts.s1").value, "残留文本");

    // clearDraft 等价删除
    m.setServerPref("drafts.s1", undefined);
    // 读侧统一 undefined（调用方无需区分 null/缺失）
    assert.equal(m.getServerPref("drafts.s1"), undefined);

    m.flushServerPrefs();
    const put = calls.find((c) => c.method === "PUT");
    assert.ok(put, "删除后应立即 PUT");
    assert.equal(put.body.prefs.drafts.s1, null, "PUT 必须携带显式 null 墓碑");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("server-preferences：墓碑可被新值覆盖", async () => {
  const calls = installMockFetch();
  try {
    await m.ensureServerPrefsLoaded();
    m.setServerPref("drafts.s2", { value: "新草稿", images: [] });
    m.setServerPref("drafts.s2", undefined);
    m.setServerPref("drafts.s2", { value: "又输入了", images: [] });
    assert.equal(m.getServerPref("drafts.s2").value, "又输入了");
    m.flushServerPrefs();
    const put = calls.find((c) => c.method === "PUT");
    assert.deepEqual(put.body.prefs.drafts.s2, { value: "又输入了", images: [] });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

/** 假的监听目标：记录注册/移除，并能触发事件（用于激活同步控制器断言）。 */
function fakeTarget() {
  const listeners = new Map();
  const adds = [];
  const removes = [];
  return {
    addEventListener(type, fn) {
      adds.push([type, fn]);
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      removes.push([type, fn]);
      listeners.get(type)?.delete(fn);
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    adds,
    removes,
    size() {
      return [...listeners.values()].reduce((n, set) => n + set.size, 0);
    },
  };
}

test("#49 激活同步控制器：多订阅只挂一对监听，全部退订才移除，且注册/移除同一引用", async () => {
  const { createActivationSyncController } = await jiti.import("./server-preferences.ts");
  const win = fakeTarget();
  const doc = fakeTarget();
  let visible = true;
  let synced = 0;
  let flushed = 0;
  const controller = createActivationSyncController({
    windowTarget: win,
    documentTarget: doc,
    isVisible: () => visible,
    syncNow: () => { synced += 1; },
    flushNow: () => { flushed += 1; },
  });

  // 模拟 7 个组件实例各自 retain（原先每实例各注册一套）
  const releases = Array.from({ length: 7 }, () => controller.retain());
  assert.equal(controller.refCount(), 7);
  assert.equal(controller.isAttached(), true);
  assert.deepEqual(win.adds.map(([type]) => type).sort(), ["beforeunload", "focus"]);
  assert.deepEqual(doc.adds.map(([type]) => type), ["visibilitychange"]);
  assert.equal(win.size() + doc.size(), 3, "七个实例只挂一对 focus/visibilitychange + 一个 beforeunload");

  // 退订一部分：监听仍在
  releases[0]();
  releases[1]();
  assert.equal(controller.isAttached(), true);
  releases[0](); // 幂等：重复退订不改变计数
  assert.equal(controller.refCount(), 5);

  // 可见性：隐藏时不触发同步
  visible = false;
  win.fire("focus");
  doc.fire("visibilitychange");
  assert.equal(synced, 0, "页面不可见时激活不触发同步");

  // 可见时每次激活各触发一次，beforeunload 触发 flush
  visible = true;
  win.fire("focus");
  doc.fire("visibilitychange");
  win.fire("beforeunload");
  assert.equal(synced, 2);
  assert.equal(flushed, 1);

  // 全部退订后监听移除，且移除的是同一组引用（成对）
  for (const release of releases.slice(2)) release();
  assert.equal(controller.refCount(), 0);
  assert.equal(controller.isAttached(), false);
  assert.equal(win.size() + doc.size(), 0, "全部退订后监听器应被移除");
  assert.deepEqual(win.removes.map(([type]) => type).sort(), ["beforeunload", "focus"]);
  assert.deepEqual(doc.removes.map(([type]) => type), ["visibilitychange"]);
  const before = synced;
  win.fire("focus");
  assert.equal(synced, before, "移除后事件不再触发同步");

  // 再次 retain 重新挂载
  const again = controller.retain();
  assert.equal(controller.isAttached(), true);
  again();
  assert.equal(controller.isAttached(), false);
});

test("#49 激活同步：并发调用合并为一次 GET，并把远端合并进内存（墓碑优先）", async () => {
  const calls = installMockFetch((url, options = {}) => {
    if ((options.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ prefs: { theme: "dark", watch: "remote", drafts: { s9: { value: "远端旧值" } } } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  try {
    await m.ensureServerPrefsLoaded();
    // 本地墓碑 + 本地未读
    m.setServerPref("drafts.s9", undefined);
    const [a, b, c] = await Promise.all([
      m.syncServerPrefsFromServer(),
      m.syncServerPrefsFromServer(),
      m.syncServerPrefsFromServer(),
    ]);
    assert.equal(a, undefined);
    assert.equal(b, undefined);
    assert.equal(c, undefined);
    const gets = calls.filter((call) => call.method === "GET");
    assert.equal(gets.length, 1, "并发激活只发一次 GET");
    // 远端普通键生效
    assert.equal(m.getServerPref("watch"), "remote");
    assert.equal(m.getServerPref("theme"), "dark");
    // 本地墓碑优先：不被远端旧值覆盖
    assert.equal(m.getServerPref("drafts.s9"), undefined);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test("#49 mergeSyncedServerPrefs：远端为准、本地墓碑优先、未读并集合并", async () => {
  const { mergeSyncedServerPrefs } = await jiti.import("./server-preferences.ts");
  const local = {
    theme: "local-value-should-lose",
    drafts: { keep: { value: "本地未删" }, gone: null },
  };
  const remote = {
    theme: "remote-value",
    watch: "remote-only",
    drafts: { gone: { value: "远端旧值" }, keep: { value: "远端旧值" }, other: { value: "远端新增" } },
  };
  const merged = mergeSyncedServerPrefs(local, remote);
  // 纯函数：不得改到传入的远端快照
  assert.deepEqual(remote.drafts, { gone: { value: "远端旧值" }, keep: { value: "远端旧值" }, other: { value: "远端新增" } });
  assert.equal(local.drafts.keep.value, "本地未删");
  assert.equal(merged.theme, "remote-value", "普通键以远端为准");
  assert.equal(merged.watch, "remote-only");
  assert.equal(merged.drafts.gone, null, "本地墓碑优先于远端旧值");
  assert.deepEqual(merged.drafts.other, { value: "远端新增" });
  // 无本地时直接返回远端副本
  const onlyRemote = mergeSyncedServerPrefs(null, remote);
  assert.equal(onlyRemote.theme, "remote-value");
  assert.equal(onlyRemote.drafts.gone.value, "远端旧值");
});

// ── #28 B4：服务端草稿 GC（跨端不再把历史草稿全量带给新浏览器） ───────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function draftEntry(value, updatedAt) {
  return updatedAt === undefined ? { value } : { value, updatedAt };
}

test("B4 pruneServerPrefs：30 天未更新的草稿被清掉，新草稿保留", async () => {
  const { pruneServerPrefs } = await jiti.import("./server-preferences.ts");
  const now = Date.now();
  const pruned = pruneServerPrefs({
    drafts: {
      fresh: draftEntry("新的", now - 2 * DAY_MS),
      edge: draftEntry("刚好 29 天", now - 29 * DAY_MS),
      stale: draftEntry("31 天前", now - 31 * DAY_MS),
    },
  });
  assert.deepEqual(Object.keys(pruned.drafts).sort(), ["edge", "fresh"]);
  assert.equal(pruned.drafts.fresh.value, "新的");
});

test("B4 pruneServerPrefs：只保留最新 30 条（按 updatedAt 降序）", async () => {
  const { pruneServerPrefs } = await jiti.import("./server-preferences.ts");
  const now = Date.now();
  const drafts = {};
  for (let i = 0; i < 45; i += 1) drafts[`d${i}`] = draftEntry(`v${i}`, now - i * 60_000);
  const pruned = pruneServerPrefs({ drafts });
  const kept = Object.keys(pruned.drafts);
  assert.equal(kept.length, 30, "未按上限裁剪");
  assert.deepEqual(kept.slice(0, 3), ["d0", "d1", "d2"], "保留的不是最新的 30 条（顺序应为 updatedAt 降序）");
  assert.equal(kept.includes("d44"), false, "最旧的草稿应当被裁掉");
});

test("B4 pruneServerPrefs：旧格式（无 updatedAt）保留待下轮更新，非法条目丢弃", async () => {
  const { pruneServerPrefs } = await jiti.import("./server-preferences.ts");
  const pruned = pruneServerPrefs({
    drafts: {
      legacy: draftEntry("旧格式"),
      broken: "不是对象",
      array: [],
      nothing: null,
    },
  });
  assert.deepEqual(Object.keys(pruned.drafts), ["legacy"]);
});

test("B4 pruneServerPrefs：没有可裁剪内容时返回同一引用（调用方据此跳过重渲染）", async () => {
  const { pruneServerPrefs } = await jiti.import("./server-preferences.ts");
  const prefs = { drafts: { a: draftEntry("x", Date.now()) } };
  assert.equal(pruneServerPrefs(prefs), prefs);
  const noDrafts = { theme: "dark" };
  assert.equal(pruneServerPrefs(noDrafts), noDrafts);
  const badDrafts = { drafts: [] };
  assert.equal(pruneServerPrefs(badDrafts), badDrafts);
});
