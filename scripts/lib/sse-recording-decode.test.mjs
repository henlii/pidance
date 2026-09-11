/**
 * SSE recording 解码单测（#26）：证明回放重建无损 —— 每条录制 update 都还原成
 * 协议语义的完整快照，且累计文本与录制增量一致（此前会丢掉 text 块的首批 delta）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { clampSchedule, decodeRecording } from "./sse-recording-decode.mjs";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "sse-run-recording.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

test("解码：update 数量与录制一致，不丢帧", () => {
  const decoded = decodeRecording(fixture);
  const recordedUpdates = fixture.events.filter((item) => item.type === "message_update");
  assert.equal(decoded.updateCount, recordedUpdates.length);
  assert.equal(
    decoded.events.filter((item) => item.event.type === "message_update").length,
    recordedUpdates.length,
    "解码后必须逐条保留 message_update",
  );
});

test("解码：每条快照的累计文本等于录制增量累计（含 thinking 与 text）", () => {
  const decoded = decodeRecording(fixture);
  const updates = decoded.events.filter((item) => item.event.type === "message_update");

  // 独立累计：按录制顺序把 delta 加到对应块上，得到每条 update 的期望快照文本。
  let expectedThinking = "";
  let expectedText = "";
  let expectedStarted = false;
  let updateIndex = 0;
  for (const item of fixture.events) {
    if (item.type === "message_start") {
      const startText = (item.message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("");
      const startThinking = (item.message.content ?? [])
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking ?? "")
        .join("");
      expectedText = startText;
      expectedThinking = startThinking;
      expectedStarted = true;
      continue;
    }
    if (item.type !== "message_update" || !expectedStarted) continue;
    expectedThinking += item.delta?.thinking ?? "";
    expectedText += item.delta?.text ?? "";
    const snapshot = updates[updateIndex]?.event.message;
    assert.ok(snapshot, `缺少第 ${updateIndex} 条解码快照`);
    const snapshotThinking = (snapshot.content ?? [])
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking ?? "")
      .join("");
    const snapshotText = (snapshot.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    assert.equal(snapshotThinking, expectedThinking, `第 ${updateIndex} 条 thinking 快照不一致`);
    assert.equal(snapshotText, expectedText, `第 ${updateIndex} 条 text 快照不一致`);
    updateIndex += 1;
  }
  assert.equal(updateIndex, updates.length, "录制与解码的 update 数不一致");
});

test("解码：text 块在首次出现时被创建（旧实现会丢帧）", () => {
  const decoded = decodeRecording(fixture);
  const updates = decoded.events.filter((item) => item.event.type === "message_update");
  // 第一条带 text 增量的 update，其快照必须已经包含 text 块内容。
  const firstTextDelta = fixture.events.find((item) => item.type === "message_update" && item.delta?.text);
  assert.ok(firstTextDelta, "fixture 应包含 text delta");
  const withText = updates.find((item) =>
    (item.event.message.content ?? []).some((block) => block.type === "text" && (block.text ?? "").length > 0),
  );
  assert.ok(withText, "解码后必须存在带正文的 text 块");
  const firstSnapshotText = (withText.event.message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  assert.equal(firstSnapshotText, firstTextDelta.delta.text, "首个 text 快照应等于首个 text 增量");
});

test("解码：message_end 顺序与 assistant 正文可用于断言流式可见", () => {
  const decoded = decodeRecording(fixture);
  assert.ok(decoded.assistantTexts.length >= 1, "fixture 应至少有一条 assistant 正文");
  const assistantEnds = decoded.messageEnds.filter((item) => item.role === "assistant");
  assert.equal(assistantEnds.length, decoded.assistantTexts.length);
  // 最后一个 assistant 的正文与 message_end 时间可用于「先可见、后收尾」断言。
  assert.equal(assistantEnds.at(-1).text, decoded.assistantTexts.at(-1));
  assert.ok(assistantEnds.at(-1).atMs > 0);
});

test("时间表压缩：单调不减且间隔不超过上限", () => {
  const decoded = decodeRecording(fixture);
  const clamped = clampSchedule(decoded.events, 250);
  let previous = 0;
  for (const item of clamped) {
    assert.ok(item.atMs >= previous, "时间必须单调不减");
    assert.ok(item.atMs - previous <= 250, "压缩后间隔不得超过上限");
    previous = item.atMs;
  }
  assert.equal(clamped.length, decoded.events.length);
});
