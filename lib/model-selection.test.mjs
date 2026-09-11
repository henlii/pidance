/**
 * P1-2 模型手动覆盖保留：优先级判定、override 吸附、fork 模型继承（纯函数）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDisplayModel,
  settleModelOverride,
  shouldInheritModel,
  sameModel,
} from "./model-selection.ts";

const A = { provider: "zenmux", modelId: "claude-a" };
const C = { provider: "zenmux", modelId: "claude-c" };
const B = { provider: "zenmux", modelId: "claude-b" };

test("sameModel：一致/空值相等/不一致", () => {
  assert.equal(sameModel(A, A), true);
  assert.equal(sameModel(A, B), false);
  assert.equal(sameModel(null, null), true);
  assert.equal(sameModel(undefined, null), true);
  assert.equal(sameModel(A, null), false);
});

test("resolveDisplayModel：override 最高优先", () => {
  // 用户手动选择 > 磁盘持久化 model_change > 默认
  assert.deepEqual(resolveDisplayModel(A, B, null), A);
  assert.deepEqual(resolveDisplayModel(A, B, B), A);
});

test("resolveDisplayModel：persisted（磁盘 model_change）优先于 fallback", () => {
  assert.deepEqual(resolveDisplayModel(null, A, B), A);
});

test("resolveDisplayModel：fallback 兜底，全空返回 null", () => {
  assert.deepEqual(resolveDisplayModel(null, null, B), B);
  assert.equal(resolveDisplayModel(null, null, null), null);
});

test("settleModelOverride：无 override 保持 null", () => {
  assert.equal(settleModelOverride({ override: null, persisted: A }), null);
  assert.equal(settleModelOverride({ override: undefined, persisted: A }), null);
});

test("settleModelOverride：override 与磁盘一致时吸附清除（磁盘权威接管）", () => {
  assert.equal(settleModelOverride({ override: A, persisted: A }), null);
});

test("settleModelOverride：磁盘缺失（fork 后新会话无 model_change）时保留 override", () => {
  assert.deepEqual(settleModelOverride({ override: A, persisted: null }), A);
});

test("settleModelOverride：写盘竞态（磁盘仍是旧值）时保留 override", () => {
  // 磁盘未动过（lastKnown == persisted == B），说明是我们的写还没落盘，
  // 用户选择优先。
  assert.deepEqual(
    settleModelOverride({ override: A, persisted: B, lastDiskObserved: B }),
    A,
  );
});

test("settleModelOverride：外部改动磁盘（另一实例/标签页）时让位磁盘", () => {
  // 本页选 A，磁盘原为 B；再看磁盘已变成 C —— 这是外部写入。
  // 保留 override 会让本页既显示 A，又在下次发送把 A 写回去。
  assert.equal(
    settleModelOverride({ override: A, persisted: C, lastDiskObserved: B }),
    null,
  );
});

test("settleModelOverride：无观察基线时不做外部改动判定", () => {
  assert.deepEqual(
    settleModelOverride({ override: A, persisted: B, lastDiskObserved: null }),
    A,
  );
  assert.deepEqual(settleModelOverride({ override: A, persisted: B }), A);
});

test("shouldInheritModel：新文件无 model_change 且有源模型 → 继承", () => {
  assert.equal(shouldInheritModel(false, A), true);
});

test("shouldInheritModel：新文件已有 model_change → 不继承", () => {
  assert.equal(shouldInheritModel(true, A), false);
  assert.equal(shouldInheritModel(true, null), false);
});

test("shouldInheritModel：源会话无模型 → 无从继承", () => {
  assert.equal(shouldInheritModel(false, null), false);
  assert.equal(shouldInheritModel(false, undefined), false);
});
