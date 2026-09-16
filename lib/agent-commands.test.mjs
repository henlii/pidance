import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseTypedMessageCommand,
  parsePromptCommand,
  classifyPromptRejection,
  isQueueablePromptReason,
} = await jiti.import("./agent-commands.ts");

test("prompt 解析 submissionId；缺省时生成", () => {
  const parsed = parsePromptCommand({ type: "prompt", message: "hi", submissionId: "s1" });
  assert.equal(parsed.submissionId, "s1");
  const generated = parsePromptCommand({ type: "prompt", message: "hi" }, () => "gen-1");
  assert.equal(generated.submissionId, "gen-1");
});

test("prompt/abort/steer/follow_up 为可辨识联合；非法 type 抛错", () => {
  assert.equal(parseTypedMessageCommand({ type: "abort" }).type, "abort");
  assert.equal(parseTypedMessageCommand({ type: "steer", message: "go" }).type, "steer");
  assert.equal(parseTypedMessageCommand({ type: "follow_up", message: "next" }).type, "follow_up");
  assert.throws(() => parseTypedMessageCommand({ type: "nope" }), /Unsupported message command/);
  assert.throws(() => parseTypedMessageCommand({ type: "prompt" }), /message is required/);
});
test("#42 拒绝归类：busy/无模型/鉴权可区分，不认识的归 error（不据此自动重发）", () => {
  // 只有可延迟的原因才允许转入队列；把无模型/鉴权错误当 busy 会静默排队。
  assert.equal(classifyPromptRejection(new Error("Agent is already processing. Specify streamingBehavior")), "busy");
  assert.equal(classifyPromptRejection(new Error("Cannot send a message while a shell command is running")), "bash");
  assert.equal(classifyPromptRejection(new Error("manual compaction is in progress")), "compacting");
  assert.equal(classifyPromptRejection(new Error("Extension command /foo cannot be queued")), "extension");
  assert.equal(classifyPromptRejection(new Error("No model selected")), "model");
  assert.equal(classifyPromptRejection(new Error("401 Unauthorized: invalid api key")), "auth");
  assert.equal(classifyPromptRejection(new Error("running lease held by another process")), "locked");
  assert.equal(classifyPromptRejection(new Error("ECONNRESET")), "error");
  assert.equal(classifyPromptRejection("something odd"), "error");
  assert.equal(isQueueablePromptReason("busy"), true);
  assert.equal(isQueueablePromptReason("bash"), true);
  assert.equal(isQueueablePromptReason("compacting"), true);
  assert.equal(isQueueablePromptReason("model"), false);
  assert.equal(isQueueablePromptReason("error"), false);
});

test("#42 set_follow_up_queue 拒绝非法条目：不得把「发错格式」静默变成清空队列", () => {
  assert.throws(
    () => parseTypedMessageCommand({ type: "set_follow_up_queue", items: [{ text: "x", images: "nope" }] }),
    /invalid queue image/,
  );
  assert.throws(
    () => parseTypedMessageCommand({ type: "set_follow_up_queue", items: [{ foo: 1 }] }),
    /text/,
  );
  assert.throws(
    () => parseTypedMessageCommand({ type: "set_follow_up_queue", items: [42] }),
    /strings or/,
  );
  assert.throws(
    () => parseTypedMessageCommand({ type: "set_follow_up_queue", items: ["ok", "  "] }),
    /empty text/,
  );
  assert.throws(
    () => parseTypedMessageCommand({ type: "set_follow_up_queue", items: "not-an-array" }),
    /must be an array/,
  );
  // 合法形状照旧：空数组是「清队」的正当表达，不能连它一起拒掉。
  assert.deepEqual(
    parseTypedMessageCommand({ type: "set_follow_up_queue", items: [] }).items,
    [],
  );
  assert.deepEqual(
    parseTypedMessageCommand({ type: "set_follow_up_queue", items: ["a"] }).items,
    [{ text: "a" }],
  );
  // 载荷形式（带图）与纯文本等价解析：图片引用与 base64 都要能过。
  assert.deepEqual(
    parseTypedMessageCommand({
      type: "set_follow_up_queue",
      items: [{ text: "看图", images: [{ source: "data", data: "AAAA", mimeType: "image/png" }] }],
    }).items,
    [{ text: "看图", images: [{ source: "data", data: "AAAA", mimeType: "image/png" }] }],
  );
  assert.throws(
    () => parseTypedMessageCommand({
      type: "set_follow_up_queue",
      items: [{ text: "看图", images: [{ source: "data", data: "AAAA" }] }],
    }),
    /invalid queue image/,
  );
});
