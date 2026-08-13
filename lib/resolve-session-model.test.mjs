import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolveSessionModel } = await jiti.import("./resolve-session-model.ts");

test("resolveSessionModel：优先 getModel，不碰 snapshot", () => {
  const found = { provider: "new-api", id: "deepseek-v4-flash" };
  let snapshotCalls = 0;
  const model = resolveSessionModel(
    {
      getModel: (p, id) => (p === "new-api" && id === "deepseek-v4-flash" ? found : undefined),
      getAvailableSnapshot: () => {
        snapshotCalls += 1;
        return [];
      },
    },
    "new-api",
    "deepseek-v4-flash",
  );
  assert.equal(model, found);
  assert.equal(snapshotCalls, 0);
});

test("resolveSessionModel：getModel 未命中时回退 snapshot", () => {
  const found = { provider: "deepseek", id: "deepseek-v4-pro" };
  const model = resolveSessionModel(
    {
      getModel: () => undefined,
      getAvailableSnapshot: () => [found],
    },
    "deepseek",
    "deepseek-v4-pro",
  );
  assert.equal(model, found);
});

test("resolveSessionModel：都没有则 undefined", () => {
  const model = resolveSessionModel(
    { getModel: () => undefined, getAvailableSnapshot: () => [] },
    "x",
    "y",
  );
  assert.equal(model, undefined);
});
