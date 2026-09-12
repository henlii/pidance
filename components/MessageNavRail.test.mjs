import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { measureUserMessageNodes, messageNavPreview, userMessageText } = await jiti.import("./MessageNavRail.tsx");

// ── 纯逻辑：节点测量 / 预览 ──

/** 假滚动容器：内容总高 totalH，当前滚动 scrollTop。 */
function fakeScroller(totalH, scrollTop = 0) {
  return {
    scrollHeight: totalH,
    scrollTop,
    getBoundingClientRect: () => ({ top: 0 }),
  };
}

/** 假消息 DOM：按「相对内容顶部的像素位置」给高度与位置。 */
function fakeRef(offsetTop, height) {
  return { getBoundingClientRect: () => ({ top: offsetTop, height }) };
}

/** 计划项构造：用户消息 + process group（整组只占一个 ref 槽位）。 */
const msgItem = (index, attachRef = true) => ({ kind: "message", messageIndex: index, attachRef });
const groupItem = (attachRefMessageIndex = 1) => ({ kind: "processGroup", userIdx: 0, finalAssistantIdx: 2, messageCount: 1, toolCallCount: 1, children: [], attachRefMessageIndex });

function measure(plan, refs, totalH, scrollTop = 0, roles = {}) {
  // 槽位与 ChatWindow 同判据：按消息顺序给 user/assistant 编号
  const visibleIndices = Object.keys(roles)
    .map(Number)
    .filter((i) => roles[i] === "user" || roles[i] === "assistant")
    .sort((a, b) => a - b);
  return measureUserMessageNodes({
    plan,
    refs,
    scrollEl: fakeScroller(totalH, scrollTop),
    slotOf: (index) => {
      const slot = visibleIndices.indexOf(index);
      return slot === -1 ? undefined : slot;
    },
    isUserMessage: (index) => roles[index] === "user",
    textOf: (index) => `text-${index}`,
  });
}

test("按槽位查表：group 用其代表消息的槽位，节点指向正确 DOM", () => {
  // 真实场景：user0 → (助手过程+group) → user3
  // 可见槽位按消息顺序编号：user0=0, assistant1=1, assistant2=2, user3=3
  const plan = [msgItem(0), groupItem(1), msgItem(3)];
  const roles = { 0: "user", 1: "assistant", 2: "assistant", 3: "user" };
  const refs = [
    fakeRef(0, 100),    // slot0 → user0
    fakeRef(100, 300),  // slot1 → group（代表 assistant1）
    fakeRef(400, 100),  // slot2 → assistant2
    fakeRef(500, 100),  // slot3 → user3
  ];
  const nodes = measure(plan, refs, 600, 0, roles);
  assert.deepEqual(nodes, [
    { index: 0, refIndex: 0, topRatio: 0, text: "text-0" },
    { index: 3, refIndex: 3, topRatio: 500 / 600, text: "text-3" },
  ]);
});

test("不可见消息（toolResult/custom）没有槽位，不产出节点", () => {
  // 计划：user0 → toolResult1（attachRef 但不可见）→ user2
  const plan = [msgItem(0), msgItem(1), msgItem(2)];
  const roles = { 0: "user", 1: "toolResult", 2: "user" };
  const refs = [fakeRef(0, 100), fakeRef(100, 100)];
  const nodes = measure(plan, refs, 200, 0, roles);
  assert.deepEqual(nodes.map((n) => [n.index, n.refIndex]), [[0, 0], [2, 1]]);
});

test("processGroup 无 attachRefMessageIndex 时不产出节点，不影响其它节点槽位", () => {
  const plan = [msgItem(0), { kind: "processGroup", userIdx: 0, finalAssistantIdx: 1, messageCount: 1, toolCallCount: 0, children: [] }, msgItem(2)];
  const roles = { 0: "user", 1: "assistant", 2: "user" };
  const refs = [fakeRef(0, 100), fakeRef(100, 100), fakeRef(180, 20)];
  const nodes = measure(plan, refs, 200, 0, roles);
  assert.deepEqual(nodes.map((n) => [n.index, n.refIndex]), [[0, 0], [2, 2]]);
});

test("attachRef=false / live 项无槽位，不导致后续节点错位", () => {
  const plan = [msgItem(0), { kind: "message", messageIndex: null, attachRef: false, source: "live" }, msgItem(2)];
  const roles = { 0: "user", 2: "user" };
  const refs = [fakeRef(0, 100), fakeRef(100, 100)];
  const nodes = measure(plan, refs, 200, 0, roles);
  assert.deepEqual(nodes.map((n) => n.index), [0, 2]);
  assert.deepEqual(nodes.map((n) => n.refIndex), [0, 1]);
});

test("滚动位偏移参与计算：节点比例是「内容内位置 / 内容总高」", () => {
  const plan = [msgItem(0)];
  // 视口已下滚 250px，元素顶边在视口内 50px 处 → 内容内位置 300px
  const refs = [{ getBoundingClientRect: () => ({ top: 50, height: 100 }) }];
  const nodes = measure(plan, refs, 600, 250, { 0: "user" });
  assert.deepEqual(nodes, [{ index: 0, refIndex: 0, topRatio: 0.5, text: "text-0" }]);
});

test("缺 DOM 引用/空内容高度：跳过该节点且不崩溃", () => {
  const plan = [msgItem(0), msgItem(1)];
  const nodes = measure(plan, [null, fakeRef(10, 10)], 0, 0, { 0: "user", 1: "user" });
  assert.deepEqual(nodes, [], "高度未知时不产出节点（避免 NaN 比例）");
});

test("userMessageText 支持字符串与 text 块，非用户消息返回空", () => {
  assert.equal(userMessageText({ role: "user", content: "纯文本" }), "纯文本");
  assert.equal(
    userMessageText({ role: "user", content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }),
    "a\nb",
  );
  assert.equal(userMessageText({ role: "assistant", content: [{ type: "text", text: "x" }] }), "");
  assert.equal(userMessageText({ role: "user" }), "");
});

test("messageNavPreview 压平换行并按长度截断", () => {
  assert.equal(messageNavPreview("  多行\n文本   带空格  "), "多行 文本 带空格");
  assert.equal(messageNavPreview("x".repeat(200)).length, 121);
  assert.ok(messageNavPreview("x".repeat(200)).endsWith("…"));
});
