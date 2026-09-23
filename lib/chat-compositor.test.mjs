import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const load = () => jiti.import("./chat-compositor.ts");

const assistant = (content, extra = {}) => ({
  role: "assistant",
  provider: "p",
  model: "m",
  content,
  ...extra,
});
const user = (content = "q") => ({ role: "user", content });
const custom = (content = "process") => ({
  role: "custom",
  customType: "test",
  content,
  display: true,
});
const text = (value) => ({ type: "text", text: value });
const tool = (id = "c") => ({
  type: "toolCall",
  toolCallId: id,
  toolName: "bash",
  input: {},
});
const toolResult = (toolCallId = "c") => ({
  role: "toolResult",
  toolCallId,
  content: [],
});
const compose = (composeChatPlan, messages, options = {}) => composeChatPlan({
  messages,
  isStreaming: false,
  ...options,
});

test("空消息和单消息保持原序", async () => {
  const { composeChatPlan } = await load();

  assert.deepEqual(compose(composeChatPlan, []), []);
  const plan = compose(composeChatPlan, [user()]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].messageIndex, 0);
});

test("两个普通问答轮保持原始索引顺序", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([text("a")]), user(), assistant([text("b")])];

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(plan.map((item) => item.kind === "message"
    ? item.messageIndex
    : [item.userIdx, item.finalAssistantIdx]), [0, 1, 2, 3]);
});

test("assistant 的 thinking/toolCall/text 不再拆分：plan 直渲该消息", async () => {
  const { composeChatPlan } = await load();
  const usage = { input: 1 };
  const messages = [user(), assistant([
    { type: "thinking", thinking: "x" },
    tool(),
    text("answer"),
  ], { usage })];

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(plan.map((item) => item.messageIndex), [0, 1]);
  assert.equal(plan[1].keyPrefix, "message");
  assert.equal(plan[1].attachRef, true);
  assert.equal(plan[1].messageOverride, undefined, "磁盘项不再被 override 改写（不拆分、不去 usage）");
});
test("无 final assistant 时保持原序直渲", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), toolResult(), custom()];

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(plan.map((item) => item.messageIndex), [0, 1, 2]);
});

test("没有 live slot 时 plan 与 messages 一一对应", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([text("live")])];

  const plan = compose(composeChatPlan, messages, { isStreaming: true });

  assert.deepEqual(plan.map((item) => item.messageIndex), [0, 1]);
});
test("live tail 的末尾 assistant 隐藏 timestamp", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([text("live")])];

  const plan = compose(composeChatPlan, messages, { isStreaming: true });

  assert.equal(plan[1].showTimestamp, false);
});

test("非 live 消息同样直渲，不折叠", async () => {
  const { composeChatPlan } = await load();
  const messages = [
    user(),
    assistant([{ type: "thinking", thinking: "work" }, tool(), text("answer")]),
  ];

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(plan.map((item) => item.messageIndex), [0, 1]);
});
test("无 answer 的 assistant 仍按原序入 plan 且可挂 ref", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([
    { type: "thinking", thinking: "still working" },
    tool(),
  ])];

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(plan.map((item) => item.messageIndex), [0, 1]);
  assert.equal(plan[1].attachRef, true);
});
test("custom 消息按原序入 plan（不再被收进过程组）", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), custom(), assistant([text("answer")])];

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(plan.map((item) => item.messageIndex), [0, 1, 2]);
});
test("所有磁盘项统一 keyPrefix=message 且可挂 ref", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([
    { type: "thinking", thinking: "work" },
    tool(),
  ]), assistant([text("answer")])];

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(plan.map((item) => item.keyPrefix), ["message", "message", "message"]);
  assert.deepEqual(plan.map((item) => item.attachRef), [true, true, true]);
});
test("user、answer、toolResult、user 的尾随索引保持原序", async () => {
  const { composeChatPlan } = await load();
  const messages = [user("first"), assistant([text("answer")]), toolResult(), user("second")];

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(plan.map((item) => item.messageIndex), [0, 1, 2, 3]);
});

test("相邻 assistant 只显示最后一个 timestamp", async () => {
  const { composeChatPlan } = await load();
  const messages = [assistant([text("a")]), assistant([text("b")]), user(), assistant([text("c")])];

  const plan = compose(composeChatPlan, messages);

  assert.equal(plan[0].showTimestamp, false);
  assert.equal(plan[1].showTimestamp, true);
  assert.equal(plan[3].showTimestamp, true);
});

test("不变异输入：磁盘项直接引用原消息，不复制、不改写", async () => {
  const { composeChatPlan } = await load();
  const usage = { input: 2 };
  const messages = [user(), assistant([tool(), text("a")], { usage })];
  const before = structuredClone(messages);

  const plan = compose(composeChatPlan, messages);

  assert.deepEqual(messages, before);
  assert.equal(plan[1].messageOverride, undefined);
  assert.equal(plan[1].messageIndex, 1);
});
// ---------- P3b：live streaming slot 进入统一渲染计划 ----------

const liveMessage = () => ({ role: "assistant", content: [text("streaming")] });

test("无 live slot 时结果与现有完全一致（回归）", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([{ type: "thinking", thinking: "x" }, tool(), text("answer")])];

  const without = compose(composeChatPlan, messages);
  const withUndefined = compose(composeChatPlan, messages, { liveSlot: undefined });
  const withInactive = compose(composeChatPlan, messages, { liveSlot: { message: liveMessage(), isActive: false } });
  const withNullMessage = compose(composeChatPlan, messages, { liveSlot: { message: null, isActive: true } });

  assert.deepEqual(withUndefined, without);
  assert.deepEqual(withInactive, without);
  assert.deepEqual(withNullMessage, without);
});

test("live assistant 作为末位 message item 进入同一 render plan", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([text("a")])];
  const live = liveMessage();

  const plan = compose(composeChatPlan, messages, { liveSlot: { message: live, isActive: true } });

  assert.equal(plan.length, 3);
  const tail = plan[2];
  assert.equal(tail.kind, "message");
  assert.equal(tail.source, "live");
  assert.equal(tail.messageIndex, null);
  assert.equal(tail.attachRef, false);
  assert.equal(tail.showTimestamp, false);
  assert.equal(tail.messageOverride, live);
  // 磁盘项仍携带真实索引且 source=disk
  assert.deepEqual(plan.slice(0, 2).map((item) => [item.kind === "message" ? item.source : null, item.messageIndex]), [["disk", 0], ["disk", 1]]);
});

test("live slot 不重复出现在 plan 尾部", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([text("a")])];
  const live = liveMessage();

  const plan = compose(composeChatPlan, messages, { liveSlot: { message: live, isActive: true } });

  const liveItems = plan.filter((item) => item.kind === "message" && item.source === "live");
  assert.equal(liveItems.length, 1);
  assert.equal(plan[plan.length - 1], liveItems[0]);
});

test("live 与磁盘项同序：磁盘原序 + live 末位", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([{ type: "thinking", thinking: "x" }, tool(), text("answer")])];

  const plan = compose(composeChatPlan, messages, { liveSlot: { message: liveMessage(), isActive: true } });

  assert.deepEqual(plan.map((item) => item.source), ["disk", "disk", "live"]);
  assert.equal(plan[plan.length - 1].source, "live");
});
test("isStreaming 尾消息 timestamp 语义保持（live 不重复推导）", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([text("live")])];

  const plan = compose(composeChatPlan, messages, {
    isStreaming: true,
    liveSlot: { message: liveMessage(), isActive: true },
  });

  // 磁盘尾消息仍按现有语义隐藏 timestamp；live item 自身同样隐藏
  assert.equal(plan[1].showTimestamp, false);
  assert.equal(plan[2].showTimestamp, false);
});

test("live slot 在 isActive=false 或 message=null 时不产生 item", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([text("a")])];

  for (const liveSlot of [
    undefined,
    { message: null, isActive: true },
    { message: liveMessage(), isActive: false },
    { message: null, isActive: false },
  ]) {
    const plan = compose(composeChatPlan, messages, { liveSlot });
    assert.deepEqual(plan.map((item) => item.kind === "message" ? item.messageIndex : null), [0, 1]);
    assert.equal(plan.some((item) => item.kind === "message" && item.source === "live"), false);
  }
});

test("getChatPlanLiveMessage 从统一计划提取 live 投影", async () => {
  const { composeChatPlan, getChatPlanLiveMessage } = await load();
  const messages = [user(), assistant([text("a")])];
  const live = liveMessage();

  const withLive = compose(composeChatPlan, messages, { liveSlot: { message: live, isActive: true } });
  const withoutLive = compose(composeChatPlan, messages);
  const inactive = compose(composeChatPlan, messages, { liveSlot: { message: live, isActive: false } });

  assert.equal(getChatPlanLiveMessage(withLive), live);
  assert.equal(getChatPlanLiveMessage(withoutLive), null);
  assert.equal(getChatPlanLiveMessage(inactive), null);
});

test("空 content 的上游 error/aborted assistant 仍进入渲染计划", async () => {
  const { composeChatPlan } = await load();
  const errorAssistant = {
    role: "assistant",
    content: [],
    model: "m",
    provider: "p",
    stopReason: "error",
    errorMessage: "upstream 429 rate limit",
  };
  const aborted = {
    role: "assistant",
    content: [],
    model: "m",
    provider: "p",
    stopReason: "aborted",
  };
  const planError = compose(composeChatPlan, [user(), errorAssistant]);
  const planAbort = compose(composeChatPlan, [user(), aborted]);
  const indexes = (plan) => plan.map((item) => item.messageIndex);
  assert.ok(indexes(planError).includes(1), "error assistant 应可见");
  assert.ok(indexes(planAbort).includes(1), "aborted assistant 应可见");
});

test("引导乐观 user 后置到 live 之后（disk0 → live → disk1）", async () => {
  const { composeChatPlan, getChatPlanLiveMessage } = await load();
  const steerUser = { ...user("steer"), _duringStreamingStep: true };
  const messages = [user("q"), steerUser];
  const liveSlot = { message: assistant([text("thinking")]), isActive: true };
  const plan = compose(composeChatPlan, messages, {
    isStreaming: true,
    agentOrBashRunning: true,
    liveSlot,
  });
  assert.deepEqual(
    plan.map((item) => item.kind === "message"
      ? (item.source === "live" ? "live" : item.messageIndex)
      : null),
    [0, "live", 1],
  );
  assert.ok(getChatPlanLiveMessage(plan));
});

test("新回合 prompt user 不后置到 live 之后", async () => {
  const { composeChatPlan } = await load();
  const messages = [user(), assistant([text("answer")]), user("next")];
  const liveSlot = { message: assistant([text("streaming")]), isActive: true };
  const plan = compose(composeChatPlan, messages, {
    isStreaming: true,
    agentOrBashRunning: true,
    liveSlot,
  });
  const order = plan.map((item) => item.kind === "message"
    ? (item.source === "live" ? "live" : item.messageIndex)
    : null);
  // 最后的 user("next") 是新回合 prompt：必须保持在 live 之前
  const userIdx = order.indexOf(2);
  assert.ok(userIdx >= 0);
  assert.equal(order.at(-1), "live");
  assert.ok(order.indexOf("live") > userIdx, "live 在新回合 user 之后");
  assert.ok(!order.slice(userIdx + 1).some((entry, i, rest) => typeof entry === "number" && entry > userIdx && rest.indexOf("live") < rest.indexOf(entry)), "新回合 user 不得被后置到 live 之后");
});

test("无 trailing user 时 live 仍在末尾；live 后有 user 时仍能提取 live", async () => {
  const { composeChatPlan, getChatPlanLiveMessage } = await load();
  // 无 trailing：live 在末尾
  const plainPlan = compose(composeChatPlan, [user(), assistant([text("a")])], {
    isStreaming: true,
    agentOrBashRunning: true,
    liveSlot: { message: assistant([text("live")]), isActive: true },
  });
  assert.equal(plainPlan.at(-1)?.source, "live");
  assert.ok(getChatPlanLiveMessage(plainPlan));

  // trailing steer user 在 live 后：getChatPlanLiveMessage 仍能取到 live
  const steerPlan = compose(composeChatPlan, [user("q"), { ...user("steer"), _duringStreamingStep: true }], {
    isStreaming: true,
    agentOrBashRunning: true,
    liveSlot: { message: assistant([text("live")]), isActive: true },
  });
  assert.equal(steerPlan.at(-1)?.messageIndex, 1, "末项是后置的 steer user");
  const live = getChatPlanLiveMessage(steerPlan);
  assert.ok(live);
  assert.deepEqual(live.content, [text("live")]);
});
