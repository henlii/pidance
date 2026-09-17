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
    () => parseTypedMessageCommand({ type: "set_follow_up_queue", items: [{ text: "x", media: "nope" }] }),
    /invalid queue media/,
  );
  // 模型副本必须是图片：其他类型会被当作内联图片交给 SDK，只能是误传。
  assert.throws(
    () => parseTypedMessageCommand({
      type: "set_follow_up_queue",
      items: [{ text: "x", media: [{ role: "model", path: "p", name: "n", mimeType: "text/plain", size: 1 }] }],
    }),
    /invalid queue media/,
  );
  // 引用字段不全（缺 mimeType）同样拒绝：宁可报错，不得静默少发一张图。
  assert.throws(
    () => parseTypedMessageCommand({
      type: "set_follow_up_queue",
      items: [{ text: "看图", media: [{ role: "model", path: "p", name: "n", size: 1 }] }],
    }),
    /invalid queue media/,
  );
  assert.throws(
    () => parseTypedMessageCommand({ type: "set_follow_up_queue", items: [{ foo: 1 }] }),
    /strings or/,
  );
  assert.throws(
    () => parseTypedMessageCommand({ type: "set_follow_up_queue", items: [42] }),
    /strings or/,
  );
  assert.throws(
    () => parseTypedMessageCommand({ type: "set_follow_up_queue", items: ["ok", "  "] }),
    /empty text/,
  );
  // 空正文且无媒体 = 空条目，拒绝（否则它会占一个永远发不出去的坑）。
  assert.throws(
    () => parseTypedMessageCommand({ type: "set_follow_up_queue", items: [{ text: "   " }] }),
    /must not be empty/,
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
  // 载荷形式（带图引用）：解析结果与客户端发出的引用逐字段一致（引用不得被改写，
  // 否则宿主读不到文件、只能丢图或阻塞整批投递）。
  const media = {
    role: "model",
    path: "/home/u/.pi/agent/pidance-attachments/s1/x.model.webp",
    name: "x.png",
    mimeType: "image/webp",
    size: 12,
    previewPath: "/home/u/.pi/agent/pidance-attachments/s1/x.png",
  };
  assert.deepEqual(
    parseTypedMessageCommand({
      type: "set_follow_up_queue",
      items: [{ text: "看图", media: [media] }],
    }).items,
    [{ text: "看图", media: [media] }],
  );
  // 只发图（正文为空）是合法的：UI 允许只发图。
  assert.deepEqual(
    parseTypedMessageCommand({
      type: "set_follow_up_queue",
      items: [{ text: "", media: [media] }],
    }).items,
    [{ text: "", media: [media] }],
  );
});
