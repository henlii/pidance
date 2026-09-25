import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  adoptServerSnapshot, payloadsForWrite, proposeQueueWrite, queueEntry,
} = await jiti.import("../lib/queue-state.ts");

const item = (id, text) => ({ id, text, state: "waiting" });

test("K2: get_state-shaped snapshot without admittedAttemptIds re-lists an already-landed attempt", () => {
  const base = adoptServerSnapshot({}, "A", { items: [], revision: 0 });
  const proposed = proposeQueueWrite(base, "A", {
    payloads: [{ text: "hello", attemptId: "try-a" }],
    candidates: [{ text: "hello", attemptId: "try-a" }],
  });
  // get_state / applyProjectedQueues 目前只带 items+revision，不带令牌。
  const after = adoptServerSnapshot(proposed.book, "A", {
    items: [item("i1", "hello")],
    revision: 1,
  });
  assert.deepEqual(
    payloadsForWrite(queueEntry(after, "A")).map((payload) => payload.text),
    ["hello", "hello"],
  );
});
