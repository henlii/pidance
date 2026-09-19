/**
 * 一次输出多个工具块时的自动跟随验收（真实浏览器 + 真实 ChatWindow + 真实 registry）。
 *
 * 复现方式（不依赖真实模型）：专用测试会话 ensure_session；页内把 EventSource 换成
 * 闸门桩（事件由测试按需投递），并让 /api/agent/:id 与 /api/sessions/:id/state 报告
 * live+running。闸门在同一帧投出一条含 N 个工具块的 assistant 快照（N=1/3/8），
 * 随后同帧投递工具结果，再逐帧采样「距底部距离 / 是否已释放（回到底部按钮）」。
 *
 * 断言：用户始终贴底（从未释放）时，追加多少工具块，视口都要在有限帧内回到新底部；
 * 且用户释放后同样的内容增长不得把视口拉回底部。
 * 运行前提：31416、agent-browser。
 * 用法：node --test scripts/chat-batch-toolblocks-follow.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const URL_BASE = process.env.PIDANCE_TEST_URL ?? "http://127.0.0.1:31416";
const SESSION = "pidance-batch-tools";
const ORIGIN = new URL(URL_BASE).origin;
const AUTH_COOKIE_NAME = "pidance_ui_session";
const SCROLLER = "[data-chat-scroller='true']";

function readUiPassword() {
  if (process.env.PIDANCE_TEST_PASSWORD) return process.env.PIDANCE_TEST_PASSWORD;
  if (process.env.PI_WEB_PASSWORD) return process.env.PI_WEB_PASSWORD;
  try {
    const raw = readFileSync("/etc/pidance/secret.env", "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("PI_WEB_PASSWORD=")) {
        return line.slice("PI_WEB_PASSWORD=".length).replace(/^['"]|['"]$/g, "");
      }
    }
  } catch {
    // ignore
  }
  return "";
}

const PASSWORD = readUiPassword();
const AUTH_HEADER = PASSWORD ? { Authorization: `Basic ${Buffer.from(`pi:${PASSWORD}`).toString("base64")}` } : {};

async function ab(args, { json = true } = {}) {
  const cmd = ["agent-browser", ...(json ? ["--json"] : []), ...args];
  const { stdout } = await exec(cmd[0], cmd.slice(1), { maxBuffer: 64 * 1024 * 1024 });
  if (!json) return stdout.trim();
  try {
    return JSON.parse(stdout);
  } catch {
    return { error: "parse-failed", raw: stdout.slice(0, 500) };
  }
}

async function evalResult(script) {
  const result = await ab(["eval", "--session", SESSION, script]);
  return result?.data?.result;
}

async function snapshotRefs() {
  const res = await ab(["snapshot", "--json", "--session", SESSION]);
  return res?.data?.refs ?? {};
}

async function ensureAuthed() {
  if (!PASSWORD) return;
  const refs = await snapshotRefs();
  const pwdRef = Object.entries(refs).find(([, item]) => item?.name === "密码")?.[0];
  if (!pwdRef) return;
  await ab(["fill", pwdRef, PASSWORD, "--session", SESSION], { json: false });
  const refs2 = await snapshotRefs();
  const loginRef = Object.entries(refs2).find(([, item]) => item?.role === "button" && item?.name === "登录")?.[0];
  if (loginRef) await ab(["click", loginRef, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 2500));
}

/** 一段足以滚动的历史（保证视口可滚，距离才有意义）。 */
function buildContext() {
  const messages = [];
  const entryIds = [];
  for (let i = 0; i < 6; i += 1) {
    messages.push({ role: "user", content: `BATCH_Q_${i} ${"pad ".repeat(20)}` });
    entryIds.push(`e-u-${i}`);
    messages.push({
      role: "assistant",
      provider: "p",
      model: "m",
      content: [{ type: "text", text: `BATCH_A_${i} ${"line ${i} ".repeat(30)}` }],
    });
    entryIds.push(`e-a-${i}`);
  }
  return {
    messages,
    entryIds,
    thinkingLevel: "off",
    model: { provider: "p", modelId: "m" },
    hasMoreBefore: false,
    totalMessageCount: messages.length,
  };
}

function buildInitScript(sessionId, context) {
  return `(() => {
  const SESSION_ID = ${JSON.stringify(sessionId)};
  const CONTEXT = ${JSON.stringify(context)};
  const RealFetch = window.fetch.bind(window);
  const sources = [];
  const writes = [];
  let running = false;
  const pathOf = (url) => {
    try { return new URL(url, location.origin).pathname; }
    catch { return ""; }
  };
  const sessionPath = "/api/sessions/" + SESSION_ID;
  window.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input && input.url);
    const method = String(init?.method || (typeof input === "object" && input && input.method) || "GET").toUpperCase();
    const path = pathOf(url);
    if (method === "GET" && path === sessionPath) {
      await RealFetch(input, init);
      return new Response(JSON.stringify({ context: CONTEXT }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && path === "/api/agent/" + SESSION_ID) {
      return new Response(JSON.stringify({ live: true, running, activeRun: running, lockedByOther: false, state: { isStreaming: running, isPromptRunning: running } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && path === sessionPath + "/state") {
      return new Response(JSON.stringify({ live: true, running, activeRun: running, lockedByOther: false, state: { extensionStatuses: [], extensionWidgets: [], isStreaming: running, isPromptRunning: running } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return RealFetch(input, init);
  };
  const patchScrollTopOnce = () => {
    let target = Element.prototype;
    let desc = Object.getOwnPropertyDescriptor(target, "scrollTop");
    while (!desc && target) {
      target = Object.getPrototypeOf(target);
      if (!target) break;
      desc = Object.getOwnPropertyDescriptor(target, "scrollTop");
    }
    if (!desc || !desc.get || !desc.set || !target) return { ok: false, owner: null };
    Object.defineProperty(target, "scrollTop", {
      configurable: true,
      enumerable: desc.enumerable,
      get() { return desc.get.call(this); },
      set(value) {
        if (this.getAttribute && this.getAttribute("data-chat-scroller") === "true") {
          writes.push({ from: desc.get.call(this), to: value, at: performance.now() });
        }
        desc.set.call(this, value);
      },
    });
    return { ok: true, owner: target === Element.prototype ? "Element" : String(target) };
  };
  const patched = patchScrollTopOnce();
  class GateEventSource {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.onmessage = null;
      this.onerror = null;
      if (!this.url.includes(SESSION_ID)) { this.readyState = 2; return; }
      this.readyState = 1;
      sources.push(this);
      setTimeout(() => this._emit({ type: "connected", sessionId: SESSION_ID }), 0);
    }
    _emit(event) {
      try { this.onmessage && this.onmessage({ data: JSON.stringify(event) }); }
      catch (error) { window.__batchGate.errors.push(String(error)); }
    }
    close() { this.readyState = 2; const i = sources.indexOf(this); if (i >= 0) sources.splice(i, 1); }
  }
  window.EventSource = GateEventSource;
  window.__batchGate = {
    errors: [],
    writes,
    patchedOwner: patched.owner,
    emit(events) {
      const list = Array.isArray(events) ? events : [events];
      for (const event of list) {
        if (event.type === "agent_start") running = true;
        if (event.type === "agent_end" || event.type === "prompt_done") running = false;
      }
      for (const event of list) for (const source of sources) source._emit(event);
      return { sources: sources.length, count: list.length };
    },
    probeSetter() {
      const scroller = document.querySelector("[data-chat-scroller='true']");
      if (!scroller) return { ok: false };
      const before = writes.length;
      const current = scroller.scrollTop;
      scroller.scrollTop = current + 1;
      scroller.scrollTop = current;
      return { ok: true, grew: writes.length > before, owner: patched.owner };
    },
    /** 选中包含 marker 的文本（模拟用户拖选工具输出）。 */
    selectMarker(marker) {
      const scroller = document.querySelector("[data-chat-scroller='true']");
      if (!scroller) return { ok: false, reason: "no-scroller" };
      const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const index = node.data.indexOf(marker);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, Math.min(node.data.length, index + marker.length + 10));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return { ok: true, type: selection.type, text: selection.toString().slice(0, 40) };
      }
      return { ok: false, reason: "no-marker" };
    },
    clearSelection() {
      window.getSelection()?.removeAllRanges();
      return window.getSelection()?.type ?? "None";
    },
    capture() {
      const scroller = document.querySelector("[data-chat-scroller='true']");
      const chat = document.querySelector("[data-pidance-chat='true']");
      const jump = document.querySelector(".chat-jump-bottom");
      if (!scroller) return { ok: false, reason: "no-scroller" };
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      return {
        ok: true,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        distance,
        released: jump ? jump.classList.contains("is-visible") : null,
        written: writes.length,
        nEntry: scroller.querySelectorAll("[data-message-entry-id]").length,
        text: (scroller.innerText || "").replace(/\\s+/g, " ").slice(-160),
        messageCount: Number(chat?.getAttribute("data-chat-message-count") ?? -1),
      };
    },
  };
})();`;
}

let sessionId = null;
let tempDir = null;
let authCookie = null;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "pidance-batch-tools-"));
  await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
  await ensureAuthed();
  const res = await fetch(`${URL_BASE}/api/agent/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ cwd: process.cwd(), type: "ensure_session" }),
  });
  const body = await res.json();
  sessionId = body?.sessionId ?? null;
  assert.ok(sessionId, `ensure_session 失败: ${res.status}`);
  const cookies = await ab(["cookies", "get", "--json", "--session", SESSION]);
  authCookie = cookies?.data?.cookies?.find((cookie) => cookie?.name === AUTH_COOKIE_NAME)?.value ?? null;
  assert.ok(authCookie, "未取得 UI 会话 cookie");
});

after(async () => {
  await ab(["close", "--session", SESSION], { json: false }).catch(() => {});
  if (sessionId) {
    await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", headers: AUTH_HEADER }).catch(() => {});
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

async function openFixture() {
  const initScriptPath = join(tempDir, "batch-init.js");
  writeFileSync(initScriptPath, buildInitScript(sessionId, buildContext()));
  await ab(["close", "--session", SESSION], { json: false }).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  try {
    await ab(["open", "--init-script", initScriptPath, "--session", SESSION], { json: false });
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    await ab(["open", "--init-script", initScriptPath, "--session", SESSION], { json: false });
  }
  await ab(["cookies", "set", AUTH_COOKIE_NAME, authCookie, "--url", ORIGIN, "--httpOnly", "--sameSite", "Strict", "--session", SESSION], { json: false });
  await ab(["set", "viewport", "1280", "620", "--session", SESSION], { json: false });
  await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(sessionId)}`, "--session", SESSION], { json: false });
  const deadline = Date.now() + 25_000;
  let snap = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    snap = await evalResult("window.__batchGate ? window.__batchGate.capture() : null");
    if (snap?.ok && snap.nEntry > 0 && snap.scrollHeight > snap.clientHeight) break;
  }
  assert.ok(snap?.ok, `闸门未挂载 ${JSON.stringify(snap)}`);
  const probe = await evalResult("window.__batchGate.probeSetter()");
  assert.ok(probe?.grew, `scrollTop 写入日志未生效 ${JSON.stringify(probe)}`);
  return snap;
}

/** 同一帧投出一条含 N 个工具块的 assistant 快照 + 结果，再逐帧采样。 */
async function runBatch(toolCount, { frames = 24 } = {}) {
  return evalResult(`(() => {
    const N = ${toolCount};
    const content = [{ type: "text", text: "BATCH_STEP 开始 " + "x".repeat(40) }];
    for (let i = 0; i < N; i += 1) {
      content.push({ type: "thinking", thinking: "BATCH_THINK_" + i + " " + "work ".repeat(20) });
      content.push({ type: "toolCall", toolCallId: "call_batch_" + i, toolName: "bash", input: { command: "echo " + i } });
    }
    const message = { role: "assistant", provider: "p", model: "m", content };
    const results = [];
    for (let i = 0; i < N; i += 1) {
      results.push({
        type: "message_end",
        entryId: "e-batch-tool-" + i,
        message: { role: "toolResult", toolCallId: "call_batch_" + i, toolName: "bash", content: [{ type: "text", text: "BATCH_RESULT_" + i + " " + "out ".repeat(30) }] },
      });
    }
    window.__batchGate.emit({ type: "agent_start", streamRunSeq: 1 });
    const framesOut = [];
    return new Promise((resolve) => {
      let n = 0;
      const tick = () => {
        if (n === 0) {
          // 同一帧：assistant 快照（含 N 个工具块）与全部结果
          window.__batchGate.emit([
            { type: "message_start", message },
            { type: "message_update", message },
            { type: "message_end", entryId: "e-batch-step", message },
            ...results,
          ]);
        }
        const snap = window.__batchGate.capture();
        framesOut.push({ n, t: performance.now(), distance: snap.distance, released: snap.released, written: snap.written, nEntry: snap.nEntry, scrollHeight: snap.scrollHeight, scrollTop: snap.scrollTop });
        n += 1;
        if (n >= ${frames}) { resolve({ frames: framesOut }); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  })()`);
}

/** 逐帧流式输出一个含 N 个工具块的 step，再逐帧投递工具结果。 */
async function runStreamingStep(toolIndex, toolCount, { frames = 30 } = {}) {
  return evalResult(`(() => {
    const IDX = ${toolIndex};
    const N = ${toolCount};
    const base = [{ type: "text", text: "BATCH_STREAM_STEP_" + IDX + " " + "y".repeat(30) }];
    const withBlocks = (count) => {
      const content = [...base];
      for (let i = 0; i < count; i += 1) {
        content.push({ type: "thinking", thinking: "BATCH_STREAM_THINK_" + IDX + "_" + i + " " + "work ".repeat(20) });
        content.push({ type: "toolCall", toolCallId: "call_stream_" + IDX + "_" + i, toolName: "bash", input: { command: "echo " + i } });
      }
      return { role: "assistant", provider: "p", model: "m", content };
    };
    window.__batchGate.emit({ type: "agent_start", streamRunSeq: IDX + 1 });
    const framesOut = [];
    return new Promise((resolve) => {
      // 前 N+1 帧：一次多一个工具块（模拟同一消息里连续出现的工具块）
      // 之后 N+2 帧：逐条投递工具结果
      const total = (N + 1) + (N + 2) + ${frames};
      let n = 0;
      const tick = () => {
        if (n === 0) {
          window.__batchGate.emit({ type: "message_start", message: withBlocks(0) });
        } else if (n <= N) {
          window.__batchGate.emit({ type: "message_update", message: withBlocks(n) });
        } else if (n === N + 1) {
          window.__batchGate.emit({ type: "message_end", entryId: "e-stream-step-" + IDX, message: withBlocks(N) });
        } else if (n <= N + 1 + N) {
          const i = n - (N + 2);
          window.__batchGate.emit({
            type: "message_end",
            entryId: "e-stream-tool-" + IDX + "-" + i,
            message: { role: "toolResult", toolCallId: "call_stream_" + IDX + "_" + i, toolName: "bash", content: [{ type: "text", text: "BATCH_STREAM_RESULT_" + IDX + "_" + i + " " + "out ".repeat(30) }] },
          });
        }
        const snap = window.__batchGate.capture();
        framesOut.push({ n, t: performance.now(), distance: snap.distance, released: snap.released, written: snap.written, nEntry: snap.nEntry, scrollTop: snap.scrollTop, scrollHeight: snap.scrollHeight });
        n += 1;
        if (n >= total) { resolve({ frames: framesOut, streamFrames: N + 1, resultFrames: N + 2 }); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  })()`);
}

/** 连续多步、每步多个工具块（相邻 step 之间只留少量帧）。 */
async function runRapidSteps(stepCount, toolsPerStep, { framesBetween = 2, frames = 30 } = {}) {
  return evalResult(`(() => {
    const STEPS = ${stepCount};
    const N = ${toolsPerStep};
    window.__batchGate.emit({ type: "agent_start", streamRunSeq: 99 });
    const framesOut = [];
    return new Promise((resolve) => {
      let n = 0;
      let step = 0;
      const stepMessage = (s, count) => {
        const content = [{ type: "text", text: "BATCH_RAPID_STEP_" + s + " " + "z".repeat(20) }];
        for (let i = 0; i < count; i += 1) {
          content.push({ type: "thinking", thinking: "BATCH_RAPID_THINK_" + s + "_" + i + " " + "work ".repeat(18) });
          content.push({ type: "toolCall", toolCallId: "call_rapid_" + s + "_" + i, toolName: "bash", input: { command: "echo " + i } });
        }
        return { role: "assistant", provider: "p", model: "m", content };
      };
      const emitStep = (s) => {
        const events = [
          { type: "message_start", message: stepMessage(s, 0) },
          { type: "message_update", message: stepMessage(s, N) },
          { type: "message_end", entryId: "e-rapid-step-" + s, message: stepMessage(s, N) },
        ];
        for (let i = 0; i < N; i += 1) {
          events.push({
            type: "message_end",
            entryId: "e-rapid-tool-" + s + "-" + i,
            message: { role: "toolResult", toolCallId: "call_rapid_" + s + "_" + i, toolName: "bash", content: [{ type: "text", text: "BATCH_RAPID_RESULT_" + s + "_" + i + " " + "out ".repeat(35) }] },
          });
        }
        window.__batchGate.emit(events);
      };
      const tick = () => {
        if (step < STEPS && n === 0) emitStep(0);
        else if (step < STEPS && (n % ${framesBetween + 1}) === 0 && step === Math.floor(n / ${framesBetween + 1})) emitStep(step);
        const snap = window.__batchGate.capture();
        framesOut.push({ n, t: performance.now(), distance: snap.distance, released: snap.released, written: snap.written, nEntry: snap.nEntry, scrollTop: snap.scrollTop });
        n += 1;
        step = Math.min(STEPS, Math.floor(n / (${framesBetween + 1})));
        if (n >= ${frames}) { resolve({ frames: framesOut }); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  })()`);
}

test("贴底时一次输出多个工具块：视口必须跟到新底部（1/3/8 块）", { timeout: 240_000 }, async () => {
  await openFixture();
  for (const toolCount of [1, 3, 8]) {
    const result = await runBatch(toolCount);
    const frames = result?.frames ?? [];
    console.log(`[batch-tools] N=${toolCount} frames=${JSON.stringify(frames.map((f) => [f.n, Math.round(f.distance), f.released, f.written, f.nEntry]))}`);
    assert.ok(frames.length > 0, `N=${toolCount}: 未采到帧`);
    assert.equal(frames[0].released, false, `N=${toolCount}: 追加前用户应处于跟随态`);
    // 最后一次未贴底的帧：之后必须一直贴底，且这段延迟有界（约 6 帧 / 100ms）
    const lastOff = frames.reduce((acc, frame, index) => ((frame.distance ?? 1e9) > 2 ? index : acc), -1);
    assert.ok(lastOff <= 6, `N=${toolCount}: 未在有界帧内贴底 ${JSON.stringify(frames.map((f) => Math.round(f.distance)))}`);
    const tail = frames.slice(lastOff + 1);
    assert.ok(tail.length > 0, `N=${toolCount}: 采样窗口内没有贴底后的帧`);
    assert.ok(tail.every((frame) => (frame.distance ?? 1e9) <= 2), `N=${toolCount}: 贴底后又漂移 ${JSON.stringify(tail.map((f) => Math.round(f.distance)))}`);
    assert.equal(frames.at(-1).released, false, `N=${toolCount}: 不应被判成已释放（这会让自动跟随失效）`);
  }
});

test("流式逐帧冒出多个工具块：不得卡住不跟随", { timeout: 240_000 }, async () => {
  await openFixture();
  for (const toolCount of [3, 8]) {
    const result = await runStreamingStep(toolCount, toolCount);
    const frames = result?.frames ?? [];
    console.log(`[batch-tools] stream N=${toolCount} frames=${JSON.stringify(frames.map((f) => [f.n, Math.round(f.distance), f.released, f.written]))}`);
    assert.ok(frames.length > 0, `stream N=${toolCount}: 未采到帧`);
    assert.equal(frames[0].released, false, `stream N=${toolCount}: 起始应处于跟随态`);
    // 结果全部投递后 + 有界收尾帧内必须贴底
    const lastOff = frames.reduce((acc, frame, index) => ((frame.distance ?? 1e9) > 2 ? index : acc), -1);
    const tailBudget = (toolCount + 2) + 10;
    assert.ok(lastOff <= tailBudget, `stream N=${toolCount}: 未在有界帧内贴底 ${JSON.stringify(frames.map((f) => Math.round(f.distance)))}`);
    assert.ok(frames.slice(lastOff + 1).every((frame) => (frame.distance ?? 1e9) <= 2), `stream N=${toolCount}: 贴底后又漂移`);
    assert.equal(frames.at(-1).released, false, `stream N=${toolCount}: 不应被判成已释放`);
  }
});

test("连续多步快速输出：跟随不得中断", { timeout: 240_000 }, async () => {
  await openFixture();
  const result = await runRapidSteps(4, 4);
  const frames = result?.frames ?? [];
  console.log(`[batch-tools] rapid frames=${JSON.stringify(frames.map((f) => [f.n, Math.round(f.distance), f.released, f.written]))}`);
  assert.ok(frames.length > 0, "rapid: 未采到帧");
  assert.equal(frames.some((frame) => frame.released === true), false, "rapid: 用户没滚动，不应被判成已释放");
  const lastOff = frames.reduce((acc, frame, index) => ((frame.distance ?? 1e9) > 2 ? index : acc), -1);
  assert.ok(lastOff <= frames.length - 4, `rapid: 结束前未回到贴底 ${JSON.stringify(frames.map((f) => Math.round(f.distance)))}`);
  assert.ok(frames.slice(lastOff + 1).every((frame) => (frame.distance ?? 1e9) <= 2), "rapid: 贴底后又漂移");
});

/**
 * 同一帧投出 N 个大体积工具块（触发块内限高/延迟详情）：先看追加瞬间，再看有界帧内是否贴底。
 */
async function runBigBatch(toolCount, resultChars, { frames = 40 } = {}) {
  return evalResult(`(() => {
    const N = ${toolCount};
    const CHARS = ${resultChars};
    const big = (label, i) => "BIG_" + label + "_" + i + " " + "payload ".repeat(Math.max(1, Math.floor(CHARS / 8)));
    const content = [{ type: "text", text: "BIG_STEP 开始" }];
    for (let i = 0; i < N; i += 1) {
      content.push({ type: "thinking", thinking: "BIG_THINK_" + i + " " + "work ".repeat(60) });
      content.push({ type: "toolCall", toolCallId: "call_big_" + i, toolName: "bash", input: { command: "big " + i } });
    }
    const message = { role: "assistant", provider: "p", model: "m", content };
    const results = [];
    for (let i = 0; i < N; i += 1) {
      results.push({
        type: "message_end",
        entryId: "e-big-tool-" + i,
        message: { role: "toolResult", toolCallId: "call_big_" + i, toolName: "bash", content: [{ type: "text", text: big("RESULT", i) }] },
      });
    }
    window.__batchGate.emit({ type: "agent_start", streamRunSeq: 7 });
    const framesOut = [];
    return new Promise((resolve) => {
      let n = 0;
      const tick = () => {
        if (n === 0) {
          window.__batchGate.emit([
            { type: "message_start", message },
            { type: "message_update", message },
            { type: "message_end", entryId: "e-big-step", message },
            ...results,
          ]);
        }
        const snap = window.__batchGate.capture();
        framesOut.push({ n, t: performance.now(), distance: snap.distance, released: snap.released, written: snap.written, nEntry: snap.nEntry, scrollTop: snap.scrollTop, scrollHeight: snap.scrollHeight, clientHeight: snap.clientHeight });
        n += 1;
        if (n >= ${frames}) { resolve({ frames: framesOut }); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  })()`);
}

test("大体积多工具块一次渲出：不得留下未贴底的残余", { timeout: 240_000 }, async () => {
  await openFixture();
  for (const [toolCount, resultChars] of [[4, 40000], [8, 20000]]) {
    const result = await runBigBatch(toolCount, resultChars);
    const frames = result?.frames ?? [];
    const compactFrames = frames.map((f) => [f.n, Math.round(f.distance), f.released, f.written, f.nEntry]);
    console.log(`[batch-tools] big N=${toolCount} chars=${resultChars} frames=${JSON.stringify(compactFrames)}`);
    assert.ok(frames.length > 0, `big N=${toolCount}: 未采到帧`);
    assert.equal(frames[0].released, false, `big N=${toolCount}: 起始应跟随`);
    // 最长连续未贴底帧数（卡顿信号）
    let streak = 0;
    let longest = 0;
    for (const frame of frames) {
      if ((frame.distance ?? 1e9) > 2) { streak += 1; longest = Math.max(longest, streak); } else streak = 0;
    }
    const lastOff = frames.reduce((acc, frame, index) => ((frame.distance ?? 1e9) > 2 ? index : acc), -1);
    assert.ok(lastOff <= 6, `big N=${toolCount}: 有界帧内未贴底（最长未贴底 ${longest} 帧）${JSON.stringify(compactFrames)}`);
    assert.ok(frames.slice(lastOff + 1).every((frame) => (frame.distance ?? 1e9) <= 2), `big N=${toolCount}: 贴底后又漂移 ${JSON.stringify(compactFrames)}`);
    assert.equal(frames.at(-1).released, false, `big N=${toolCount}: 不应被判成已释放`);
  }
});

test("回到最底部后：后续多工具块必须恢复跟随", { timeout: 240_000 }, async () => {
  await openFixture();
  await runBatch(1, { frames: 6 });
  // 1) 真实滚轮回到最底 → 再输出多个工具块
  await ab(["scroll", "up", "600", "--selector", SCROLLER, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 300));
  for (let i = 0; i < 12; i += 1) {
    const snap = await evalResult("window.__batchGate.capture()");
    if (snap.distance <= 2) break;
    await ab(["scroll", "down", "700", "--selector", SCROLLER, "--session", SESSION], { json: false });
    await new Promise((r) => setTimeout(r, 60));
  }
  const atBottom = await evalResult("window.__batchGate.capture()");
  const wheelResult = await runBatch(4, { frames: 16 });
  const wheelFrames = wheelResult?.frames ?? [];
  console.log(`[batch-tools] resume-wheel atBottom=${JSON.stringify({ d: Math.round(atBottom.distance), released: atBottom.released })} frames=${JSON.stringify(wheelFrames.map((f) => [f.n, Math.round(f.distance), f.released]))}`);
  assert.ok(atBottom.distance <= 2, `滚轮未到达最底 ${JSON.stringify(atBottom)}`);
  assert.ok(
    wheelFrames.slice(-1)[0].distance <= 2,
    `滚回底部后再输出多工具块，未重新跟随 ${JSON.stringify(wheelFrames.map((f) => [f.n, Math.round(f.distance)]))}`,
  );

  // 2) 释放 → 用「回到底部」按钮回到最底 → 再输出多个工具块
  await ab(["scroll", "up", "700", "--selector", SCROLLER, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 400));
  const beforeClick = await evalResult("window.__batchGate.capture()");
  const clicked = await evalResult(`(() => {
    const btn = document.querySelector(".chat-jump-bottom");
    if (!btn) return { ok: false };
    btn.click();
    return { ok: true };
  })()`);
  assert.ok(clicked?.ok, "未找到回到底部按钮");
  await new Promise((r) => setTimeout(r, 1200));
  const afterClick = await evalResult("window.__batchGate.capture()");
  const buttonResult = await runBatch(4, { frames: 16 });
  const buttonFrames = buttonResult?.frames ?? [];
  console.log(`[batch-tools] resume-button before=${JSON.stringify({ d: Math.round(beforeClick.distance), released: beforeClick.released })} afterClick=${JSON.stringify({ d: Math.round(afterClick.distance), released: afterClick.released })} frames=${JSON.stringify(buttonFrames.map((f) => [f.n, Math.round(f.distance), f.released]))}`);
  assert.ok(afterClick.distance <= 2, `回到底部按钮未生效 ${JSON.stringify(afterClick)}`);
  assert.ok(
    buttonFrames.slice(-1)[0].distance <= 2,
    `点回到底部后再输出多工具块，未重新跟随 ${JSON.stringify(buttonFrames.map((f) => [f.n, Math.round(f.distance)]))}`,
  );
});

test("跟随中选中了工具输出后：仍然要继续跟随（选区不得永久卡住贴底）", { timeout: 240_000 }, async () => {
  await openFixture();
  await runBatch(2, { frames: 8 });
  const selected = await evalResult(`window.__batchGate.selectMarker("BATCH_THINK_0")`);
  assert.ok(selected?.ok, `未能选中工具输出 ${JSON.stringify(selected)}`);
  assert.equal(selected.type, "Range", `选中后 selection.type 应为 Range，实际 ${selected.type}`);
  const result = await runBatch(4, { frames: 20 });
  const frames = result?.frames ?? [];
  console.log(`[batch-tools] selected frames=${JSON.stringify(frames.map((f) => [f.n, Math.round(f.distance), f.released, f.written]))}`);
  assert.ok(frames.length > 0, "selected: 未采到帧");
  const lastOff = frames.reduce((acc, frame, index) => ((frame.distance ?? 1e9) > 2 ? index : acc), -1);
  assert.ok(
    lastOff <= 6 && frames.slice(lastOff + 1).every((frame) => (frame.distance ?? 1e9) <= 2),
    `页面上存在选区时自动跟随失效（一直不跟随）${JSON.stringify(frames.map((f) => Math.round(f.distance)))}`,
  );
  await evalResult("window.__batchGate.clearSelection()");
});

test("有选区时点「回到底部」：必须真的回到底部并恢复跟随", { timeout: 240_000 }, async () => {
  await openFixture();
  await runBatch(2, { frames: 8 });
  await ab(["scroll", "up", "700", "--selector", SCROLLER, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 400));
  const released = await evalResult("window.__batchGate.capture()");
  assert.ok(released.distance > 200, `未进入阅读态 ${JSON.stringify(released)}`);
  const selected = await evalResult(`window.__batchGate.selectMarker("BATCH_THINK_0")`);
  assert.equal(selected?.type, "Range", `选中失败 ${JSON.stringify(selected)}`);
  const clicked = await evalResult(`(() => {
    const btn = document.querySelector(".chat-jump-bottom");
    if (!btn) return { ok: false, reason: "no-button" };
    btn.click();
    return { ok: true, visible: btn.classList.contains("is-visible") };
  })()`);
  assert.ok(clicked?.ok, `未找到回到底部按钮 ${JSON.stringify(clicked)}`);
  await new Promise((r) => setTimeout(r, 1200));
  const after = await evalResult("window.__batchGate.capture()");
  const result = await runBatch(4, { frames: 16 });
  const frames = result?.frames ?? [];
  console.log(`[batch-tools] jump-with-selection before=${JSON.stringify({ d: Math.round(released.distance) })} afterClick=${JSON.stringify({ d: Math.round(after.distance), top: after.scrollTop, written: after.written })} frames=${JSON.stringify(frames.map((f) => [f.n, Math.round(f.distance)]))}`);
  assert.ok(after.distance <= 2, `有选区时「回到底部」未生效 ${JSON.stringify(after)}`);
  assert.ok(
    (frames.at(-1)?.distance ?? 1e9) <= 2,
    `回到底部后跟随未恢复 ${JSON.stringify(frames.map((f) => [f.n, Math.round(f.distance)]))}`,
  );
  await evalResult("window.__batchGate.clearSelection()");
});

test("用户已释放时：同样的多工具块增长不得把视口拉回底部", { timeout: 240_000 }, async () => {
  await openFixture();
  await runBatch(1, { frames: 8 });
  await ab(["scroll", "up", "600", "--selector", SCROLLER, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 200));
  const before = await evalResult("window.__batchGate.capture()");
  assert.ok(before.distance > 200, `未能脱离贴底 ${JSON.stringify(before)}`);
  await runBatch(8, { frames: 16 });
  const after = await evalResult("window.__batchGate.capture()");
  console.log(`[batch-tools] released before=${JSON.stringify({ d: Math.round(before.distance), top: before.scrollTop })} after=${JSON.stringify({ d: Math.round(after.distance), top: after.scrollTop, released: after.released })}`);
  assert.ok(Math.abs(after.scrollTop - before.scrollTop) <= 4, `释放后视口被改写 ${before.scrollTop} → ${after.scrollTop}`);
});
