/**
 * 思考深度契约：列表不串模型、点击不带旧深度、ensure 载荷、引导页源码顺序。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  listThinkingDisplayLevel,
  modelClickThinkingLevel,
  thinkingLevelForEnsureBody,
  guidePageThinkingUpdate,
} = await jiti.import("./thinking-level-policy.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("列表：非当前模型无缓存固定 auto，不吃会话级 high", () => {
  assert.equal(listThinkingDisplayLevel(null, false, "high"), "auto");
  assert.equal(listThinkingDisplayLevel(undefined, false, "max"), "auto");
  assert.equal(listThinkingDisplayLevel("low", false, "high"), "low");
});

test("列表：当前模型跟按钮（会话级），缓存不得盖住 auto", () => {
  assert.equal(listThinkingDisplayLevel("xhigh", true, "auto"), "auto");
  assert.equal(listThinkingDisplayLevel("minimal", true, "high"), "high");
  assert.equal(listThinkingDisplayLevel(null, true, "high"), "high");
  assert.equal(listThinkingDisplayLevel("xhigh", true, null), "xhigh");
  assert.equal(listThinkingDisplayLevel(null, true, null), "auto");
});

test("点模型：只用该模型缓存，无缓存 auto（不把上一模型深度带过去）", () => {
  assert.equal(modelClickThinkingLevel("xhigh"), "xhigh");
  assert.equal(modelClickThinkingLevel(null), "auto");
  assert.equal(modelClickThinkingLevel(""), "auto");
});

test("ensure body：非 auto 才附带 thinkingLevel", () => {
  assert.equal(thinkingLevelForEnsureBody("auto"), undefined);
  assert.equal(thinkingLevelForEnsureBody(null), undefined);
  assert.equal(thinkingLevelForEnsureBody("high"), "high");
  assert.equal(thinkingLevelForEnsureBody("max"), "max");
});

test("引导页：有 thinking 参数就必须本地更新（不依赖 sid）", () => {
  assert.equal(guidePageThinkingUpdate("high"), "high");
  assert.equal(guidePageThinkingUpdate("auto"), "auto");
  assert.equal(guidePageThinkingUpdate(null), null);
});

test("源码契约：isNew 路径 setThinkingLevel 在 !sid return 之前", () => {
  const src = readFileSync(join(root, "hooks/useAgentSession.ts"), "utf8");
  const start = src.indexOf("const handleModelChange = useCallback");
  assert.ok(start >= 0, "handleModelChange 存在");
  const end = src.indexOf("const handleCompact = useCallback", start);
  const block = src.slice(start, end > start ? end : start + 2500);
  const isNewIdx = block.indexOf("if (isNew)");
  assert.ok(isNewIdx >= 0, "isNew 分支存在");
  // isNew 分支到 return; 结束（其后是已有会话路径）
  const afterIsNew = block.slice(isNewIdx);
  const branchEnd = afterIsNew.indexOf("return;\n    }\n    const sid = sessionIdRef");
  const isNewBranch = branchEnd > 0 ? afterIsNew.slice(0, branchEnd) : afterIsNew.slice(0, 800);
  const setIdx = isNewBranch.search(/setThinkingLevel\(/);
  const earlyReturnIdx = isNewBranch.indexOf("if (!sid) return");
  assert.ok(setIdx >= 0, "isNew 分支有 setThinkingLevel");
  assert.ok(earlyReturnIdx >= 0, "isNew 分支有 !sid return");
  assert.ok(
    setIdx < earlyReturnIdx,
    "引导页必须先 setThinkingLevel 再因无 sid return（否则思考选不中）",
  );
  assert.match(isNewBranch, /guidePageThinkingUpdate/);
});

test("源码契约：ChatInput 列表/点击使用 policy 辅助函数", () => {
  const src = readFileSync(join(root, "components/ChatInput.tsx"), "utf8");
  assert.match(src, /listThinkingDisplayLevel/);
  assert.match(src, /modelClickThinkingLevel/);
  assert.match(src, /thinking-level-policy/);
});

test("源码契约：ensureNewSession 使用 thinkingLevelForEnsureBody", () => {
  const src = readFileSync(join(root, "hooks/useAgentSession.ts"), "utf8");
  assert.match(src, /thinkingLevelForEnsureBody/);
  assert.match(src, /thinking-level-policy/);
});

