/**
 * 后台期间智能体提问、切回前台要看到提问栏（真实浏览器 + 真实 ChatWindow）。
 *
 * 复现方式（不依赖真实模型）：专用测试会话 ensure_session；页内拦截
 * `/api/sessions/:id/state` 模拟「host 里挂着一个待回答的阻塞请求」，并把
 * EventSource 换成永不投递的桩 —— 等价于「提问事件在后台期间漏掉了」。
 * 然后只派发 visibilitychange/focus（切回前台），不重新加载页面、不切会话。
 *
 * 断言：切回前台后有界时间内出现提问栏，且内容就是那条待答请求。
 * 运行前提：31416、agent-browser。
 * 用法：node --test scripts/extension-prompt-tab-return.test.mjs
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
const SESSION = "pidance-ext-prompt";
const ORIGIN = new URL(URL_BASE).origin;
const AUTH_COOKIE_NAME = "pidance_ui_session";
const PROMPT_ID = "ext-tab-return-1";
const PROMPT_TITLE = "EXT_TAB_RETURN_TITLE";
const PROMPT_MESSAGE = "EXT_TAB_RETURN_MESSAGE 后台期间的提问";

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

function buildInitScript(sessionId, context) {
  return `(() => {
  const SESSION_ID = ${JSON.stringify(sessionId)};
  const CONTEXT = ${JSON.stringify(context)};
  const PROMPT = {
    type: "extension_ui_request",
    id: ${JSON.stringify(PROMPT_ID)},
    method: "confirm",
    title: ${JSON.stringify(PROMPT_TITLE)},
    message: ${JSON.stringify(PROMPT_MESSAGE)},
  };
  const RealFetch = window.fetch.bind(window);
  const pathOf = (url) => {
    try { return new URL(url, location.origin).pathname; }
    catch { return ""; }
  };
  const sessionPath = "/api/sessions/" + SESSION_ID;
  // 后台期间的提问：只在 arrive() 之后才出现在 host 状态里（等价于 SSE 漏了那条事件）。
  let pending = [];
  const stateFetches = [];
  window.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input && input.url);
    const path = pathOf(url);
    if (path === sessionPath) {
      await RealFetch(input, init);
      return new Response(JSON.stringify({ context: CONTEXT }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/api/agent/" + SESSION_ID) {
      // 与 /state 同一份事实：这一轮还挂着（正等回答），reconcile 不得收尾。
      return new Response(JSON.stringify({
        live: true,
        activeRun: true,
        lockedByOther: false,
        state: { isPromptRunning: true, pendingExtensionRequests: pending },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === sessionPath + "/state") {
      stateFetches.push({ at: performance.now(), pending: pending.length });
      return new Response(JSON.stringify({
        live: true,
        // activeRun: true = host 里这一轮还挂着（正等回答），reconcile 不会收尾。
        activeRun: true,
        lockedByOther: false,
        state: {
          extensionStatuses: [],
          extensionWidgets: [],
          isStreaming: false,
          isPromptRunning: true,
          pendingExtensionRequests: pending,
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return RealFetch(input, init);
  };
  // SSE 桩：永不投递（后台期间事件丢失）。只让 /events 的连接表现为失败。
  class DeadEventSource {
    constructor(url) {
      this.url = String(url);
      this.readyState = 2;
      this.onmessage = null;
      this.onerror = null;
      setTimeout(() => {
        try { this.onerror && this.onerror(new Event("error")); } catch {}
      }, 0);
    }
    close() { this.readyState = 2; }
  }
  window.EventSource = DeadEventSource;

  window.__extFixture = {
    errors: [],
    arrive() {
      pending = [PROMPT];
      return pending.length;
    },
    tabReturn() {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      return document.visibilityState;
    },
    debug() {
      return { stateFetches };
    },
    capture() {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const text = document.body ? document.body.innerText : "";
      return {
        ok: true,
        stateFetches: stateFetches.length,
        stateFetchesAfterArrive: stateFetches.filter((f) => f.pending > 0).length,
        dialogCount: dialogs.length,
        dialogText: dialogs.map((d) => (d.innerText || "").slice(0, 200)),
        hasPrompt: text.includes(${JSON.stringify(PROMPT_TITLE)}) || text.includes(${JSON.stringify(PROMPT_MESSAGE)}),
        hasInputBar: Boolean(document.querySelector("[data-chat-input], textarea")),
        visibility: document.visibilityState,
      };
    },
  };
})();`;
}

let sessionId = null;
let tempDir = null;
let authCookie = null;

const CONTEXT = {
  messages: [
    { role: "user", content: "EXT_TAB_RETURN_QUESTION 先问一句" },
    { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "EXT_TAB_RETURN_ANSWER 回答" }] },
  ],
  entryIds: ["e-u-1", "e-a-1"],
  thinkingLevel: "off",
  model: { provider: "p", modelId: "m" },
  hasMoreBefore: false,
  totalMessageCount: 2,
};

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "pidance-ext-prompt-"));
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
    await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: AUTH_HEADER,
    }).catch(() => {});
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test("后台期间的提问：切回前台后直接显示提问栏（无需刷新/切会话）", { timeout: 180_000 }, async () => {
  const initScriptPath = join(tempDir, "ext-init.js");
  writeFileSync(initScriptPath, buildInitScript(sessionId, CONTEXT));
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
  await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });
  await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(sessionId)}`, "--session", SESSION], { json: false });

  // 页面就绪：会话已打开、还没有提问
  const deadline = Date.now() + 25_000;
  let snap = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    snap = await evalResult("window.__extFixture ? window.__extFixture.capture() : null");
    if (snap?.ok && snap.hasInputBar) break;
  }
  assert.ok(snap?.ok, `闸门未挂载 ${JSON.stringify(snap)}`);
  assert.equal(snap.hasPrompt, false, `打开时不应已有提问栏 ${JSON.stringify(snap)}`);

  // 后台期间智能体提问（只有 host 状态里有，浏览器端收不到事件）
  const arrived = await evalResult("window.__extFixture.arrive()");
  assert.equal(arrived, 1, "注入待答请求失败");

  // 切回前台：只派发事件，不重载页面、不切会话
  const visibility = await evalResult("window.__extFixture.tabReturn()");
  assert.equal(visibility, "visible", `测试环境页面应处于可见态，实际 ${visibility}`);

  // 有界等待：状态快照回来后提问栏出现
  const waitDeadline = Date.now() + 8_000;
  let after = null;
  while (Date.now() < waitDeadline) {
    after = await evalResult("window.__extFixture.capture()");
    if (after?.hasPrompt) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const debug = await evalResult("window.__extFixture.debug()");
  console.log(`[ext-prompt] stateFetches=${debug?.stateFetches?.length} before=${JSON.stringify(snap)} after=${JSON.stringify(after)}`);
  assert.ok(
    after?.hasPrompt,
    `切回前台后应显示提问栏（未刷新页面）: ${JSON.stringify(after)}`,
  );
  assert.ok(
    (after.dialogText || []).some((text) => text.includes(PROMPT_MESSAGE)),
    `提问栏内容应是待答请求: ${JSON.stringify(after)}`,
  );
});
