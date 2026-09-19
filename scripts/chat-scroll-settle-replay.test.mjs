/**
 * 运行结束、非贴底阅读时的滚动位置验收（真实浏览器 + 真实 ChatWindow）。
 *
 * 专用测试会话：ensure_session，不向用户真实会话发消息、不跑真实模型。
 * 页内拦截该会话的 GET /api/sessions/:id，注入合成长 timeline；EventSource
 * 由测试闸门投递 agent_start / agent_end。真实滚轮把目标标记滚进视口后再放行收尾。
 *
 * 现有 sse-run-recording.json 不含 agent_end（会走磁盘 hydrate），测不到这次路径。
 *
 * 运行前提：31416、agent-browser。
 * 用法：node --test scripts/chat-scroll-settle-replay.test.mjs
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
const SESSION = "pidance-scroll-settle";
const ORIGIN = new URL(URL_BASE).origin;
const AUTH_COOKIE_NAME = "pidance_ui_session";
const OLD_MARKER = "SETTLE_OLD_MARKER";
const PROCESS_MARKER = "SETTLE_PROCESS_MARKER";
const ANSWER_MARKER = "SETTLE_ANSWER_MARKER";
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

function buildSyntheticContext(processCount) {
  const messages = [];
  const entryIds = [];
  for (let i = 0; i < 30; i += 1) {
    const userText = i === 20
      ? `${OLD_MARKER} older question ${i}`
      : `question ${i} padding ${"word ".repeat(8)}`;
    messages.push({ role: "user", content: userText });
    entryIds.push(`e-u-${i}`);
    messages.push({
      role: "assistant",
      provider: "p",
      model: "m",
      content: [{ type: "text", text: `answer ${i} ${"ok ".repeat(12)}` }],
    });
    entryIds.push(`e-a-${i}`);
  }
  messages.push({ role: "user", content: "SETTLE_LAST_USER last question" });
  entryIds.push("e-u-last");
  for (let i = 0; i < processCount; i += 1) {
    messages.push({
      role: "assistant",
      provider: "p",
      model: "m",
      content: [
        { type: "thinking", thinking: `${PROCESS_MARKER}_${i} ${"work ".repeat(30)}` },
        { type: "toolCall", toolCallId: `c${i}`, toolName: "bash", input: { command: "true" } },
      ],
    });
    entryIds.push(`e-p-${i}`);
  }
  messages.push({
    role: "assistant",
    provider: "p",
    model: "m",
    content: [{ type: "text", text: `${ANSWER_MARKER} final answer ${"done ".repeat(20)}` }],
  });
  entryIds.push("e-a-last");
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
  const sources = [];
  const writes = [];
  let running = false;
  const RealEventSource = window.EventSource;
  const RealFetch = window.fetch.bind(window);

  const pathOf = (url) => {
    try { return new URL(url, location.origin).pathname; }
    catch { return ""; }
  };
  const sessionPath = "/api/sessions/" + SESSION_ID;
  const classify = (stack) => {
    const text = String(stack ?? "");
    if (text.includes("pinToBottom")) return "pinToBottom";
    if (text.includes("applyBoxHeightChangeToScroller")) return "applyBoxHeightChangeToScroller";
    if (text.includes("applyViewportScrollAnchor")) return "applyViewportScrollAnchor";
    if (text.includes("restoreScrollTop")) return "restoreScrollTop";
    return "other";
  };

  window.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input && input.url);
    const method = String(init?.method || (typeof input === "object" && input && input.method) || "GET").toUpperCase();
    const path = pathOf(url);
    if (method === "GET" && path === sessionPath) {
      const response = await RealFetch(input, init);
      const body = await response.json();
      return new Response(JSON.stringify({ ...body, context: CONTEXT }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "GET" && path === sessionPath + "/state" && running) {
      const response = await RealFetch(input, init);
      const body = await response.json().catch(() => ({}));
      return new Response(JSON.stringify({ ...body, live: true, running: true, activeRun: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
          writes.push({
            kind: "scrollTop",
            from: desc.get.call(this),
            to: value,
            at: performance.now(),
            source: classify(new Error("scroll").stack),
            stack: String(new Error("scroll").stack || "").split("\\n").slice(0, 8),
          });
        }
        desc.set.call(this, value);
      },
    });
    return { ok: true, owner: target === Element.prototype ? "Element" : String(target) };
  };
  const patched = patchScrollTopOnce();

  const realScrollTo = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (...args) {
    if (this.getAttribute && this.getAttribute("data-chat-scroller") === "true") {
      writes.push({
        kind: "scrollTo",
        args,
        at: performance.now(),
        source: classify(new Error("scrollTo").stack),
        stack: String(new Error("scrollTo").stack || "").split("\\n").slice(0, 8),
      });
    }
    return realScrollTo.apply(this, args);
  };

  class GateEventSource {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.onmessage = null;
      this.onerror = null;
      if (!this.url.includes(SESSION_ID)) {
        this.readyState = 2;
        setTimeout(() => { try { this.onerror && this.onerror(new Event("error")); } catch {} }, 0);
        return;
      }
      this.readyState = 1;
      sources.push(this);
      setTimeout(() => this._emit({ type: "connected", sessionId: SESSION_ID }), 0);
    }
    _emit(event) {
      try { this.onmessage && this.onmessage({ data: JSON.stringify(event) }); }
      catch (error) { window.__settleGate.errors.push(String(error)); }
    }
    close() {
      this.readyState = 2;
      const index = sources.indexOf(this);
      if (index >= 0) sources.splice(index, 1);
    }
  }
  window.EventSource = GateEventSource;
  void RealEventSource;

  const findMarkerRange = (root, marker) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.data.indexOf(marker);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + marker.length);
      return range;
    }
    return null;
  };

  window.__settleGate = {
    errors: [],
    writes,
    patchedOwner: patched.owner,
    get running() { return running; },
    emit(event) {
      if (event && event.type === "agent_start") running = true;
      if (event && (event.type === "agent_end" || event.type === "prompt_done")) running = false;
      for (const source of sources) source._emit(event);
      return sources.length;
    },
    writeCount() { return writes.length; },
    probeSetter() {
      const scroller = document.querySelector("[data-chat-scroller='true']");
      if (!scroller) return { ok: false };
      const before = writes.length;
      const current = scroller.scrollTop;
      scroller.scrollTop = current + 1;
      scroller.scrollTop = current;
      return {
        ok: true,
        grew: writes.length > before,
        before,
        after: writes.length,
        patchedOwner: patched.owner,
      };
    },
    capture(marker) {
      const scroller = document.querySelector("[data-chat-scroller='true']");
      const chat = document.querySelector("[data-pidance-chat='true']");
      if (!scroller) return { ok: false, reason: "no-scroller" };
      const range = findMarkerRange(scroller, marker);
      const scrollerBox = scroller.getBoundingClientRect();
      const rect = range ? range.getBoundingClientRect() : null;
      const jump = document.querySelector(".chat-jump-bottom");
      const intersects = Boolean(rect
        && rect.bottom > scrollerBox.top + 1
        && rect.top < scrollerBox.bottom - 1);
      return {
        ok: true,
        marker,
        found: Boolean(range),
        intersects,
        markerOffset: rect ? rect.top - scrollerBox.top : null,
        markerHeight: rect ? rect.height : null,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        jumpVisible: jump ? jump.classList.contains("is-visible") : false,
        nEntry: scroller.querySelectorAll("[data-message-entry-id]").length,
        hasProcessDetails: /过程|Process|chat_processDetails/.test(scroller.innerText || ""),
        writeCount: writes.length,
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
  tempDir = mkdtempSync(join(tmpdir(), "pidance-scroll-settle-"));
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
  let listed = false;
  for (let i = 0; i < 40 && !listed; i += 1) {
    const listRes = await fetch(`${URL_BASE}/api/sessions`, { headers: AUTH_HEADER });
    const listBody = listRes.ok ? await listRes.json() : null;
    const items = Array.isArray(listBody) ? listBody : listBody?.sessions ?? listBody?.data ?? [];
    listed = Array.isArray(items) && items.some((item) => item && (item.id === sessionId || item.sessionId === sessionId));
    if (!listed) await new Promise((r) => setTimeout(r, 300));
  }
  assert.ok(listed, "测试会话未进入服务端列表");
  const cookies = await ab(["cookies", "get", "--json", "--session", SESSION]);
  authCookie = cookies?.data?.cookies?.find((cookie) => cookie?.name === AUTH_COOKIE_NAME)?.value ?? null;
  assert.ok(authCookie, "未取得 UI 会话 cookie");
});

after(async () => {
  await ab(["close", "--session", SESSION], { json: false }).catch(() => {});
  if (sessionId) {
    await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: AUTH_HEADER,
    }).catch(() => {});
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

async function openGatedSession(context, width, height) {
  const initScriptPath = join(tempDir, `settle-init-${width}.js`);
  writeFileSync(initScriptPath, buildInitScript(sessionId, context));
  await ab(["close", "--session", SESSION], { json: false }).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  try {
    await ab(["open", "--init-script", initScriptPath, "--session", SESSION], { json: false });
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    await ab(["open", "--init-script", initScriptPath, "--session", SESSION], { json: false });
  }
  await ab([
    "cookies", "set", AUTH_COOKIE_NAME, authCookie,
    "--url", ORIGIN, "--httpOnly", "--sameSite", "Strict", "--session", SESSION,
  ], { json: false });
  await ab(["set", "viewport", String(width), String(height), "--session", SESSION], { json: false });
  await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(sessionId)}`, "--session", SESSION], { json: false });
  const deadline = Date.now() + 20_000;
  let snap = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    snap = await evalResult("window.__settleGate ? window.__settleGate.capture('SETTLE_OLD_MARKER') : null");
    if (snap?.ok && snap.found && snap.scrollHeight > snap.clientHeight) break;
  }
  assert.ok(snap?.ok, `视口 ${width}×${height}：闸门未挂载 ${JSON.stringify(snap)}`);
  assert.ok(snap.found, `视口 ${width}×${height}：合成旧轮标记不可见`);
  const probe = await evalResult("window.__settleGate.probeSetter()");
  assert.ok(probe?.grew, `scrollTop 写入日志未生效 ${JSON.stringify(probe)}`);
  return snap;
}

async function scrollMarkerIntoView(marker) {
  const capture = () => evalResult(`window.__settleGate.capture(${JSON.stringify(marker)})`);
  for (let i = 0; i < 24; i += 1) {
    const snap = await capture();
    assert.ok(snap?.found, `标记不可见 ${marker}`);
    if (snap.intersects && snap.distance > 40) return snap;
    const direction = (snap.markerOffset ?? 0) < 8 ? "up" : "down";
    await ab(["scroll", direction, "360", "--selector", SCROLLER, "--session", SESSION], { json: false });
    await new Promise((r) => setTimeout(r, 50));
  }
  const last = await capture();
  assert.ok(last?.intersects, `未能把标记滚进视口 ${JSON.stringify(last)}`);
  assert.ok(last.distance > 40, `标记进视口后仍贴底 ${JSON.stringify(last)}`);
  return last;
}

async function sampleSettle(marker) {
  return evalResult(`(() => {
    const marker = ${JSON.stringify(marker)};
    const startWrites = window.__settleGate.writeCount();
    const frames = [];
    return new Promise((resolve) => {
      let n = 0;
      const tick = () => {
        const snap = window.__settleGate.capture(marker);
        frames.push({
          n,
          t: performance.now(),
          offset: snap.markerOffset,
          intersects: snap.intersects,
          found: snap.found,
          scrollTop: snap.scrollTop,
          scrollHeight: snap.scrollHeight,
          clientHeight: snap.clientHeight,
          maxScrollTop: snap.maxScrollTop,
          distance: snap.distance,
          jumpVisible: snap.jumpVisible,
          nEntry: snap.nEntry,
          hasProcessDetails: snap.hasProcessDetails,
          writeCount: snap.writeCount,
        });
        n += 1;
        if (n >= 20) {
          resolve({
            frames,
            newWrites: window.__settleGate.writes.slice(startWrites),
          });
          return;
        }
        requestAnimationFrame(tick);
      };
      window.__settleGate.emit({ type: "agent_end" });
      requestAnimationFrame(tick);
    });
  })()`);
}

function compact(snap) {
  if (!snap) return null;
  return {
    off: snap.markerOffset,
    dist: snap.distance,
    top: snap.scrollTop,
    h: snap.scrollHeight,
    max: snap.maxScrollTop,
    jump: snap.jumpVisible,
    hit: snap.intersects,
    nEntry: snap.nEntry,
    process: snap.hasProcessDetails,
  };
}

async function runSettleCase({ processCount, width, height, label, marker = OLD_MARKER }) {
  const context = buildSyntheticContext(processCount);
  await openGatedSession(context, width, height);
  const started = await evalResult("window.__settleGate.emit({ type: 'agent_start' })");
  assert.ok(started > 0, `${label}: 没有 EventSource 接收 agent_start`);
  await new Promise((r) => setTimeout(r, 400));
  const running = await evalResult(`window.__settleGate.capture(${JSON.stringify(marker)})`);
  const before = await scrollMarkerIntoView(marker);
  const sampled = await sampleSettle(marker);
  const after = sampled?.frames?.at(-1);
  assert.ok(after?.found, `${label}: 收尾后标记丢失`);
  const delta = Math.abs((after.offset ?? 0) - (before.markerOffset ?? 0));
  console.log(`[scroll-settle] ${label} running=${JSON.stringify(compact(running))} before=${JSON.stringify(compact(before))} after=${JSON.stringify(after)} frames=${JSON.stringify((sampled.frames ?? []).map((frame) => [frame.n, frame.offset, frame.scrollTop, frame.scrollHeight, frame.writeCount]))} writes=${JSON.stringify((sampled.newWrites ?? []).map((item) => ({ source: item.source, kind: item.kind, from: item.from, to: item.to })))}`);
  return { running, before, after, frames: sampled.frames, newWrites: sampled.newWrites ?? [], delta, label };
}

function assertStable(result, extra) {
  assert.ok(result.before.intersects, `${result.label}: 收尾前标记不在视口`);
  assert.ok(result.after.intersects, `${result.label}: 收尾后标记离开视口`);
  const origin = result.before.markerOffset;
  for (const frame of result.frames ?? []) {
    assert.ok(frame.found, `${result.label}: 第 ${frame.n} 帧标记消失`);
    const frameDelta = Math.abs((frame.offset ?? 0) - origin);
    assert.ok(
      frameDelta <= 2,
      `${result.label}: 第 ${frame.n} 帧偏移 ${frameDelta.toFixed(1)}px（origin=${origin} offset=${frame.offset} top=${frame.scrollTop} h=${frame.scrollHeight}）`,
    );
  }
  assert.ok(
    result.delta <= 2,
    `${extra} 偏移 ${result.delta.toFixed(1)}px（before=${result.before.markerOffset} after=${result.after.offset} scrollTop ${result.before.scrollTop}→${result.after.scrollTop} height ${result.before.scrollHeight}→${result.after.scrollHeight} writes=${JSON.stringify(result.newWrites)}）`,
  );
}

test("收尾时非贴底阅读：旧轮内容应留在原处（桌面，长过程轮）", { timeout: 180_000 }, async () => {
  const result = await runSettleCase({ processCount: 24, width: 1280, height: 720, label: "desktop-fat" });
  assertStable(result, "长过程轮旧标记");
});

test("收尾时非贴底阅读：短过程轮同样不得跳（桌面）", { timeout: 180_000 }, async () => {
  const result = await runSettleCase({ processCount: 2, width: 1280, height: 720, label: "desktop-thin" });
  assertStable(result, "短过程轮旧标记");
});

test("收尾时非贴底阅读：当前过程内部（桌面，长过程轮）", { timeout: 180_000 }, async () => {
  const result = await runSettleCase({
    processCount: 24,
    width: 1280,
    height: 720,
    label: "desktop-process",
    marker: `${PROCESS_MARKER}_0`,
  });
  assertStable(result, "过程内部标记");
});

test("收尾时非贴底阅读：当前过程内部（窄屏）", { timeout: 180_000 }, async () => {
  const result = await runSettleCase({
    processCount: 24,
    width: 390,
    height: 844,
    label: "narrow-process",
    marker: `${PROCESS_MARKER}_0`,
  });
  assertStable(result, "窄屏过程内部标记");
});

test("收尾时非贴底阅读：窄屏长过程轮旧标记", { timeout: 180_000 }, async () => {
  const result = await runSettleCase({ processCount: 24, width: 390, height: 844, label: "narrow-fat" });
  assertStable(result, "窄屏旧标记");
});
