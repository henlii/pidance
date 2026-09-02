import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseTypedMessageCommand,
  parsePromptCommand,
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
