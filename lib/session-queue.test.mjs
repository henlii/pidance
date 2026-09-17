/**
 * follow-up 队列格式与条目对齐的回归测试。
 *
 * 关注「身份不靠正文、顺序变化不串条目」这一类判定（issue #42 第四轮复核指出的
 * 合并 / 顺序不匹配）：
 * - 旧格式（字符串数组）重复解码必须得到同一身份，否则重启后取回与回执对不上；
 * - 整包写入的条目对齐按「正文 + 附件」配对，服务端顺序变化不换 id / 状态；
 * - 同文两条靠附件区分，不互相换图，也不塌成一条；
 * - 写载荷没带图时保留原图（旧回执不得静默丢图）；
 * - 纯图条目（正文为空）解码时不得消失；
 * - 合并投递时正文与附件一起带走。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeFollowUpPayload,
  parseFollowUpQueue,
  reconcileFollowUpItems,
  serializeFollowUpQueue,
} from "./session-queue.ts";

const media = (path) => [
  { role: "original", path, name: "图.png", mimeType: "image/png", size: 12 },
];

const item = (id, text, state = "waiting", refs) => ({
  id,
  text,
  state,
  ...(refs ? { media: refs } : {}),
});

test("旧格式队列重复解码得到同一身份，同文两条仍是两条", () => {
  const first = parseFollowUpQueue(["甲", "甲"]).items;
  const second = parseFollowUpQueue(["甲", "甲"]).items;
  assert.deepEqual(
    first.map((entry) => entry.id),
    second.map((entry) => entry.id),
  );
  assert.notEqual(first[0].id, first[1].id);
});

test("整包写入按条目标签对齐：顺序变化不换 id 与状态", () => {
  const current = [item("a", "一"), item("b", "二", "claimed")];
  const next = reconcileFollowUpItems(current, [{ text: "二" }, { text: "一" }]);
  assert.deepEqual(
    next.map((entry) => [entry.id, entry.state]),
    [["b", "claimed"], ["a", "waiting"]],
  );
});

test("同文两条靠附件配对，不互换条目", () => {
  const current = [
    item("a", "看图", "waiting", media("/tmp/a.png")),
    item("b", "看图", "claimed", media("/tmp/b.png")),
  ];
  const next = reconcileFollowUpItems(current, [
    { text: "看图", media: media("/tmp/b.png") },
    { text: "看图", media: media("/tmp/a.png") },
  ]);
  assert.deepEqual(
    next.map((entry) => [entry.id, entry.media[0].path]),
    [["b", "/tmp/b.png"], ["a", "/tmp/a.png"]],
  );
});

test("写载荷没带图时保留原条目的图，新载荷成为新 waiting 条目", () => {
  const kept = reconcileFollowUpItems(
    [item("a", "看图", "waiting", media("/tmp/a.png"))],
    [{ text: "看图" }],
  );
  assert.deepEqual(kept[0].media.map((ref) => ref.path), ["/tmp/a.png"]);
  assert.equal(kept[0].id, "a");

  const replaced = reconcileFollowUpItems([item("a", "一")], [{ text: "二" }]);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].text, "二");
  assert.equal(replaced[0].state, "waiting");
  assert.notEqual(replaced[0].id, "a");
});

test("纯图条目解码保留，正文与附件都空则丢弃", () => {
  const parsed = parseFollowUpQueue({
    items: [
      { id: "img", text: "", state: "waiting", media: media("/tmp/i.png") },
      { id: "empty", text: "   " },
    ],
    revision: 3,
  });
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].id, "img");
  assert.equal(parsed.revision, 3);
});

test("序列化往返保留身份、状态、附件与受理令牌", () => {
  const state = {
    items: [item("a", "看图", "claimed", media("/tmp/a.png"))],
    revision: 2,
    admittedAttemptIds: ["try-1"],
  };
  assert.deepEqual(parseFollowUpQueue(serializeFollowUpQueue(state)), state);
});

test("合并投递带走全部正文与附件，补充正文并入队尾", () => {
  const merged = mergeFollowUpPayload(
    [item("a", "看图", "waiting", media("/tmp/a.png")), item("b", "第二问")],
    "补充",
  );
  assert.equal(merged.text, "看图\n第二问\n补充");
  assert.deepEqual(merged.media.map((ref) => ref.path), ["/tmp/a.png"]);
});

test("I4：带身份的对齐按 id 命中，删掉的是指定的那条同文条目", () => {
  const current = [item("a", "same"), item("b", "same")];
  assert.deepEqual(
    reconcileFollowUpItems(current, [{ id: "b", text: "same" }]).map((entry) => entry.id),
    ["b"],
    "省略哪一条由身份决定，不再由 first-fit 决定",
  );
  assert.deepEqual(
    reconcileFollowUpItems(current, [{ id: "b", text: "same" }, { id: "a", text: "same" }]).map((entry) => entry.id),
    ["b", "a"],
    "顺序变化也按身份对齐",
  );
});

test("I4：身份已在途（claimed）的载荷被忽略，不重新入队", () => {
  assert.deepEqual(
    reconcileFollowUpItems([], [{ id: "x", text: "in-flight" }], { inFlightIds: ["x"] }),
    [],
    "已提交给 Agent 的条目不能再变成一条新的等待条目（否则投递两次）",
  );
});

test("I4：声明了队列里不存在的身份时退回正文配对，不制造同文重复条目", () => {
  assert.deepEqual(
    reconcileFollowUpItems([item("a", "same")], [{ id: "gone", text: "same" }]).map((entry) => entry.id),
    ["a"],
  );
});
