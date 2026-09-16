import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildSubagentActivity, SUBAGENT_ACTIVE_RUN_STATES } = await jiti.import("./subagent-activity.ts");

function run(overrides = {}) {
  return {
    id: "run-1",
    state: "running",
    mode: "single",
    startedAt: 1,
    steps: [],
    recentEvents: [],
    ...overrides,
  };
}

function step(overrides = {}) {
  return { index: 0, agent: "scout", status: "running", ...overrides };
}

test("活跃状态集合覆盖 running/queued/paused", () => {
  assert.deepEqual([...SUBAGENT_ACTIVE_RUN_STATES].sort(), ["paused", "queued", "running"]);
});

test("buildSubagentActivity: 进行中 run 的子会话进 running，已结束的只进索引", () => {
  const activity = buildSubagentActivity([
    run({ id: "r1", state: "running", mode: "chain", steps: [step({ sessionId: "s1" }), step({ sessionId: "s2", index: 1 })] }),
    run({ id: "r2", state: "complete", mode: "single", steps: [step({ sessionId: "s3", label: "reviewer" })] }),
    run({ id: "r3", state: "failed", steps: [step({ sessionId: "s4" })] }),
  ]);
  assert.deepEqual([...activity.runningChildIds].sort(), ["s1", "s2"]);
  assert.equal(activity.bySessionId.size, 4);
  assert.equal(activity.bySessionId.get("s2").mode, "chain");
  assert.equal(activity.bySessionId.get("s3").step.label, "reviewer");
  assert.equal(activity.bySessionId.get("s3").active, false);
  assert.equal(activity.bySessionId.get("s1").active, true);
  // failed 不算活跃
  assert.equal(activity.runningChildIds.has("s4"), false);
});

test("buildSubagentActivity: queued/paused 视为活跃，stopped 不算", () => {
  const activity = buildSubagentActivity([
    run({ id: "r1", state: "queued", steps: [step({ sessionId: "s1" })] }),
    run({ id: "r2", state: "paused", steps: [step({ sessionId: "s2" })] }),
    run({ id: "r3", state: "stopped", steps: [step({ sessionId: "s3" })] }),
  ]);
  assert.deepEqual([...activity.runningChildIds].sort(), ["s1", "s2"]);
});

test("buildSubagentActivity: 无 sessionId 的 step 跳过；同一会话取列表最前一条", () => {
  const activity = buildSubagentActivity([
    run({ id: "newest", mode: "parallel", steps: [step({ sessionId: "s1", label: "新" }), step({ sessionId: undefined })] }),
    run({ id: "older", mode: "single", steps: [step({ sessionId: "s1", label: "旧" })] }),
  ]);
  assert.equal(activity.bySessionId.size, 1);
  assert.equal(activity.bySessionId.get("s1").runId, "newest");
  assert.equal(activity.bySessionId.get("s1").step.label, "新");
});

test("buildSubagentActivity: 缺失/异常输入退化为空索引", () => {
  for (const input of [undefined, null, [], [null], [{ id: "x", state: "running" }]]) {
    const activity = buildSubagentActivity(input);
    assert.equal(activity.runningChildIds.size, 0);
    assert.equal(activity.bySessionId.size, 0);
  }
});
