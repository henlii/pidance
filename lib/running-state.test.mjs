import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  recordRunningStartedAt,
  clearRunningStartedAt,
  getRunningStartedAt,
} = await jiti.import("./running-state.ts");

test("recordRunningStartedAt：本轮首次写入胜，clear 后可重新记", () => {
  const id = `sticky-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    recordRunningStartedAt(id, 1000);
    recordRunningStartedAt(id, 2000);
    assert.equal(getRunningStartedAt().get(id), 1000);
    clearRunningStartedAt(id);
    recordRunningStartedAt(id, 3000);
    assert.equal(getRunningStartedAt().get(id), 3000);
  } finally {
    clearRunningStartedAt(id);
  }
});
