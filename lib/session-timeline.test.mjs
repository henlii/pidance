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
  isTailPageBehind,
  mergeTailRecords,
  optimisticRecord,
  prependOlderRecords,
  applyHydratePending,
  insertRecordBeforePendingSteers,
  retainPendingRecords,
  resolveHydratePendingPolicy,
  submissionKey,
  timelineEntryIds,
  timelineFromDisk,
  timelineMessages,
} = await jiti.import("./session-timeline.ts");

const user = (content, timestamp = 1) => ({ role: "user", content, timestamp });
const assistant = (content, timestamp = 1) => ({ role: "assistant", content, timestamp });
/** 已落盘的 user 记录（entryId 就位、pending=false）。 */
const diskRecordUser = (entryId, content) => ({
  key: entryId,
  message: user(content),
  entryId,
  pending: false,
});

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

test("tail 重载：磁盘页落后于时间线时不得缩短时间线（刷新不得让内容倒退）", () => {
  // 时间线：live 已经拿到 u2/a2（比这次磁盘读新）
  const live = timelineFromDisk([user("u1"), assistant("a1"), user("u2"), assistant("a2")], ["e1", "e2", "e3", "e4"]);
  // 落后快照：磁盘只读到 e1..e3（末笔 e4 还没落盘）
  const behind = [user("u1"), assistant("a1"), user("u2")];
  assert.equal(isTailPageBehind(["e1", "e2", "e3", "e4"], ["e1", "e2", "e3"]), true);
  assert.deepEqual(timelineEntryIds(mergeTailRecords(live, behind, ["e1", "e2", "e3"])), ["e1", "e2", "e3", "e4"]);
  assert.deepEqual(timelineMessages(mergeTailRecords(live, behind, ["e1", "e2", "e3"])).at(-1).content, "a2");

  // 页尾就是时间线末条（同一条路径、没有更新内容）→ 不是落后页
  assert.equal(isTailPageBehind(["e1", "e2"], ["e1", "e2"]), false);
  // 页里有时间线没见过的条目 → 磁盘更新，走正常合并
  assert.equal(isTailPageBehind(["e1"], ["e1", "e9"]), false);
  // 时间线全是本地乐观记录（无 entryId）→ 不判定为落后
  assert.equal(isTailPageBehind(["", ""], ["e1"]), false);
});

test("tail 重载：落后页只用于补齐更旧历史，新页仍替换重叠段", () => {
  const live = timelineFromDisk([user("u1"), assistant("a1")], ["e2", "e3"]);
  // 磁盘页含已知条目 + 一条新条目 → 正常替换重叠段之后
  const withNew = mergeTailRecords(live, [assistant("a1"), user("u2")], ["e3", "e4"]);
  assert.deepEqual(timelineEntryIds(withNew), ["e2", "e3", "e4"]);
  // 落后页（全已知且不落在末条）→ 原样返回
  assert.deepEqual(timelineEntryIds(mergeTailRecords(live, [assistant("a1")], ["e3"])), ["e2", "e3"]);
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

test("retainPendingRecords：历史同文不算交付；新出现的 user 才消化一条 pending", () => {
  const first = optimisticRecord("local:1", user("继续"));
  const second = optimisticRecord("local:2", user("继续"));
  const before = [...timelineFromDisk([user("继续")], ["e1"]), first, second];
  const reloaded = timelineFromDisk([user("继续")], ["e1"]);
  const kept = retainPendingRecords(before, reloaded);
  assert.deepEqual(
    kept.filter((record) => record.pending).map((record) => record.key),
    ["local:1", "local:2"],
    "窗口里已有一句继续不能证明新引导已交付",
  );
  const delivered = timelineFromDisk([user("继续"), user("继续")], ["e1", "e2"]);
  const after = retainPendingRecords(before, delivered);
  assert.equal(after.filter((record) => record.pending).length, 1);
  assert.equal(after.filter((record) => record.entryId === "e2").length, 1);
});

test("retainPendingRecords：assistant 同文不能消化 user pending", () => {
  const pending = optimisticRecord("local:steer", user("继续"));
  const before = [...timelineFromDisk([user("old")], ["e1"]), pending];
  const reloaded = timelineFromDisk([user("old"), assistant("继续")], ["e1", "e2"]);
  const kept = retainPendingRecords(before, reloaded);
  assert.equal(kept.some((record) => record.key === "local:steer"), true);
});

test("retainPendingRecords：磁盘尾部新 user 按序消化 pending，不要求附件形状一致", () => {
  const pending = optimisticRecord(submissionKey("s1"), {
    role: "user",
    content: [
      { type: "text", text: "hello" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aaa" } },
    ],
    timestamp: 2,
  });
  const before = [...timelineFromDisk([user("older")], ["e1"]), pending];
  const reloaded = timelineFromDisk([user("older"), user("hello")], ["e1", "e2"]);
  const kept = retainPendingRecords(before, reloaded);
  assert.equal(kept.filter((record) => record.pending).length, 0);
  assert.equal(kept.at(-1).entryId, "e2");
});

test("retainPendingRecords：尾页截断仍消化 overlap 之后的新 user，不得留下双气泡", () => {
  const older = [user("old-0"), user("old-1"), user("old-2"), assistant("ok"), user("old-4")];
  const olderIds = ["e0", "e1", "e2", "e3", "e4"];
  const pending = optimisticRecord(submissionKey("s1"), user("hello"));
  const before = [...timelineFromDisk(older, olderIds), pending];
  const tail = timelineFromDisk(
    [user("old-2"), assistant("ok"), user("old-4"), user("hello")],
    ["e2", "e3", "e4", "e5"],
  );
  const kept = retainPendingRecords(before, tail);
  assert.equal(
    kept.filter((record) => record.message.content === "hello").length,
    1,
    "截断尾页不得把乐观气泡和磁盘消息叠成两条",
  );
  assert.equal(kept.filter((record) => record.pending).length, 0);
  assert.equal(kept.at(-1).entryId, "e5");
});

test("hydrate pending 策略：replace 默认 drop，显式 retain 即使无重叠窗口也保留", () => {
  const pending = optimisticRecord("local:steer", user("引导"));
  const previous = [...timelineFromDisk([user("old")], ["e1"]), pending];
  const laterPage = timelineFromDisk([user("much-older")], ["e0"]);
  assert.equal(resolveHydratePendingPolicy("replace"), "drop");
  assert.equal(applyHydratePending(previous, laterPage, "drop").some((record) => record.key === "local:steer"), false);
  assert.equal(applyHydratePending(previous, laterPage, "retain").some((record) => record.key === "local:steer"), true);
});

test("hydrate pending 策略：共享祖先的另一叶必须显式 drop，不能靠 entryId 交集", () => {
  const pending = optimisticRecord("local:steer", user("引导"));
  const previous = [...timelineFromDisk([user("root"), user("leaf-a")], ["root", "a1"]), pending];
  const otherLeaf = timelineFromDisk([user("root"), user("leaf-b")], ["root", "b1"]);
  assert.equal(
    applyHydratePending(previous, otherLeaf, "drop").some((record) => record.key === "local:steer"),
    false,
    "切分支丢掉旧叶引导",
  );
  assert.equal(
    applyHydratePending(previous, otherLeaf, "retain").some((record) => record.key === "local:steer"),
    true,
    "若误用 retain，共享祖先也会把引导留下——所以必须由调用方 drop",
  );
});

test("无 key 的第二句同文 user 不得因磁盘已有一句而被吞掉", () => {
  const timeline = timelineFromDisk([user("继续"), assistant("ok")], ["e1", "e2"]);
  const result = confirmUserMessage(timeline, {
    key: null,
    message: user("继续"),
    entryId: "",
    fallbackKey: "local:late",
  });
  assert.equal(result.outcome, "appended", "另一端新发的第二句继续必须可见");
  assert.equal(result.timeline.length, 3);
});

test("retainPendingRecords：不重叠的历史窗口里的同文不是这次交付", () => {
  const pending = optimisticRecord("local:steer", user("继续"));
  const previous = [...timelineFromDisk([user("recent")], ["e10"]), pending];
  const olderWindow = timelineFromDisk([user("继续"), user("old")], ["e0", "e1"]);
  const kept = retainPendingRecords(previous, olderWindow);
  assert.equal(kept.some((record) => record.key === "local:steer"), true);
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

test("useAgentSession hydrate 调用方显式声明 pending 意图", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  const loadSession = source.slice(source.indexOf("const loadSession = "), source.indexOf("const loadOlderHistory ="));
  const loadContext = source.slice(source.indexOf("const loadContext = "), source.indexOf("const jumpToEntry ="));
  const jumpToEntry = source.slice(source.indexOf("const jumpToEntry = "), source.indexOf("const loadNewerHistory ="));
  assert.match(loadSession, /pending:\s*"retain"/);
  assert.match(loadContext, /pending:\s*"drop"/);
  assert.match(jumpToEntry, /pending:\s*"retain"/);
  assert.doesNotMatch(loadSession, /shouldKeepPendingOnReplace|timelineAfterHydrate/);
});

// ---------------------------------------------------------------------------
// Bug：流式中插话的引导，会被随后落盘的这一步记录翻到上方
// ---------------------------------------------------------------------------

test("insertRecordBeforePendingSteers：本步记录插在流式期间发出的引导之前", () => {
  const step = { key: "e-step", message: assistant("STEP"), entryId: "e-step", pending: false };
  const steer = { ...optimisticRecord("local:1", user("steer")), duringStreamingStep: true };
  const timeline = [diskRecordUser("e-u0", "q0"), steer];

  const next = insertRecordBeforePendingSteers(timeline, step);
  assert.deepEqual(next.map((record) => record.key), ["e-u0", "e-step", "local:1"]);
  // 引导仍是待确认记录（后面 confirmUserMessage 要就地确认它）
  assert.equal(next.find((record) => record.key === "local:1")?.pending, true);
});

test("insertRecordBeforePendingSteers：不误伤新回合的用户消息与已确认记录", () => {
  // 普通新回合：引导没有 duringStreamingStep 标记（上一个 step 已落盘）→ 直接追加
  const plain = optimisticRecord("local:2", user("next prompt"));
  const appended = insertRecordBeforePendingSteers([diskRecordUser("e-u0", "q0"), plain], {
    key: "e-step2", message: assistant("STEP2"), entryId: "e-step2", pending: false,
  });
  assert.deepEqual(appended.map((record) => record.key), ["e-u0", "local:2", "e-step2"]);

  // 尾部不是这类待确认记录（中间隔了别的已落盘消息）→ 不跳过
  const mixed = [
    diskRecordUser("e-u0", "q0"),
    { ...optimisticRecord("local:3", user("steer")), duringStreamingStep: true },
    { key: "e-tool", message: assistant("RESULT"), entryId: "e-tool", pending: false },
    { ...optimisticRecord("local:4", user("steer2")), duringStreamingStep: true },
  ];
  const appended2 = insertRecordBeforePendingSteers(mixed, {
    key: "e-step3", message: assistant("STEP3"), entryId: "e-step3", pending: false,
  });
  assert.deepEqual(appended2.map((record) => record.key), ["e-u0", "local:3", "e-tool", "e-step3", "local:4"]);
});
