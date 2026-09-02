import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createNoticeQueueStore,
  NOTICE_TRANSIENT_VISIBLE,
  NOTICE_IMPORTANT_VISIBLE,
} = await jiti.import("./notice-queue-store.ts");

test("每会话独立队列：A 的提示不在 B 展示，切回 A 仍可见", () => {
  const store = createNoticeQueueStore();
  store.activate("A");
  store.enqueue({ sessionId: "A", message: "A 的提示", type: "info" });
  store.enqueue({ sessionId: "B", message: "B 的提示", type: "info" });
  assert.deepEqual(store.getVisible().map((n) => n.message), ["A 的提示"]);
  store.activate("B");
  assert.deepEqual(store.getVisible().map((n) => n.message), ["B 的提示"]);
  store.activate("A");
  assert.deepEqual(store.getVisible().map((n) => n.message), ["A 的提示"]);
});

test("最多同时展示 3 条普通 + 3 条高级；高级不自动关闭", () => {
  const store = createNoticeQueueStore();
  store.activate("A");
  for (let i = 0; i < 5; i++) {
    store.enqueue({ sessionId: "A", message: `t${i}`, type: "info" });
  }
  for (let i = 0; i < 5; i++) {
    store.enqueue({ sessionId: "A", message: `e${i}`, type: "error" });
  }
  const visible = store.getVisible();
  assert.equal(visible.filter((n) => n.tier === "important").length, NOTICE_IMPORTANT_VISIBLE);
  assert.equal(visible.filter((n) => n.tier === "transient").length, NOTICE_TRANSIENT_VISIBLE);
  // important 在前
  assert.equal(visible[0].tier, "important");
  assert.equal(store.queueLength("A"), 10);
});

test("dismiss/expire 后队列移除，后续条目按 FIFO 补位", () => {
  const store = createNoticeQueueStore();
  store.activate("A");
  for (let i = 0; i < 5; i++) {
    store.enqueue({ sessionId: "A", message: `t${i}`, type: "info" });
  }
  let visible = store.getVisible();
  assert.equal(visible.length, NOTICE_TRANSIENT_VISIBLE);
  const firstId = visible[0].id;
  // 普通消息自动过期后，第 4 条补位
  store.expireTransient(firstId);
  visible = store.getVisible();
  assert.equal(visible.length, NOTICE_TRANSIENT_VISIBLE);
  assert.ok(!visible.some((n) => n.id === firstId));
  assert.ok(visible.some((n) => n.message === "t3"));
});

test("重要消息 pin 排序在普通之前；dismiss 后不复活", () => {
  const store = createNoticeQueueStore();
  store.activate("A");
  store.enqueue({ sessionId: "A", message: "err", type: "error" });
  store.enqueue({ sessionId: "A", message: "ok", type: "info" });
  let visible = store.getVisible();
  assert.equal(visible[0].message, "err");
  store.dismiss(visible[0].id);
  visible = store.getVisible();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].message, "ok");
});

test("clearSession 只清指定会话；同 id 去重", () => {
  const store = createNoticeQueueStore();
  store.activate("A");
  store.enqueue({ sessionId: "A", id: "dup", message: "x", type: "info" });
  store.enqueue({ sessionId: "A", id: "dup", message: "x", type: "info" });
  assert.equal(store.queueLength("A"), 1);
  store.enqueue({ sessionId: "B", id: "dup", message: "y", type: "info" });
  store.clearSession("A");
  assert.equal(store.queueLength("A"), 0);
  assert.equal(store.queueLength("B"), 1);
});
