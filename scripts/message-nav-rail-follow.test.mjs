/**
 * 左侧用户消息导航条「跟到最后一条」的验收（真实浏览器 + 真实 ChatWindow）。
 *
 * 专用测试会话：ensure_session，不向用户真实会话发消息、不跑真实模型。
 * 页内拦截该会话的 GET /api/sessions/:id（合成 timeline）与 /outline（合成长大纲，
 * 60 条提问，超过导航条 320px 上限），滚动容器用真实 agent-browser 滚动。
 *
 * 两个合成档：
 * - tall：最后一条提问带长过程轮（视口顶部会落在它内部）；
 * - short：每条回答都极短（贴底时视口顶部落在更早的轮次里）。
 *
 * 断言：
 * - 贴底时当前提问必须是最后一条，且最后一格落在导航条可视区内；
 * - 回读旧消息时当前提问跟着阅读位置走，且当前格在可视区内。
 *
 * 导航条只在桌面分叉渲染（isMobile 时为 null），本用例只覆盖桌面。
 * 运行前提：31416、agent-browser。
 * 用法：node --test scripts/message-nav-rail-follow.test.mjs
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
const SESSION = "pidance-nav-rail";
const ORIGIN = new URL(URL_BASE).origin;
const AUTH_COOKIE_NAME = "pidance_ui_session";
const SCROLLER = "[data-chat-scroller='true']";
const QUESTION_COUNT = 60;
const LAST_TURN_PROCESS = 24;
/** 落在加载窗口内的旧提问（尾页窗口从 q32 起）：回读时用它当锚点。 */
const READING_QUESTION_INDEX = 40;

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

/** 合成 timeline + 大纲：60 条提问，问答长度按档位选择。 */
function buildSynthetic(profile) {
  const messages = [];
  const entryIds = [];
  const userMessages = [];
  for (let i = 0; i < QUESTION_COUNT; i += 1) {
    const text = `RAIL_Q_${i} question padding ${"word ".repeat(6)}`;
    messages.push({ role: "user", content: text });
    entryIds.push(`e-u-${i}`);
    userMessages.push({ entryId: `e-u-${i}`, ordinal: i, text });
    const isLast = i === QUESTION_COUNT - 1;
    if (isLast && profile === "tall") {
      for (let p = 0; p < LAST_TURN_PROCESS; p += 1) {
        messages.push({
          role: "assistant",
          provider: "p",
          model: "m",
          content: [
            { type: "thinking", thinking: `RAIL_PROCESS_${p} ${"work ".repeat(30)}` },
            { type: "toolCall", toolCallId: `c${p}`, toolName: "bash", input: { command: "true" } },
          ],
        });
        entryIds.push(`e-p-${p}`);
      }
      messages.push({
        role: "assistant",
        provider: "p",
        model: "m",
        content: [{ type: "text", text: `RAIL_ANSWER final ${"done ".repeat(20)}` }],
      });
      entryIds.push("e-a-last");
    } else {
      messages.push({
        role: "assistant",
        provider: "p",
        model: "m",
        content: [{ type: "text", text: `answer ${i} ${profile === "short" ? "ok" : "ok ".repeat(12)}` }],
      });
      entryIds.push(`e-a-${i}`);
    }
  }
  return {
    context: {
      messages,
      entryIds,
      thinkingLevel: "off",
      model: { provider: "p", modelId: "m" },
      hasMoreBefore: false,
      totalMessageCount: messages.length,
    },
    outline: userMessages,
  };
}

function buildInitScript(sessionId, synthetic) {
  return `(() => {
  const SESSION_ID = ${JSON.stringify(sessionId)};
  const CONTEXT = ${JSON.stringify(synthetic.context)};
  const OUTLINE = ${JSON.stringify(synthetic.outline)};
  const RealFetch = window.fetch.bind(window);
  const pathOf = (url) => {
    try { return new URL(url, location.origin).pathname; }
    catch { return ""; }
  };
  const sessionPath = "/api/sessions/" + SESSION_ID;
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
    if (path === sessionPath + "/outline") {
      return new Response(JSON.stringify({ sessionId: SESSION_ID, userMessages: OUTLINE }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return RealFetch(input, init);
  };
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
  window.__railFixture = {
    errors: [],
    marker(marker) {
      const scroller = document.querySelector("[data-chat-scroller='true']");
      if (!scroller) return { ok: false, reason: "no-scroller" };
      const range = findMarkerRange(scroller, marker);
      if (!range) return { ok: false, reason: "no-marker" };
      const box = scroller.getBoundingClientRect();
      const rect = range.getBoundingClientRect();
      return {
        ok: true,
        offset: rect.top - box.top,
        intersects: rect.bottom > box.top + 1 && rect.top < box.bottom - 1,
      };
    },
    capture() {
      const rail = document.querySelector("[data-message-nav='true']");
      const scroller = document.querySelector("[data-chat-scroller='true']");
      if (!rail) return { ok: false, reason: "no-rail" };
      const dashes = Array.from(rail.querySelectorAll("[data-nav-entry]"));
      if (dashes.length === 0) return { ok: false, reason: "no-dashes" };
      const list = dashes[0].parentElement;
      const listBox = list.getBoundingClientRect();
      const last = dashes[dashes.length - 1];
      const lastBox = last.getBoundingClientRect();
      const boxOf = (el) => {
        const box = el.getBoundingClientRect();
        return { top: box.top - listBox.top, bottom: box.bottom - listBox.top };
      };
      const visible = (el) => {
        const box = boxOf(el);
        return box.top >= -0.5 && box.bottom <= listBox.height + 0.5;
      };
      const activeIdx = dashes.findIndex((d) => d.getAttribute("aria-current") === "true");
      return {
        ok: true,
        n: dashes.length,
        listScrollTop: list.scrollTop,
        listScrollHeight: list.scrollHeight,
        listClientHeight: list.clientHeight,
        listMaxScroll: Math.max(0, list.scrollHeight - list.clientHeight),
        lastBox: boxOf(last),
        lastVisible: visible(last),
        activeVisible: activeIdx >= 0 ? visible(dashes[activeIdx]) : false,
        activeIdx,
        activeEntry: activeIdx >= 0 ? dashes[activeIdx].getAttribute("data-nav-entry") : null,
        lastEntry: last.getAttribute("data-nav-entry"),
        scrollerDistance: scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null,
        scrollerScrollTop: scroller ? scroller.scrollTop : null,
        nEntry: scroller ? scroller.querySelectorAll("[data-message-entry-id]").length : null,
      };
    },
    layout() {
      const rail = document.querySelector("[data-message-nav='true']");
      const dashes = rail ? Array.from(rail.querySelectorAll("[data-nav-entry]")) : [];
      const list = dashes[0] ? dashes[0].parentElement : null;
      if (!list) return { ok: false };
      const box = list.getBoundingClientRect();
      return {
        ok: true,
        hasDash: dashes.length > 0,
        listRect: { top: box.top, bottom: box.bottom, height: box.height },
        listClientHeight: list.clientHeight,
        listScrollHeight: list.scrollHeight,
        overflowY: getComputedStyle(list).overflowY,
        dashHeight: dashes[0] ? dashes[0].getBoundingClientRect().height : null,
      };
    },
  };
})();`;
}

let sessionId = null;
let tempDir = null;
let authCookie = null;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "pidance-nav-rail-"));
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

async function openFixture(profile, width, height) {
  const synthetic = buildSynthetic(profile);
  const initScriptPath = join(tempDir, `rail-init-${profile}-${width}.js`);
  writeFileSync(initScriptPath, buildInitScript(sessionId, synthetic));
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
  const deadline = Date.now() + 25_000;
  let snap = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    snap = await evalResult("window.__railFixture ? window.__railFixture.capture() : null");
    if (snap?.ok && snap.n === synthetic.outline.length) break;
  }
  assert.ok(snap?.ok, `${profile} ${width}×${height}：导航条闸门未挂载 ${JSON.stringify(snap)}`);
  assert.equal(snap.n, synthetic.outline.length, `${profile} ${width}×${height}：导航条格数不对 ${JSON.stringify(snap)}`);
  return snap;
}

async function scrollToBottom(maxSteps = 40) {
  for (let i = 0; i < maxSteps; i += 1) {
    const snap = await evalResult("window.__railFixture.capture()");
    if (snap?.scrollerDistance !== null && snap.scrollerDistance <= 2) return snap;
    await ab(["scroll", "down", "900", "--selector", SCROLLER, "--session", SESSION], { json: false });
    await new Promise((r) => setTimeout(r, 60));
  }
  return evalResult("window.__railFixture.capture()");
}

/** 真滚轮往上，直到目标提问进入视口（不能被后续分页改写阅读位置）。 */
async function scrollMarkerIntoView(marker, maxSteps = 40) {
  for (let i = 0; i < maxSteps; i += 1) {
    const mark = await evalResult(`window.__railFixture.marker(${JSON.stringify(marker)})`);
    if (mark?.ok && mark.intersects && mark.offset > 24) return mark;
    const direction = !mark?.ok || (mark.offset ?? 0) < 24 ? "up" : "down";
    await ab(["scroll", direction, "600", "--selector", SCROLLER, "--session", SESSION], { json: false });
    await new Promise((r) => setTimeout(r, 60));
  }
  return evalResult(`window.__railFixture.marker(${JSON.stringify(marker)})`);
}

/** 等导航条自身滚动动画（420ms）结束。 */
async function settleRail(ms = 1000) {
  await new Promise((r) => setTimeout(r, ms));
  return evalResult("window.__railFixture.capture()");
}

function summary(snap) {
  if (!snap?.ok) return JSON.stringify(snap);
  return JSON.stringify({
    n: snap.n,
    activeIdx: snap.activeIdx,
    activeVisible: snap.activeVisible,
    lastVisible: snap.lastVisible,
    listTop: snap.listScrollTop,
    listMax: snap.listMaxScroll,
    listH: `${snap.listClientHeight}/${snap.listScrollHeight}`,
    dist: snap.scrollerDistance,
  });
}

test("贴底（末轮很长）：导航条把最后一格滚进可视区", { timeout: 180_000 }, async () => {
  await openFixture("tall", 1280, 720);
  const layout = await evalResult("window.__railFixture.layout()");
  const bottom = await scrollToBottom();
  const after = await settleRail();
  console.log(`[nav-rail] tall layout=${JSON.stringify(layout)} bottom=${summary(bottom)} after=${summary(after)}`);
  assert.ok(
    layout?.listScrollHeight > layout?.listClientHeight,
    `导航条自身应可滚动（内容高于轨道）: ${JSON.stringify(layout)}`,
  );
  assert.ok(after.scrollerDistance <= 2, `未能贴底 ${summary(after)}`);
  assert.equal(after.activeIdx, after.n - 1, `贴底时当前项应为最后一条 ${summary(after)}`);
  assert.ok(after.lastVisible, `贴底时最后一格应在导航条可视区内 ${summary(after)}`);
});

test("贴底（末轮很短）：当前提问仍是最后一条", { timeout: 180_000 }, async () => {
  await openFixture("short", 1280, 720);
  await scrollToBottom();
  const after = await settleRail();
  console.log(`[nav-rail] short after=${summary(after)}`);
  assert.ok(after.scrollerDistance <= 2, `未能贴底 ${summary(after)}`);
  assert.equal(after.activeIdx, after.n - 1, `贴底时当前项应为最后一条 ${summary(after)}`);
  assert.ok(after.lastVisible, `贴底时最后一格应在导航条可视区内 ${summary(after)}`);
});

test("回读旧消息：当前格跟着阅读位置，不再停在末尾", { timeout: 180_000 }, async () => {
  await openFixture("tall", 1280, 720);
  await scrollToBottom();
  const mark = await scrollMarkerIntoView(`RAIL_Q_${READING_QUESTION_INDEX}`);
  const after = await settleRail();
  console.log(`[nav-rail] read-old mark=${JSON.stringify(mark)} after=${summary(after)}`);
  assert.ok(mark?.ok && mark.intersects, `未能把旧提问滚进视口 ${JSON.stringify(mark)}`);
  assert.ok(after.scrollerDistance > 200, `应处于阅读态 ${summary(after)}`);
  assert.notEqual(after.activeIdx, after.n - 1, `阅读态当前项不应停在最后一条 ${summary(after)}`);
  assert.ok(
    after.activeIdx >= 0 && Math.abs(after.activeIdx - READING_QUESTION_INDEX) <= 3,
    `阅读态当前项应贴近阅读位置 ${summary(after)}`,
  );
  assert.ok(after.activeVisible, `当前项应在导航条可视区内 ${summary(after)}`);
});
