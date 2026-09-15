/**
 * Issue #33：异步投影的归属判定。
 *
 * 背景：为 A 发起的 reconcile 在用户切到 B 之后返回时，A 的压缩态/吞吐读数
 * 会被写进 B 的界面（`seedTurnMetricsFromState` 读「当前会话」、`setIsCompacting`
 * 无守卫）。这里固定归属规则，hook 只做接线。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { canApplyProjection } from "./session-projection.ts";

test("#33 目标会话与当前会话不同：拒绝投影", () => {
  assert.equal(
    canApplyProjection({ sessionId: "A" }, { sessionId: "B" }),
    false,
    "A 的响应不得写进 B 的界面",
  );
});

test("#33 同一会话：允许投影（这是正常路径）", () => {
  assert.equal(canApplyProjection({ sessionId: "A" }, { sessionId: "A" }), true);
});

test("#33 目标或当前会话缺失：拒绝（不做「迁移到当前会话」）", () => {
  assert.equal(canApplyProjection({ sessionId: null }, { sessionId: "A" }), false);
  assert.equal(canApplyProjection({ sessionId: "A" }, { sessionId: null }), false);
  assert.equal(canApplyProjection({ sessionId: undefined }, { sessionId: undefined }), false);
  assert.equal(canApplyProjection({ sessionId: "" }, { sessionId: "" }), false);
});

test("#33 代次不一致：拒绝（请求期间已有更新的本地读数）", () => {
  assert.equal(
    canApplyProjection(
      { sessionId: "A", generation: 1 },
      { sessionId: "A", generation: 2 },
    ),
    false,
    "迟到响应不得覆盖更新的读数",
  );
});

test("#33 代次未提供：不因代次拒绝（保持兼容语义）", () => {
  assert.equal(canApplyProjection({ sessionId: "A" }, { sessionId: "A", generation: 2 }), true);
  assert.equal(canApplyProjection({ sessionId: "A", generation: 1 }, { sessionId: "A" }), true);
});

test("#33 会话不同时代次相同也不得放行", () => {
  assert.equal(
    canApplyProjection(
      { sessionId: "A", generation: 5 },
      { sessionId: "B", generation: 5 },
    ),
    false,
  );
});
