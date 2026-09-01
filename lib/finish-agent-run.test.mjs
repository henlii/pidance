/**
 * P2 统一 agent run 结束路径的测试。
 * 覆盖 lib/finish-agent-run.ts 纯逻辑 seam（claim/token 校验）与模拟器复刻的
 * hook 控制流（finishAgentRun / reconcileAgentState / handleAgentEvent）的竞态语义：
 * 双路径去重、旧 reconcile/旧 SSE source 迟到不结束新 run、loadSession 失败不永久 running。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  beginAgentRunFinish,
  canFinalizeAgentRun,
  shouldFinishFromReconcile,
} from "./finish-agent-run.ts";

/** 让当前微任务队列排空（用于并发收尾断言）。 */
const tick = () => new Promise((r) => setImmediate(r));

/**
 * 复刻 hook 中 finishAgentRun 的控制流（决策走 lib seam，副作用用计数器模拟），
 * 用于断言 P2 统一结束路径的竞态语义。refs 就是普通对象，不引入假状态机类。
 */
function createFinishSimulator() {
  const refs = {
    sessionId: "sid-1",
    promptRunId: 0,
    agentRunning: false,
    finishingRunId: null,
  };
  const calls = {
    loadSession: 0,
    snapshot: 0,
    settle: 0,
    endPin: 0,
    dispatchEnd: 0,
    onAgentEnd: 0,
    setRunningFalse: 0,
  };
  let loadSessionMode = "ok"; // "ok" | "fail"
  let loadSessionDelayMs = 0;

  async function loadSession() {
    calls.loadSession += 1;
    if (loadSessionDelayMs > 0) {
      await new Promise((r) => setTimeout(r, loadSessionDelayMs));
    }
    // hook 的 loadSession 内部捕获错误并返回 null（失败不 throw）
    if (loadSessionMode === "fail") return null;
    return { running: false, state: { isCompacting: false } };
  }

  // 与 hook 中 finishAgentRun 相同的控制流：begin 校验 + claim 抢占 →
  // loadSession → 二次校验 → 结束副作用 + 释放 claim。
  async function finishAgentRun(sid, runId) {
    if (!beginAgentRunFinish({
      sessionId: sid,
      currentSessionId: refs.sessionId,
      eventRunId: runId,
      currentRunId: refs.promptRunId,
      running: refs.agentRunning,
      claimedRunId: refs.finishingRunId,
    })) return;
    refs.finishingRunId = runId;
    try {
      const agentState = await loadSession();
      // 快照/end-pin 只在 loadSession 成功（消息真正替换）时发生
      if (agentState) {
        calls.snapshot += 1;
        if (runId === refs.promptRunId) {
          calls.settle += 1;
          calls.endPin += 1;
        }
      }
    } finally {
      const valid = canFinalizeAgentRun({
        sessionId: sid,
        currentSessionId: refs.sessionId,
        eventRunId: runId,
        currentRunId: refs.promptRunId,
        claimedRunId: refs.finishingRunId,
      });
      refs.finishingRunId = null;
      if (!valid) return;
      refs.agentRunning = false;
      calls.setRunningFalse += 1;
      calls.dispatchEnd += 1;
      calls.onAgentEnd += 1;
    }
  }

  // 复刻 hook 中 reconcileAgentState 的判定控制流（fetch 注入便于挂起/时序控制）。
  let reconcileFetch = async () => ({ running: false, state: {} });
  async function reconcileAgentState(sid) {
    if (!refs.agentRunning) return;
    const runId = refs.promptRunId;
    const data = await reconcileFetch();
    if (refs.promptRunId !== runId) return;
    const state = data.state ?? {};
    if (!shouldFinishFromReconcile({
      sendInFlight: refs.sendInFlight === true,
      clientRunning: refs.agentRunning,
      live: data.running === true,
      isStreaming: state.isStreaming === true,
      isPromptRunning: state.isPromptRunning === true,
      isCompacting: state.isCompacting === true,
    })) return;
    await finishAgentRun(sid, runId);
  }

  // 复刻 hook 中 handleAgentEvent 的分发：结束事件走 finishAgentRun（携带建立时
  // 捕获的 eventRunId），未知事件（如 tool_execution_update）走 default 忽略。
  function handleAgentEvent(event, eventRunId) {
    switch (event.type) {
      case "agent_end":
      case "prompt_done":
        return finishAgentRun(refs.sessionId, eventRunId ?? refs.promptRunId);
      default:
        return undefined;
    }
  }

  return {
    refs, calls,
    setLoadSessionMode(mode) { loadSessionMode = mode; },
    setLoadSessionDelay(ms) { loadSessionDelayMs = ms; },
    setReconcileFetch(fn) { reconcileFetch = fn; },
    finishAgentRun, reconcileAgentState, handleAgentEvent,
  };
}

test("seam：reconcile 无 live / 发送在途不得当成空闲收尾", () => {
  const idle = {
    sendInFlight: false,
    clientRunning: true,
    live: true,
    isStreaming: false,
    isPromptRunning: false,
    isCompacting: false,
  };
  assert.equal(shouldFinishFromReconcile(idle), true);
  assert.equal(shouldFinishFromReconcile({ ...idle, sendInFlight: true }), false);
  assert.equal(shouldFinishFromReconcile({ ...idle, live: false }), false);
  assert.equal(shouldFinishFromReconcile({ ...idle, isPromptRunning: true }), false);
  assert.equal(shouldFinishFromReconcile({ ...idle, clientRunning: false }), false);
});

test("seam：beginAgentRunFinish 的 token/claim 前置校验", () => {
  const base = { sessionId: "s", currentSessionId: "s", eventRunId: 1, currentRunId: 1, running: true, claimedRunId: null };
  assert.equal(beginAgentRunFinish(base), true);
  // 无真实会话
  assert.equal(beginAgentRunFinish({ ...base, sessionId: null }), false);
  // 目标 sid 与当前会话不一致（已切换会话）
  assert.equal(beginAgentRunFinish({ ...base, sessionId: "old-s" }), false);
  // 旧 token（旧 source/旧 reconcile 携带）
  assert.equal(beginAgentRunFinish({ ...base, eventRunId: 1, currentRunId: 2 }), false);
  // 未在运行
  assert.equal(beginAgentRunFinish({ ...base, running: false }), false);
  // claim 已被占（重复进入）
  assert.equal(beginAgentRunFinish({ ...base, claimedRunId: 1 }), false);
});

test("seam：canFinalizeAgentRun 的二次校验（loadSession 后）", () => {
  const base = { sessionId: "s", currentSessionId: "s", eventRunId: 1, currentRunId: 1, claimedRunId: 1 };
  assert.equal(canFinalizeAgentRun(base), true);
  // run 已切换（新 run 开始）
  assert.equal(canFinalizeAgentRun({ ...base, currentRunId: 2 }), false);
  // 会话已切换
  assert.equal(canFinalizeAgentRun({ ...base, sessionId: "old-s" }), false);
  // claim 被其它 run 持有（防御）
  assert.equal(canFinalizeAgentRun({ ...base, claimedRunId: 2 }), false);
  // sid 漂移（切换会话）
  assert.equal(canFinalizeAgentRun({ ...base, sessionId: null }), false);
});

test("agent_end 正常结束：loadSession 一次、快照刷新一次、settle/end-pin、dispatch(end)/onAgentEnd 各一次、running=false", async () => {
  const sim = createFinishSimulator();
  sim.refs.agentRunning = true;
  sim.refs.promptRunId = 1;
  await sim.finishAgentRun("sid-1", 1);
  assert.equal(sim.calls.loadSession, 1);
  assert.equal(sim.calls.snapshot, 1);
  assert.equal(sim.calls.settle, 1);
  assert.equal(sim.calls.endPin, 1);
  assert.equal(sim.calls.dispatchEnd, 1);
  assert.equal(sim.calls.onAgentEnd, 1);
  assert.equal(sim.calls.setRunningFalse, 1);
  assert.equal(sim.refs.agentRunning, false);
  assert.equal(sim.refs.finishingRunId, null);
});

test("agent_end→prompt_done 并发：loadSession 仅一次、onAgentEnd 仅一次", async () => {
  const sim = createFinishSimulator();
  sim.refs.agentRunning = true;
  sim.refs.promptRunId = 1;
  await Promise.all([
    sim.finishAgentRun("sid-1", 1), // agent_end 先到
    sim.finishAgentRun("sid-1", 1), // prompt_done 迟到
  ]);
  assert.equal(sim.calls.loadSession, 1);
  assert.equal(sim.calls.dispatchEnd, 1);
  assert.equal(sim.calls.onAgentEnd, 1);
  assert.equal(sim.refs.finishingRunId, null);
});

test("prompt_done→agent_end 并发：同样只收尾一次", async () => {
  const sim = createFinishSimulator();
  sim.refs.agentRunning = true;
  sim.refs.promptRunId = 1;
  await Promise.all([
    sim.finishAgentRun("sid-1", 1), // prompt_done 先到
    sim.finishAgentRun("sid-1", 1), // agent_end 迟到
  ]);
  assert.equal(sim.calls.loadSession, 1);
  assert.equal(sim.calls.dispatchEnd, 1);
  assert.equal(sim.calls.onAgentEnd, 1);
  assert.equal(sim.refs.finishingRunId, null);
});

test("reconcile：发送在途或无 live 不收尾", async () => {
  const sim = createFinishSimulator();
  sim.refs.agentRunning = true;
  sim.refs.promptRunId = 1;
  sim.refs.sendInFlight = true;
  sim.setReconcileFetch(async () => ({ running: false, state: {} }));
  await sim.reconcileAgentState("sid-1");
  assert.equal(sim.calls.loadSession, 0);
  assert.equal(sim.refs.agentRunning, true);

  sim.refs.sendInFlight = false;
  await sim.reconcileAgentState("sid-1");
  assert.equal(sim.calls.loadSession, 0);
  assert.equal(sim.refs.agentRunning, true);

  sim.setReconcileFetch(async () => ({ running: true, state: { isStreaming: false, isPromptRunning: false } }));
  await sim.reconcileAgentState("sid-1");
  assert.equal(sim.calls.loadSession, 1);
  assert.equal(sim.refs.agentRunning, false);
});

test("reconcile 在途 SSE 先结束：reconcile 不重复收尾", async () => {
  const sim = createFinishSimulator();
  sim.refs.agentRunning = true;
  sim.refs.promptRunId = 1;
  let resolveFetch;
  sim.setReconcileFetch(() => new Promise((r) => { resolveFetch = r; }));

  const reconcilePromise = sim.reconcileAgentState("sid-1"); // fetch 挂起
  await sim.finishAgentRun("sid-1", 1); // SSE agent_end 先完成收尾
  assert.equal(sim.calls.loadSession, 1);
  assert.equal(sim.refs.agentRunning, false);

  resolveFetch({ running: false, state: { isStreaming: false, isPromptRunning: false } });
  await reconcilePromise;
  // reconcile 判定不 busy，但 agentRunning 已 false → 前置校验拒绝，不重复
  assert.equal(sim.calls.loadSession, 1);
  assert.equal(sim.calls.dispatchEnd, 1);
  assert.equal(sim.calls.onAgentEnd, 1);
});

test("reconcile 先 claim：agent_end 迟到不重复", async () => {
  const sim = createFinishSimulator();
  sim.refs.agentRunning = true;
  sim.refs.promptRunId = 1;
  sim.setReconcileFetch(async () => ({ running: true, state: { isStreaming: false, isPromptRunning: false } }));
  sim.setLoadSessionDelay(20); // loadSession 挂起，制造 claim 窗口

  const reconcilePromise = sim.reconcileAgentState("sid-1");
  await tick(); // 让 reconcile 的 fetch resolve，finishAgentRun 占住 claim 并挂起
  await sim.finishAgentRun("sid-1", 1); // 迟到的 agent_end → claim 被占 → 拒绝
  await reconcilePromise;

  assert.equal(sim.calls.loadSession, 1);
  assert.equal(sim.calls.dispatchEnd, 1);
  assert.equal(sim.calls.onAgentEnd, 1);
  assert.equal(sim.refs.finishingRunId, null);
});

test("旧 reconcile 响应不结束新 run（run N 响应在 N+1 开始后返回 idle）", async () => {
  const sim = createFinishSimulator();
  sim.refs.agentRunning = true;
  sim.refs.promptRunId = 1; // run N
  let resolveFetch;
  sim.setReconcileFetch(() => new Promise((r) => { resolveFetch = r; }));

  const reconcilePromise = sim.reconcileAgentState("sid-1"); // 捕获 runId=1，fetch 挂起
  // 用户开始 run N+1
  sim.refs.promptRunId = 2;
  sim.refs.agentRunning = true;
  resolveFetch({ running: false, state: { isStreaming: false, isPromptRunning: false } });
  await reconcilePromise;
  // run N 的响应迟到：promptRunId 已变 → 直接丢弃
  assert.equal(sim.refs.agentRunning, true); // N+1 保持 running
  assert.equal(sim.calls.loadSession, 0); // 不 load N 的会话
  assert.equal(sim.calls.onAgentEnd, 0);
  assert.equal(sim.refs.finishingRunId, null);
});

test("旧 SSE source 迟到 agent_end/prompt_done 不结束新 run（建立时捕获 runId）", async () => {
  const sim = createFinishSimulator();
  sim.refs.agentRunning = true;
  sim.refs.promptRunId = 2; // 新 run N+1 已开始
  // 旧 source 建立时捕获 streamRunId=1（run N），迟到事件携带旧 token
  await Promise.all([
    sim.handleAgentEvent({ type: "agent_end" }, 1),
    sim.handleAgentEvent({ type: "prompt_done" }, 1),
  ]);
  assert.equal(sim.refs.agentRunning, true); // N+1 保持 running
  assert.equal(sim.calls.loadSession, 0);
  assert.equal(sim.calls.onAgentEnd, 0);
  assert.equal(sim.refs.finishingRunId, null);
});

test("loadSession 失败仍释放 run：不永久 running、claim 释放、结束副作用各一次、不设假 end-pin", async () => {
  const sim = createFinishSimulator();
  sim.refs.agentRunning = true;
  sim.refs.promptRunId = 1;
  sim.setLoadSessionMode("fail");
  await sim.finishAgentRun("sid-1", 1);
  assert.equal(sim.refs.agentRunning, false); // 不永久 running
  assert.equal(sim.refs.finishingRunId, null); // claim 释放
  assert.equal(sim.calls.dispatchEnd, 1);
  assert.equal(sim.calls.onAgentEnd, 1);
  assert.equal(sim.calls.snapshot, 0); // loadSession 失败无快照
  assert.equal(sim.calls.endPin, 0); // 不设假 end-pin
  assert.equal(sim.calls.settle, 0);
});

test("tool_execution_update 走 default 忽略：不抛错、不触发收尾", async () => {
  const sim = createFinishSimulator();
  sim.refs.agentRunning = true;
  sim.refs.promptRunId = 1;
  const result = await sim.handleAgentEvent({ type: "tool_execution_update", toolCallId: "t1", delta: "x" }, 1);
  assert.equal(result, undefined);
  assert.equal(sim.calls.loadSession, 0);
  assert.equal(sim.calls.dispatchEnd, 0);
  assert.equal(sim.refs.agentRunning, true);
});
