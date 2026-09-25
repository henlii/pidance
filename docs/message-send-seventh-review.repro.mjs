// Seventh-review probes for 35f3e32. J1 characterization should now fail (fixed).
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  adoptServerSnapshot, payloadsForWrite, proposeQueueWrite, queueEntry, latestPending,
} = await jiti.import("../lib/queue-state.ts");

const item = (id, text) => ({ id, text, state: "waiting" });

test("K1: rebase drops a second identical text as if it were already in the authority queue", () => {
  const base = adoptServerSnapshot({}, "A", { items: [item("keep", "hello")], revision: 1 });
  const proposed = proposeQueueWrite(base, "A", {
    payloads: [{ id: "keep", text: "hello" }, { text: "hello", attemptId: "try-dup" }],
    candidates: [{ text: "hello", attemptId: "try-dup" }],
  });
  const after = adoptServerSnapshot(proposed.book, "A", {
    items: [item("keep", "hello"), item("other", "other-tab")],
    revision: 2,
  });
  const texts = payloadsForWrite(queueEntry(after, "A")).map((payload) => payload.text);
  const candidates = latestPending(queueEntry(after, "A")).candidates.map((payload) => payload.text);
  assert.deepEqual(candidates, ["hello"], "candidate survives");
  assert.deepEqual(texts, ["hello", "other-tab"], "second hello stripped from the payload that will be sent");
});
