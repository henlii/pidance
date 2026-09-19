/**
 * 引导消息在会话里的位置契约（真实浏览器 + 真实 ChatWindow + 真实 registry）。
 *
 * 规则（对齐 dsh：引导投递到 next-step 边界，工具结果按 callId 归属所属 step）：
 *   U0 → 步骤 1 组（消息输出 + 工具调用） → 引导 → 后续步骤
 * 即使引导是在步骤 1 还在流式时发出的、而步骤 1 的 assistant 落盘发生在引导之后，
 * 显示顺序也必须保持在步骤 1 之下（不得翻到上方）。
 *
 * 复现方式：专用测试会话 ensure_session；页内把 EventSource 换成闸门桩按需投递事件，
 * 拦截 POST /api/agent/:id（steer 命令）与 /api/agent/:id、/state（报告 live+running）。
 * 运行前提：31416、agent-browser。
 * 用法：node --test scripts/chat-steer-order.test.mjs
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
const SESSION = "pidance-steer-order";
const ORIGIN = new URL(URL_BASE).origin;
const AUTH_COOKIE_NAME = "pidance_ui_session";

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

function buildContext() {
  const messages = [];
  const entryIds = [];
  for (let i = 0; i < 4; i += 1) {
    messages.push({ role: "user", content: `STEER_PRE_Q_${i} ${"pad ".repeat(10)}` });
    entryIds.push(`e-u-${i}`);
    messages.push({
      role: "assistant",
      provider: "p",
      model: "m",
      content: [{ type: "text", text: `STEER_PRE_A_${i} ${"ok ".repeat(20)}` }],
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
  const posts = [];
  const pathOf = (url) => {
    try { return new URL(url, location.origin).pathname; }
    catch { return ""; }
  };
  const sessionPath = "/api/sessions/" + SESSION_ID;
  window.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input && input.url);
    const method = String(init?.method || (typeof input === "object" && input && input.method) || "GET").toUpperCase();
    const path = pathOf(url);
    if (path === "/api/agent/" + SESSION_ID) {
      if (method === "POST") {
        let body = null;
        try { body = JSON.parse(String(init?.body ?? "{}")); } catch {}
        posts.push({ type: body?.type ?? "?", message: String(body?.message ?? "").slice(0, 40), submissionId: body?.submissionId ?? null });
        return new Response(JSON.stringify({ success: true, data: { accepted: true } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ live: true, running: true, activeRun: true, lockedByOther: false, state: { isStreaming: true, isPromptRunning: true } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && path === sessionPath + "/state") {
      return new Response(JSON.stringify({ live: true, running: true, activeRun: true, lockedByOther: false, state: { extensionStatuses: [], extensionWidgets: [], isStreaming: true, isPromptRunning: true } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "GET" && path === sessionPath) {
      await RealFetch(input, init);
      return new Response(JSON.stringify({ context: CONTEXT }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return RealFetch(input, init);
  };
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
      catch (error) { window.__steerGate.errors.push(String(error)); }
    }
    close() { this.readyState = 2; const i = sources.indexOf(this); if (i >= 0) sources.splice(i, 1); }
  }
  window.EventSource = GateEventSource;
  const findTextNode = (root, marker) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) if (node.data.includes(marker)) return node;
    return null;
  };
  window.__steerGate = {
    errors: [],
    posts,
    emit(events) {
      const list = Array.isArray(events) ? events : [events];
      for (const event of list) for (const source of sources) source._emit(event);
      return { sources: sources.length };
    },
    /** 骨架顺序：把标记按 DOM 顺序列出（只认消息元素内的文本）。 */
    order(marks) {
      const scroller = document.querySelector("[data-chat-scroller='true']");
      if (!scroller) return { ok: false, reason: "no-scroller" };
      const found = [];
      for (const mark of marks) {
        const node = findTextNode(scroller, mark);
        if (!node) continue;
        const el = node.parentElement;
        found.push({ mark, top: el ? el.getBoundingClientRect().top : null });
      }
      found.sort((a, b) => (a.top ?? 0) - (b.top ?? 0));
      return { ok: true, order: found.map((item) => item.mark), tops: found.map((item) => [item.mark, Math.round(item.top ?? 0)]), text: (scroller.innerText || "").replace(/\\s+/g, " ").slice(-260) };
    },
    composer() {
      const box = document.querySelector("textarea, [data-chat-input], [contenteditable='true']");
      const send = Array.from(document.querySelectorAll("button")).find((btn) => /发送|插话/.test(btn.getAttribute("aria-label") || btn.textContent || ""));
      return { hasBox: Boolean(box), hasSend: Boolean(send), sendLabel: send ? (send.getAttribute("aria-label") || send.textContent || "").trim().slice(0, 20) : null };
    },
    dumpComposer() {
      const buttons = Array.from(document.querySelectorAll("button")).map((btn) => ({
        label: (btn.getAttribute("aria-label") || "").slice(0, 24),
        title: (btn.getAttribute("title") || "").slice(0, 16),
        text: (btn.textContent || "").trim().slice(0, 10),
        disabled: btn.disabled,
      }));
      const box = document.querySelector("textarea");
      return { hasTextarea: Boolean(box), placeholder: box ? (box.getAttribute("placeholder") || "").slice(0, 20) : null, buttons: buttons.slice(-14) };
    },
    /** 在输入框写入文本并用 Ctrl+Enter 插话发送（桌面上 Ctrl+Enter = steer）。 */
    typeAndSteer(text) {
      const box = document.querySelector("textarea");
      if (!box) return Promise.resolve({ ok: false, reason: "no-textarea" });
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(box, text);
      box.dispatchEvent(new Event("input", { bubbles: true }));
      const typed = box.value;
      return new Promise((resolve) => {
        setTimeout(() => {
          box.focus();
          const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
          const notCancelled = box.dispatchEvent(event);
          resolve({ ok: true, typed, notCancelled });
        }, 120);
      });
    },
  };
})();`;
}

let sessionId = null;
let tempDir = null;
let authCookie = null;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "pidance-steer-order-"));
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
  const initScriptPath = join(tempDir, "steer-init.js");
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
  await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });
  await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(sessionId)}`, "--session", SESSION], { json: false });
  const deadline = Date.now() + 25_000;
  let snap = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    snap = await evalResult("window.__steerGate ? window.__steerGate.composer() : null");
    if (snap?.hasBox) break;
  }
  assert.ok(snap?.hasBox, `输入框未就绪 ${JSON.stringify(snap)}`);
  return snap;
}

const STEP_TEXT = "STEER_STEP_TEXT 我先看一下";
const STEER_TEXT = "STEER_USER_TEXT 换个思路";

async function sendSteerViaUi() {
  return evalResult(`window.__steerGate.typeAndSteer(${JSON.stringify(STEER_TEXT)})`);
}

test("流式中发引导：这一步落盘后引导仍在该组下方", { timeout: 240_000 }, async () => {
  await openFixture();
  // 步骤 1 开始流式输出（live 槽）
  await evalResult(`window.__steerGate.emit({ type: "agent_start", streamRunSeq: 1 })`);
  await evalResult(`window.__steerGate.emit({
    type: "message_start",
    message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: ${JSON.stringify(STEP_TEXT)} }] },
  })`);
  await evalResult(`window.__steerGate.emit({
    type: "message_update",
    message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: ${JSON.stringify(STEP_TEXT)} }] },
  })`);
  await new Promise((r) => setTimeout(r, 250));

  const sendResult = await sendSteerViaUi();
  await new Promise((r) => setTimeout(r, 600));
  const composerDump = await evalResult("window.__steerGate.dumpComposer()");
  console.log(`[steer-order] send=${JSON.stringify(sendResult)} placeholder=${JSON.stringify(composerDump?.placeholder)}`);
  const afterSteer = await evalResult(`window.__steerGate.order([${JSON.stringify(STEP_TEXT)}, ${JSON.stringify(STEER_TEXT)}])`);
  const posts = await evalResult("window.__steerGate.posts");

  // 步骤 1 落盘（生产里这条发生得比引导晚）+ 工具结果
  await evalResult(`window.__steerGate.emit([
    { type: "message_end", entryId: "e-step-1", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: ${JSON.stringify(STEP_TEXT)} }, { type: "toolCall", toolCallId: "call_steer_1", toolName: "bash", input: { command: "echo steer" } }] } },
    { type: "message_end", entryId: "e-tool-1", message: { role: "toolResult", toolCallId: "call_steer_1", toolName: "bash", content: [{ type: "text", text: "STEER_TOOL_RESULT done" }] } },
  ])`);
  await new Promise((r) => setTimeout(r, 800));
  const afterDisk = await evalResult(`window.__steerGate.order([${JSON.stringify(STEP_TEXT)}, ${JSON.stringify(STEER_TEXT)}])`);
  console.log(`[steer-order] posts=${JSON.stringify(posts)} afterSteer=${JSON.stringify(afterSteer)} afterDisk=${JSON.stringify(afterDisk)}`);

  assert.ok(
    Array.isArray(posts) && posts.some((post) => post.type === "steer"),
    `引导没有走 steer 命令：${JSON.stringify(posts)}`,
  );
  assert.ok(afterSteer?.ok && afterDisk?.ok, `顺序采集失败 ${JSON.stringify({ afterSteer, afterDisk })}`);
  assert.deepEqual(
    afterSteer.order,
    [STEP_TEXT, STEER_TEXT],
    `引导发出后顺序应为自己所在组下方：${JSON.stringify(afterSteer)}`,
  );
  assert.deepEqual(
    afterDisk.order,
    [STEP_TEXT, STEER_TEXT],
    `这一步落盘后引导被翻到了该组上方：${JSON.stringify(afterDisk)}`,
  );
});
