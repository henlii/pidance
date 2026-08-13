import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  thinkingLevelsFromMap,
  withPassThroughExtendedThinking,
} = await jiti.import("./thinking-levels.ts");

test("thinkingLevelsFromMap：非 reasoning 只有 off", () => {
  assert.deepEqual(thinkingLevelsFromMap(false), ["off"]);
});

test("thinkingLevelsFromMap：省略含 xhigh/max，仅 null 禁用", () => {
  assert.deepEqual(
    thinkingLevelsFromMap(true),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    thinkingLevelsFromMap(true, { minimal: null, max: null }),
    ["off", "low", "medium", "high", "xhigh"],
  );
});

test("withPassThroughExtendedThinking：省略的 xhigh/max 补恒等，显式 null 保留", () => {
  const m = {
    reasoning: true,
    thinkingLevelMap: { minimal: null, max: null },
  };
  const out = withPassThroughExtendedThinking(m);
  assert.equal(out.thinkingLevelMap.xhigh, "xhigh");
  assert.equal(out.thinkingLevelMap.max, null);
  assert.equal(out.thinkingLevelMap.minimal, null);
});
