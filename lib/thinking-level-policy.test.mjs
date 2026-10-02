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
  thinkingLabel,
  shouldAcceptRemoteThinking,
} = await jiti.import("./thinking-level-policy.ts");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("列表：非当前模型无缓存用 fallback，不吃会话级 high", () => {
  assert.equal(listThinkingDisplayLevel(null, false, "high", "xhigh"), "xhigh");
  assert.equal(listThinkingDisplayLevel(undefined, false, "max", "off"), "off");
  assert.equal(listThinkingDisplayLevel("low", false, "high", "xhigh"), "low");
});

test("列表：当前模型跟按钮（会话级），auto 当作未设", () => {
  assert.equal(listThinkingDisplayLevel("minimal", true, "high", "xhigh"), "high");
  assert.equal(listThinkingDisplayLevel("xhigh", true, "auto", "xhigh"), "xhigh");
  assert.equal(listThinkingDisplayLevel(null, true, "high", "off"), "high");
  assert.equal(listThinkingDisplayLevel("xhigh", true, null, "off"), "xhigh");
  assert.equal(listThinkingDisplayLevel(null, true, null, "xhigh"), "xhigh");
  assert.equal(listThinkingDisplayLevel("max", true, "off", "high"), "off");
});

test("点模型：只用该模型缓存，无缓存用 settings 默认", () => {
  assert.equal(modelClickThinkingLevel("xhigh", "off"), "xhigh");
  assert.equal(modelClickThinkingLevel(null, "xhigh"), "xhigh");
  assert.equal(modelClickThinkingLevel("", "high"), "high");
});

test("ensure body：具体档位才传，auto 不传", () => {
  assert.equal(thinkingLevelForEnsureBody("auto"), undefined);
  assert.equal(thinkingLevelForEnsureBody(null), undefined);
  assert.equal(thinkingLevelForEnsureBody("high"), "high");
  assert.equal(thinkingLevelForEnsureBody("max"), "max");
  assert.equal(thinkingLevelForEnsureBody("xhigh"), "xhigh");
});

test("引导页：有具体档位才本地更新（auto 忽略）", () => {
  assert.equal(guidePageThinkingUpdate("high"), "high");
  assert.equal(guidePageThinkingUpdate("auto"), null);
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

test("源码契约：模型选择器不因当前模型为空而整栏卸掉", () => {
  const src = readFileSync(join(root, "components/ChatInput.tsx"), "utf8");
  assert.doesNotMatch(src, /modelOptions\.length > 0 && currentName && onModelChange/);
  assert.match(src, /modelOptions\.length > 0 && onModelChange/);
});

test("源码契约：已有会话不使用 settings 默认模型/思考，切换时清理上会话状态", () => {
  const src = readFileSync(join(root, "hooks/useAgentSession.ts"), "utf8");
  assert.match(src, /isNew \? newSessionDefaultModel : null/);
  assert.match(src, /isNew\r?\n\s+\? thinkingLevel \?\? settingsDefaultThinking/);
  assert.match(src, /setNewSessionModel\(null\)/);
  assert.match(src, /setThinkingLevel\(null\)/);
  assert.match(src, /ensureServerPrefsLoaded/);
  assert.match(src, /fetch\("\/api\/models"/);
});

test("源码契约：ensureNewSession 使用 thinkingLevelForEnsureBody", () => {
  const src = readFileSync(join(root, "hooks/useAgentSession.ts"), "utf8");
  assert.match(src, /thinkingLevelForEnsureBody/);
  assert.match(src, /thinking-level-policy/);
});

// ── 输入框档位标签：切换会话时不得闪错值 ──

test("档位标签：未确认（切换中/加载中）不显示", () => {
  assert.equal(thinkingLabel(false, "high", null), null);
  assert.equal(thinkingLabel(false, null, "max"), null);
});

test("档位标签：已有会话不回落到 off（切会话瞬间不得闪错值）", () => {
  // level 已清空、权威值未到：fallback 传 null → 不显示
  assert.equal(thinkingLabel(true, null, null), null);
  assert.equal(thinkingLabel(true, undefined, null), null);
  assert.equal(thinkingLabel(true, "high", null), "high");
  assert.equal(thinkingLabel(true, "max", null), "max");
});

test("档位标签：引导页用 settings 默认作真实取值", () => {
  assert.equal(thinkingLabel(true, null, "max"), "max");
  assert.equal(thinkingLabel(true, null, "off"), "off");
  assert.equal(thinkingLabel(true, "low", "max"), "low");
});

test("档位标签：auto/空值不算档位", () => {
  assert.equal(thinkingLabel(true, "auto", null), null);
  assert.equal(thinkingLabel(true, "", null), null);
  assert.equal(thinkingLabel(true, null, "auto"), null);
});

function accept(overrides) {
  return shouldAcceptRemoteThinking({
    viewSessionId: "A",
    targetSessionId: "A",
    generation: 1,
    capturedGeneration: 1,
    userTouched: false,
    localLevel: "max",
    remoteLevel: "high",
    source: "live-hydrate",
    ...overrides,
  });
}

test("磁盘落地 max 后，热状态误报 high 不得覆盖", () => {
  assert.equal(accept({ source: "live-hydrate" }), false);
  assert.equal(accept({ source: "event" }), false);
  assert.equal(accept({ source: "disk", remoteLevel: "max" }), true);
});

test("用户改档之后远程值可写；代次前进的旧读取丢弃", () => {
  assert.equal(accept({ userTouched: true, remoteLevel: "high" }), true);
  assert.equal(accept({ capturedGeneration: 0, generation: 1 }), false);
});

test("A 的远程档位不得写入已切到的 B", () => {
  assert.equal(accept({ viewSessionId: "B", targetSessionId: "A" }), false);
  assert.equal(accept({ viewSessionId: "A", targetSessionId: "A", localLevel: null, remoteLevel: "high" }), true);
});

test("源码契约：useAgentSession 远程思考档必须走 shouldAcceptRemoteThinking", () => {
  const src = readFileSync(join(root, "hooks/useAgentSession.ts"), "utf8");
  assert.match(src, /shouldAcceptRemoteThinking/);
  assert.match(src, /thinkingGenerationRef/);
});

test("运行中不许改模型/思考：判据统一在 hook，且被拒必须说清楚", () => {
  const chatInput = readFileSync(fileURLToPath(new URL("../components/ChatInput.tsx", import.meta.url)), "utf8");
  // 视觉层仍禁用（更早拦住），但**判据本身**不再由输入区自己判断 ——
  // 两个不同源的判据（React 状态 isStreaming vs registry agentRunning）会留下空窗：
  // 界面认为空闲、按钮可点、菜单能选，而 hook 已按 registry 拒绝。
  assert.ok(chatInput.includes("disabled={isStreaming}"), "模型按钮在运行中应保持视觉禁用");
  const applyStart = chatInput.indexOf("const applyModelWithThinking = useCallback");
  const applyBlock = chatInput.slice(applyStart, applyStart + 1400);
  assert.ok(
    !/if \(isStreaming\) return;/.test(applyBlock),
    "applyModelWithThinking 不应再自己判断运行中（判据统一到 hook）",
  );
  // 偏好缓存只有真的生效才写：否则被拒时界面照样显示新档位，把「没生效」伪装成「已生效」。
  assert.match(
    chatInput,
    /const applied = await onModelChange\?\.\(provider, modelId, level\);/,
    "applyModelWithThinking 应等待 onModelChange 的结果",
  );
  assert.match(
    chatInput,
    /if \(applied !== false\) \{\s+setServerPref\(`thinkingLevel\./,
    "偏好缓存应只在生效后才写",
  );
  const hook = readFileSync(fileURLToPath(new URL("../hooks/useAgentSession.ts", import.meta.url)), "utf8");
  for (const [name, anchor] of [
    ["handleModelChange", "const handleModelChange = useCallback"],
    ["handleThinkingLevelChange", "const handleThinkingLevelChange = useCallback"],
  ]) {
    const start = hook.indexOf(anchor);
    const blk = hook.slice(start, start + 1500);
    assert.ok(
      /if \(getRuntimeAgentRunning\(\) \|\| bashRunningRef\.current \|\| isCompactingRef\.current\)/.test(blk),
      `${name} 缺少运行中门禁`,
    );
    assert.ok(blk.includes("addNotice("), `${name} 的运行中门禁必须给出提示`);
    assert.ok(blk.includes('t("input_changeLockedWhileRunning")'), `${name} 的提示应使用「不能修改」文案`);
    assert.match(blk, /return false;/, `${name} 被拒时应返回 false（调用方据此不写偏好缓存）`);
  }
});
