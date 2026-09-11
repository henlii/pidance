/**
 * 会话时间线纯变换：原子归并、稳定身份、单调确认。
 * 这些是「消息偶尔串位/丢失/重复」的根因回归测试。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  appendRecord,
  confirmUserMessage,
  dropAllPendingRecords,
  dropPendingRecord,
  mergeTailRecords,
  optimisticRecord,
  prependOlderRecords,
  retainPendingRecords,
  submissionKey,
  timelineEntryIds,
  timelineFromDisk,
  timelineMessages,
} = await jiti.import("./session-timeline.ts");

const user = (content, timestamp = 1) => ({ role: "user", content, timestamp });
const assistant = (content, timestamp = 1) => ({ role: "assistant", content, timestamp });

test("磁盘快照派生 messages/entryIds 永远平行", () => {
  const timeline = timelineFromDisk([user("a"), assistant("b"), user("c")], ["e1", "", "e3"]);
  assert.deepEqual(timelineEntryIds(timeline), ["e1", "", "e3"]);
  assert.equal(timelineMessages(timeline).length, timeline.length);
  assert.ok(timeline.every((record) => record.pending === false), "磁盘记录不是 pending");
});

test("prepend 更旧页：按 entryId 去重，保留原有记录与乐观项", () => {
  const base = [
    ...timelineFromDisk([assistant("live")], ["e5"]),
    optimisticRecord(submissionKey("s1"), user("optimistic")),
  ];
  const next = prependOlderRecords(base, [user("old1"), user("old2")], ["e3", "e5"]);
  assert.deepEqual(timelineEntryIds(next), ["e3", "e5", ""], "重叠的 e5 不重复插入");
  assert.equal(next.length, base.length + 1);
  assert.equal(next[next.length - 1].key, submissionKey("s1"), "乐观项保持在末尾");
  assert.equal(next[next.length - 1].pending, true);
});

test("tail 重载：保留更旧前缀，替换重叠段及之后", () => {
  const base = timelineFromDisk(
    [user("old"), assistant("mid"), user("recent")],
    ["e1", "e2", "e3"],
  );
  const next = mergeTailRecords(base, [assistant("mid"), user("recent"), assistant("new")], ["e2", "e3", "e4"]);
  assert.deepEqual(timelineEntryIds(next), ["e1", "e2", "e3", "e4"]);
  assert.equal(next[0].message.content, "old");
});

test("tail 重载：无重叠时整体替换，空页不覆盖", () => {
  const base = timelineFromDisk([user("a")], ["e1"]);
  assert.deepEqual(timelineEntryIds(mergeTailRecords(base, [user("b")], ["e9"])), ["e9"]);
  assert.deepEqual(timelineEntryIds(mergeTailRecords(base, [], [])), ["e1"]);
});

test("确认按 stable key 原位替换，不依赖数组下标", () => {
  // 乐观记录 key 是 sub:<id>；prepend 之后下标整体位移，key 仍然命中。
  let timeline = appendRecord([], optimisticRecord(submissionKey("s1"), user("hello")));
  timeline = prependOlderRecords(timeline, [user("older"), assistant("older-reply")], ["e1", "e2"]);
  const result = confirmUserMessage(timeline, {
    key: submissionKey("s1"),
    message: user("hello"),
    entryId: "",
    fallbackKey: "local:1",
  });
  assert.equal(result.outcome, "key");
  assert.equal(result.timeline.length, timeline.length, "不追加新记录");
  assert.equal(result.timeline[0].message.content, "older", "更旧历史的记录未被改写");
  assert.equal(result.timeline[2].message.content, "hello");
  assert.equal(result.timeline[2].pending, false, "确认后不再是 pending");
});

test("正文被插件变换时仍按 key 原位确认，不产生双条", () => {
  const timeline = appendRecord([], optimisticRecord(submissionKey("s1"), user("original prompt")));
  const result = confirmUserMessage(timeline, {
    key: submissionKey("s1"),
    message: user("plugin transformed prompt"),
    entryId: "",
    fallbackKey: "local:1",
  });
  assert.equal(result.timeline.length, 1);
  assert.equal(result.timeline[0].message.content, "plugin transformed prompt");
});

test("hydrate 已对账掉乐观记录后，迟到的确认不追加重复", () => {
  // 提交 s1 → 磁盘 hydrate 已含同一条 user（entryId e1）→ 迟到且无 entryId 的
  // message_end 到达。旧实现会再追加一条一模一样的消息。
  const timeline = timelineFromDisk([user("hello"), assistant("hi")], ["e1", "e2"]);
  const result = confirmUserMessage(timeline, {
    key: submissionKey("s1"),
    message: user("hello"),
    entryId: "",
    fallbackKey: "local:1",
  });
  assert.equal(result.outcome, "reconciled");
  assert.equal(result.timeline.length, 2, "不得追加重复消息");
  assert.deepEqual(timelineEntryIds(result.timeline), ["e1", "e2"]);
});

test("hydrate 尚未包含该提交时，迟到的确认不得被当成交付证据而丢消息", () => {
  // 与上一个用例成对：这里是「快照不含这条消息」。
  // 乐观记录被一份尚未包含它的磁盘快照替换掉；此时乐观记录的 key 已不存在，
  // 但时间线里也找不到它 —— 不是交付证据，必须仍然可见。
  const timeline = timelineFromDisk([user("hi"), assistant("old")], ["e1", "e2"]);
  const result = confirmUserMessage(timeline, {
    key: submissionKey("s1"),
    message: user("hello"),
    entryId: "",
    fallbackKey: "local:1",
  });
  assert.equal(result.outcome, "appended", "无法证明已交付时必须入列，不得静默丢弃");
  assert.deepEqual(
    result.timeline.map((record) => record.message.content),
    ["hi", "old", "hello"],
  );
});

test("retainPendingRecords：磁盘尚未包含的乐观记录不因重载消失", () => {
  const optimistic = optimisticRecord(submissionKey("s1"), user("hello"));
  const before = [...timelineFromDisk([user("older")], ["e1"]), optimistic];
  // 尾页重载只带回更旧的磁盘内容，未包含刚发出的 hello。
  const reloaded = timelineFromDisk([user("older")], ["e1"]);
  const kept = retainPendingRecords(before, reloaded);
  assert.deepEqual(
    kept.map((record) => record.message.content),
    ["older", "hello"],
    "未确认气泡必须保留，否则会先消失再出现",
  );
  assert.equal(kept[kept.length - 1].key, submissionKey("s1"));
});

test("retainPendingRecords：磁盘已包含该消息时不再保留乐观副本", () => {
  const optimistic = optimisticRecord(submissionKey("s1"), user("hello"));
  const before = [...timelineFromDisk([user("older")], ["e1"]), optimistic];
  const reloaded = timelineFromDisk([user("older"), user("hello")], ["e1", "e2"]);
  const kept = retainPendingRecords(before, reloaded);
  assert.deepEqual(
    kept.map((record) => record.message.content),
    ["older", "hello"],
    "不得出现第二条 hello",
  );
  assert.equal(kept[1].entryId, "e2");
});

test("retainPendingRecords：归并已保留同一 key 时不重复追加", () => {
  const optimistic = optimisticRecord(submissionKey("s1"), user("hello"));
  const before = [...timelineFromDisk([user("old")], ["e1"]), optimistic];
  // prepend 不动尾部：乐观记录已在 merged 里。
  const merged = prependOlderRecords(before, [user("older")], ["e0"]);
  const kept = retainPendingRecords(before, merged);
  assert.equal(
    kept.filter((record) => record.key === submissionKey("s1")).length,
    1,
    "同一 key 只允许一条",
  );
});

test("同文本不同 entryId 的两条真实消息都要入列", () => {
  let timeline = timelineFromDisk([], []);
  timeline = confirmUserMessage(timeline, {
    key: null,
    message: user("继续"),
    entryId: "e1",
    fallbackKey: "local:1",
  }).timeline;
  const second = confirmUserMessage(timeline, {
    key: null,
    message: user("继续"),
    entryId: "e2",
    fallbackKey: "local:2",
  });
  assert.equal(second.outcome, "appended");
  assert.deepEqual(timelineEntryIds(second.timeline), ["e1", "e2"]);
});

test("已确认（非 pending）的同文记录不参与文本匹配，连续同文真实消息不被合并", () => {
  // 第一条已由事件确认（无 entryId 但已投递），第二条同文是另一条真实消息。
  const confirmed = appendRecord([], {
    key: "local:1",
    message: user("继续"),
    entryId: "",
    pending: false,
  });
  const result = confirmUserMessage(confirmed, {
    key: null,
    message: user("继续"),
    entryId: "e9",
    fallbackKey: "local:2",
  });
  assert.equal(result.timeline.length, 2, "不得把两条真实消息合并成一条");
  assert.deepEqual(timelineEntryIds(result.timeline), ["", "e9"]);
});

test("同一 entryId 重放不产生双条", () => {
  const timeline = timelineFromDisk([user("hi")], ["e1"]);
  const result = confirmUserMessage(timeline, {
    key: null,
    message: user("hi"),
    entryId: "e1",
    fallbackKey: "local:1",
  });
  assert.equal(result.outcome, "duplicate");
  assert.equal(result.timeline.length, 1);
});

test("无 key 时绑定末尾同文本的 pending 记录", () => {
  const timeline = appendRecord([], optimisticRecord("local:9", user("继续")));
  const result = confirmUserMessage(timeline, {
    key: null,
    message: user("继续"),
    entryId: "e7",
    fallbackKey: "local:1",
  });
  assert.equal(result.outcome, "text");
  assert.deepEqual(timelineEntryIds(result.timeline), ["e7"]);
  assert.equal(result.timeline[0].key, "local:9", "原位替换保留原 key");
});

test("dropPendingRecord 只删尚无交付证据的记录", () => {
  const timeline = [
    ...timelineFromDisk([user("disk")], ["e1"]),
    optimisticRecord(submissionKey("s1"), user("pending")),
  ];
  const dropped = dropPendingRecord(timeline, submissionKey("s1"));
  assert.equal(dropped.dropped, true);
  assert.deepEqual(timelineEntryIds(dropped.timeline), ["e1"]);

  const confirmed = timelineFromDisk([user("disk")], ["e1"]);
  assert.equal(dropPendingRecord(confirmed, confirmed[0].key).dropped, false, "磁盘记录不得删除");

  // 已投递但服务端未给 entryId：不得因迟到的 HTTP 错误被删掉。
  const delivered = appendRecord([], {
    key: "local:1",
    message: user("delivered"),
    entryId: "",
    pending: false,
  });
  assert.equal(dropPendingRecord(delivered, "local:1").dropped, false, "已确认投递的记录不得删除");
});

test("dropAllPendingRecords 清掉全部未投递乐观项，保留已确认与磁盘记录", () => {
  const timeline = [
    ...timelineFromDisk([user("disk")], ["e1"]),
    optimisticRecord("local:1", user("pending a")),
    optimisticRecord("local:2", user("pending b")),
    { key: "local:3", message: user("delivered"), entryId: "", pending: false },
  ];
  const result = dropAllPendingRecords(timeline);
  assert.equal(result.dropped, true);
  assert.deepEqual(timelineMessages(result.timeline).map((message) => message.content), ["disk", "delivered"]);

  const clean = dropAllPendingRecords(timelineFromDisk([user("disk")], ["e1"]));
  assert.equal(clean.dropped, false);
});
