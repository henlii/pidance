import assert from "node:assert/strict";
import test from "node:test";

import {
  ASYNC_STATUS_SNAPSHOT_PREFIX,
  parseSubagentAsyncSnapshot,
  rewriteFleetStatusLines,
  summarizeSubagentAsyncSnapshot,
} from "./subagent-async-widget.ts";

const PREFIX = ASYNC_STATUS_SNAPSHOT_PREFIX;

/** 真实快照（取自 31415 宿主状态里 pi-subagents 发的 widget 行，字段保持不变）。 */
function liveSnapshot(overrides = {}) {
  return {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 1789898133467,
    caps: { maxRuns: 8, maxChildrenPerNode: 12, maxDepth: 3, maxStringLength: 200, maxSerializedBytes: 12000 },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [
      {
        id: "d101df0d-a862-45c9-9d14-20501c2f34cd",
        kind: "subagent",
        label: "worker",
        state: "running",
        startedAt: 1789898122826,
        updatedAt: 1789898133467,
        activity: { currentTool: "bash", lastActivityAt: 1789898133467, currentToolStartedAt: 1789898133457, turnCount: 1, toolCount: 1 },
        children: [
          {
            id: "step:0",
            kind: "step",
            label: "worker",
            state: "running",
            startedAt: 1789898122833,
            updatedAt: 1789898133467,
            activity: { currentTool: "bash", lastActivityAt: 1789898133467, currentToolStartedAt: 1789898133457, turnCount: 1, toolCount: 1 },
          },
        ],
      },
    ],
    ...overrides,
  };
}

const line = (snapshot) => `${PREFIX}${JSON.stringify(snapshot)}`;

test("解析 pi-subagents 快照：真实载荷 + 非前缀行混排", () => {
  const snapshot = parseSubagentAsyncSnapshot(["some other widget line", line(liveSnapshot())]);
  assert.ok(snapshot);
  assert.equal(snapshot.kind, "pi-subagents.async-status-snapshot");
  assert.equal(snapshot.runs.length, 1);
  assert.equal(snapshot.runs[0].label, "worker");
  assert.equal(snapshot.runs[0].state, "running");
  assert.equal(snapshot.runs[0].activity.currentTool, "bash");
  assert.equal(snapshot.runs[0].children[0].id, "step:0");
  assert.equal(snapshot.omittedRuns, 0);
  assert.equal(snapshot.byteLimitExceeded, false);
});

test("解析失败一律返回 null（调用方不得显示原始载荷）", () => {
  assert.equal(parseSubagentAsyncSnapshot(null), null);
  assert.equal(parseSubagentAsyncSnapshot([]), null);
  assert.equal(parseSubagentAsyncSnapshot(["普通扩展文本"]), null);
  // 前缀对但 JSON 坏
  assert.equal(parseSubagentAsyncSnapshot([`${PREFIX}{not json`]), null);
  // kind 不对（不是 pi-subagents 的载荷）
  assert.equal(parseSubagentAsyncSnapshot([line(liveSnapshot({ kind: "other.snapshot" }))]), null);
  // 缺 runs
  assert.equal(parseSubagentAsyncSnapshot([line({ kind: "pi-subagents.async-status-snapshot", version: 1 })]), null);
  // runs 里的脏节点被跳过而不是整体失败
  const partial = parseSubagentAsyncSnapshot([line(liveSnapshot({ runs: [{ id: "x", label: "y", state: "bogus" }, liveSnapshot().runs[0]] }))]);
  assert.ok(partial);
  assert.deepEqual(partial.runs.map((run) => run.label), ["worker"]);
});

test("汇总：运行中优先、带时长/工具/计数，子步骤缩进", () => {
  const snapshot = parseSubagentAsyncSnapshot([line(liveSnapshot())]);
  const summary = summarizeSubagentAsyncSnapshot(snapshot, { now: 1789898134467 });
  assert.equal(summary.running, 1);
  assert.equal(summary.queued, 0);
  assert.equal(summary.total, 1);
  assert.equal(summary.hidden, 0);
  assert.deepEqual(summary.rows.map((row) => [row.label, row.state, row.depth]), [
    ["worker", "running", 0],
    ["worker", "running", 1],
  ]);
  // 时长按 updatedAt - startedAt；工具时长按 lastActivityAt - currentToolStartedAt
  assert.equal(summary.rows[0].elapsedMs, 1789898133467 - 1789898122826);
  assert.equal(summary.rows[0].tool, "bash");
  assert.equal(summary.rows[0].toolMs, 10);
  assert.equal(summary.rows[0].turns, 1);
  assert.equal(summary.rows[0].tools, 1);
});

test("汇总：结束的 run 显示 endedAt 时长且没有工具行；排队优先于结束", () => {
  const snapshot = parseSubagentAsyncSnapshot([line(liveSnapshot({
    runs: [
      { id: "done", kind: "subagent", label: "reviewer", state: "complete", startedAt: 1000, endedAt: 6000 },
      { id: "q", kind: "subagent", label: "worker", state: "queued", startedAt: 2000, updatedAt: 2000 },
      { id: "run", kind: "subagent", label: "oracle", state: "running", startedAt: 3000, updatedAt: 5000, activity: { currentTool: "grep" } },
    ],
  }))]);
  const summary = summarizeSubagentAsyncSnapshot(snapshot, { now: 9000 });
  assert.deepEqual(summary.rows.map((row) => row.label), ["oracle", "worker", "reviewer"]);
  assert.equal(summary.rows[2].elapsedMs, 5000);
  assert.equal(summary.rows[2].tool, null);
  assert.equal(summary.running, 1);
  assert.equal(summary.queued, 1);
});

test("汇总：超过上限的 run 计入 hidden（含上游截断）", () => {
  const runs = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, kind: "subagent", label: `worker-${i}`, state: "running", startedAt: 1000, updatedAt: 2000 }));
  const snapshot = parseSubagentAsyncSnapshot([line(liveSnapshot({ runs, omitted: { runs: 3, children: 0, byteLimitExceeded: true } }))]);
  const summary = summarizeSubagentAsyncSnapshot(snapshot, { now: 3000, maxRows: 2 });
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.hidden, 3 + 3);
  assert.equal(summary.total, 8);
  assert.equal(summary.byteLimitExceeded, true);
});

test("#60a fleet-status：去掉终端键位提示，保留 agent 数与 token 读数", () => {
  // 真实行（含 ANSI 颜色）：`1 active agent · ↓ 0 tokens · ↓/← to inspect`
  const raw = "  \u001b[38;2;128;128;128m1 active agent\u001b[39m · \u001b[38;2;102;102;102m↓ 0 tokens · ↓/← to inspect\u001b[39m";
  const rewritten = rewriteFleetStatusLines([raw]);
  assert.deepEqual(rewritten, ["1 active agent · ↓ 0 tokens"], "键位提示段被去掉，信息保留");
  assert.equal(rewritten[0].includes("inspect"), false);
  assert.equal(rewritten[0].includes("\u001b"), false, "输出不含 ANSI");

  // 只写了键位提示 → 改写为空数组（调用方不渲染这个 widget）
  assert.deepEqual(rewriteFleetStatusLines(["↓/← to inspect"]), []);

  // 其它形状（不带键位提示）→ null，调用方原样渲染
  assert.equal(rewriteFleetStatusLines(["普通扩展文本"]), null);
  assert.equal(rewriteFleetStatusLines([]), null);
  assert.equal(rewriteFleetStatusLines(null), null);
  // 多行：逐行改写，空白行丢弃
  assert.deepEqual(rewriteFleetStatusLines(["1 active agent · ↓ 3 tokens · ↓/← to inspect", "   "]), ["1 active agent · ↓ 3 tokens"]);
});
