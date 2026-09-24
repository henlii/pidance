/**
 * #26：固定时间戳 SSE recording 回放验收（真实浏览器 + 真实 ChatWindow）。
 *
 * 把 fixtures/sse-run-recording.json（真实 run 捕获，含中途入队的 follow-up）按原
 * 时间表投给页面的 EventSource 层，让事件走真实链路
 * `BrowserSessionRuntimeRegistry → EventStreamManager → ChatWindow`：
 *   - D2：同一 recording 在 1280×720 与 390×844 回放，最终 timeline 投影一致；
 *   - D3：记录首个/最终 delta 的客户端可见时间，390px 相对桌面额外延迟 ≤250ms。
 *
 * 不 mock 应用代码：只替换测试会话的 `window.EventSource`（agent-browser
 * --init-script，注入脚本由本文件生成），其余请求照常走服务端。
 *
 * 运行前提：31416 在运行（PIDANCE_TEST_URL）、agent-browser 已安装。
 * 用法：node --test scripts/sse-recording-replay.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { clampSchedule, decodeRecording } from "./lib/sse-recording-decode.mjs";

const exec = promisify(execFile);
const URL_BASE = process.env.PIDANCE_TEST_URL ?? "http://127.0.0.1:31416";
/**
 * 31416 有 UI 锁：密码依次取测试环境变量、系统环境、服务端密钥文件
 * （与 chat-scroll-settle-replay / message-nav-rail-follow 同一套，不打印值）。
 */
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
const SESSION = "pidance-sse-replay";
const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sse-run-recording.json");
/** 回放把事件间隔压到 ≤250ms（两端一致）：模型等待时间不该拖长验收。 */
const MAX_GAP_MS = 250;

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

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
  const pwdRef = Object.entries(refs).find(([, i]) => i?.name === "密码")?.[0];
  if (!pwdRef) return;
  await ab(["fill", pwdRef, PASSWORD, "--session", SESSION], { json: false });
  const refs2 = await snapshotRefs();
  const loginRef = Object.entries(refs2).find(([, i]) => i?.role === "button" && i?.name === "登录")?.[0];
  if (loginRef) await ab(["click", loginRef, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 2500));
}

// 录制解码（无损重建，单测见 scripts/lib/sse-recording-decode.test.mjs）：
// 间隔压到 ≤250ms（两端一致），避免模型等待时间拖长验收。
const DECODED = decodeRecording(fixture);
const REPLAY_EVENTS = clampSchedule(DECODED.events, MAX_GAP_MS).map((item) => (
  item.event.type === "message_end"
    ? { ...item, kind: `message_end:${item.event.message?.role ?? "unknown"}` }
    : item
));
const assistantTexts = DECODED.assistantTexts;
const EXPECTED_UPDATES = DECODED.updateCount;
/**
 * 从渲染后的可见文本里挑标记：markdown 渲染会吃掉 `##`/`**` 等记号，标题行在 DOM
 * 里只剩正文，所以只取「纯散文行」的一段，避免与 markdown 语法错位。
 */
function pickMarker(text, fromEnd) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 24 && !/^[#>*\-|`]/.test(line) && !/[`*_\[\]()]/.test(line));
  if (lines.length === 0) return "";
  const line = fromEnd ? lines.at(-1) : lines[0];
  return fromEnd ? line.slice(-24) : line.slice(0, 24);
}

// 最终 delta 的可见时间（#26 A3）用正文尾部标记。
const FINAL_MARKER = pickMarker(assistantTexts.at(-1) ?? "", true);

/** 取正文中段的一段散文（避开思考块常出现的开头草稿），用于「流式可见早于边界」断言。 */
function pickMiddleMarker(text) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 40 && !/^[#>*\-|`]/.test(line) && !/[`*_\[\]()]/.test(line));
  if (lines.length === 0) return "";
  const line = lines[Math.floor(lines.length / 2)];
  const start = Math.floor((line.length - 24) / 2);
  return line.slice(start, start + 24);
}

const STREAM_MARKER = pickMiddleMarker(assistantTexts[0] ?? "");
const FIRST_USER_TEXT = (DECODED.messageEnds.find((item) => item.role === "user") ?? {}).text ?? "";
const FLUSHED_USER_TEXT = (() => {
  const users = DECODED.messageEnds.filter((item) => item.role === "user");
  return users.length > 1 ? users[1].text : "";
})();

/** 生成注入脚本：只替换本测试会话的 EventSource，并记录可见时间。 */
function buildInitScript(sessionId) {
  return `(() => {
  const SESSION_ID = ${JSON.stringify(sessionId)};
  const SCHEDULE = ${JSON.stringify(REPLAY_EVENTS)};
  const FINAL_MARKER = ${JSON.stringify(FINAL_MARKER)};
  const STREAM_MARKER = ${JSON.stringify(STREAM_MARKER)};
  const probe = {
    dispatched: [], streamSeen: null, finalSeen: null, done: false, errors: [],
    // D7：队列投递（follow_up_flushed）之后是否仍保持贴底。
    flushDelivered: false, flushAt: null, scrollerSeen: false, maxOverflow: 0, maxPostFlushDistance: null,
    postFlushSamples: 0, framesAboveThreshold: 0, maxConsecutiveAboveThreshold: 0,
    consecutiveAboveThreshold: 0,
    aboveThresholdFirstAt: null, aboveThresholdLastAt: null, distanceAtLastSample: null,
  };
  /** 贴底容差（px）：超过它即视为「这一帧没跟上」。 */
  const FOLLOW_TOLERANCE = 8;
  window.__sseReplay = probe;

  // 标记比较前去掉所有空白：innerText 与协议文本的换行/缩进不一定逐字相同。
  const normalize = (value) => value.replace(/\s+/g, "");
  const FINAL = normalize(FINAL_MARKER);
  const STREAM = normalize(STREAM_MARKER);
  const scroller = () => document.querySelector('[data-pidance-chat="true"]')?.querySelector('[data-chat-scroller="true"]') ?? null;
  // D2 比的是**消息时间线**投影，必须把底栏排除掉：底栏里的扩展状态（mcp / pi-cache-stats 之类）
  // 是服务端实时状态，本用例又把 EventSource 换成了回放，页面只能靠打开时水合拿到它 ——
  // 于是「桌面页开得早、水合时状态还没注册」会表现成一个与时间线无关的假阳性差异。
  const chatText = () => {
    const el = scroller() ?? document.querySelector('[data-pidance-chat="true"]');
    return normalize(el?.innerText ?? "");
  };
  const tick = () => {
    const text = chatText();
    if (probe.streamSeen === null && STREAM && text.includes(STREAM)) probe.streamSeen = performance.now();
    if (probe.finalSeen === null && FINAL && text.includes(FINAL)) probe.finalSeen = performance.now();
    // D7 采样：队列投递之后每一帧记录「距底距离」的峰值，投递后跟丢会立刻抬起来。
    const el = scroller();
    if (el) {
      probe.scrollerSeen = true;
      const overflow = el.scrollHeight - el.clientHeight;
      if (overflow > probe.maxOverflow) probe.maxOverflow = overflow;
      if (probe.flushAt !== null) {
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        const at = performance.now();
        probe.postFlushSamples += 1;
        probe.distanceAtLastSample = distance;
        if (probe.maxPostFlushDistance === null || distance > probe.maxPostFlushDistance) {
          probe.maxPostFlushDistance = distance;
        }
        if (distance > FOLLOW_TOLERANCE) {
          probe.framesAboveThreshold += 1;
          if (probe.aboveThresholdFirstAt === null) probe.aboveThresholdFirstAt = at - probe.flushAt;
          probe.aboveThresholdLastAt = at - probe.flushAt;
          probe.consecutiveAboveThreshold += 1;
          if (probe.consecutiveAboveThreshold > probe.maxConsecutiveAboveThreshold) {
            probe.maxConsecutiveAboveThreshold = probe.consecutiveAboveThreshold;
          }
        } else {
          probe.consecutiveAboveThreshold = 0;
        }
      }
    }
    if (probe.finalSeen === null && !probe.stopped) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const RealEventSource = window.EventSource;
  class ReplayEventSource {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.onmessage = null;
      this.onerror = null;
      this._timers = [];
      if (!this.url.includes(SESSION_ID)) {
        this.readyState = 2;
        setTimeout(() => { try { this.onerror && this.onerror(new Event("error")); } catch (e) { probe.errors.push(String(e)); } }, 0);
        return;
      }
      this.readyState = 1;
      this._timers.push(setTimeout(() => this._emit({ type: "connected", sessionId: SESSION_ID }), 0));
      for (const item of SCHEDULE) {
        this._timers.push(setTimeout(() => this._emit(item.event, item.kind), item.atMs));
      }
      this._timers.push(setTimeout(() => { probe.done = true; }, (SCHEDULE.at(-1)?.atMs ?? 0) + 100));
    }
    _emit(event, kind) {
      probe.dispatched.push({ type: event.type, kind: kind ?? null, at: performance.now() });
      if (event.type === "follow_up_flushed") {
        probe.flushDelivered = true;
        probe.flushAt = performance.now();
      }
      try { this.onmessage && this.onmessage({ data: JSON.stringify(event) }); }
      catch (e) { probe.errors.push(String(e)); }
    }
    close() {
      this.readyState = 2;
      for (const timer of this._timers) clearTimeout(timer);
      this._timers = [];
    }
  }
  window.EventSource = ReplayEventSource;
  void RealEventSource;
})();`;
}

function chatSnapshotScript() {
  return `(() => {
    const chat = document.querySelector('[data-pidance-chat="true"]');
    return {
      messageCount: Number(chat?.getAttribute('data-chat-message-count') ?? -1),
      entryCount: Number(chat?.getAttribute('data-chat-entry-count') ?? -1),
      entryIds: chat?.getAttribute('data-chat-entry-ids') ?? null,
      // D2 比的是**消息时间线**投影：取滚动容器而不是整个聊天列，把底栏排除掉。
      // 底栏里的扩展状态（mcp / pi-cache-stats 之类）是服务端实时状态，而本用例把
      // EventSource 换成了回放，页面只能靠打开时水合拿到它 —— 桌面页开得早、水合时
      // 状态还没注册，就会表现成一个与时间线无关的假阳性差异。
      text: ((chat?.querySelector('[data-chat-scroller="true"]') ?? chat)?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      probe: (() => {
        const dispatched = window.__sseReplay?.dispatched ?? [];
        const updates = dispatched.filter((item) => item.type === 'message_update');
        return {
          done: window.__sseReplay?.done === true,
          finalSeen: window.__sseReplay?.finalSeen ?? null,
          // 延迟基准是 delta（message_update）本身：最终文本在最后一个 delta 就可见，
          // 其后的 message_end 只是边界事件。
          lastDeltaAt: updates.at(-1)?.at ?? null,
          updateCount: updates.length,
          streamSeen: window.__sseReplay?.streamSeen ?? null,
          flushDelivered: window.__sseReplay?.flushDelivered === true,
          flushAt: window.__sseReplay?.flushAt ?? null,
          scrollerSeen: window.__sseReplay?.scrollerSeen === true,
          maxOverflow: window.__sseReplay?.maxOverflow ?? 0,
          maxPostFlushDistance: window.__sseReplay?.maxPostFlushDistance ?? null,
          postFlushSamples: window.__sseReplay?.postFlushSamples ?? 0,
          framesAboveThreshold: window.__sseReplay?.framesAboveThreshold ?? 0,
          maxConsecutiveAboveThreshold: window.__sseReplay?.maxConsecutiveAboveThreshold ?? 0,
          aboveThresholdFirstAt: window.__sseReplay?.aboveThresholdFirstAt ?? null,
          aboveThresholdLastAt: window.__sseReplay?.aboveThresholdLastAt ?? null,
          distanceAtLastSample: window.__sseReplay?.distanceAtLastSample ?? null,
          messageEnds: dispatched
            .filter((item) => typeof item.kind === 'string' && item.kind.startsWith('message_end:'))
            .map((item) => ({ role: item.kind.slice('message_end:'.length), at: item.at })),
          errors: window.__sseReplay?.errors ?? [],
        };
      })(),
    };
  })()`;
}

const AUTH_COOKIE_NAME = "pidance_ui_session";
const ORIGIN = new URL(URL_BASE).origin;
let sessionId = null;
let initScriptPath = null;
let tempDir = null;
let authCookie = null;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "pidance-sse-replay-"));
  await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
  await ensureAuthed();
  const res = await fetch(`${URL_BASE}/api/agent/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ cwd: process.cwd(), type: "prompt", message: "只回答 OK，不要调用工具。" }),
  });
  const body = await res.json();
  sessionId = body?.sessionId ?? null;
  assert.ok(sessionId, `回放测试会话创建失败: ${res.status} ${JSON.stringify(body)}`);
  initScriptPath = join(tempDir, "replay-init.js");
  writeFileSync(initScriptPath, buildInitScript(sessionId));
  // 会话必须可读且出现在服务端列表里，客户端 ?session= 恢复才能挂载聊天区。
  let listed = false;
  for (let i = 0; i < 40 && !listed; i += 1) {
    const listRes = await fetch(`${URL_BASE}/api/sessions`, { headers: AUTH_HEADER });
    const listBody = listRes.ok ? await listRes.json() : null;
    const items = Array.isArray(listBody) ? listBody : listBody?.sessions ?? listBody?.data ?? [];
    listed = Array.isArray(items) && items.some((item) => item && (item.id === sessionId || item.sessionId === sessionId));
    if (!listed) await new Promise((r) => setTimeout(r, 300));
  }
  assert.ok(listed, "回放测试会话未进入服务端列表");
  // UI 会话 cookie：带 --init-script 的 open 会重启浏览器（cookie 丢失），
  // 回放前用 cookies set 把它注入新浏览器上下文。
  const cookies = await ab(["cookies", "get", "--json", "--session", SESSION]);
  authCookie = cookies?.data?.cookies?.find((cookie) => cookie?.name === AUTH_COOKIE_NAME)?.value ?? null;
  assert.ok(authCookie, "未取得 UI 会话 cookie（页内登录失败？）");
  // 等首轮 run 结束（host dispose），避免真实事件与回放事件混流。
  for (let i = 0; i < 60; i += 1) {
    const stateRes = await fetch(`${URL_BASE}/api/agent/${encodeURIComponent(sessionId)}?light=1`, { headers: AUTH_HEADER });
    const stateBody = stateRes.ok ? await stateRes.json() : {};
    if (stateBody.live !== true && stateBody.activeRun !== true) break;
    await new Promise((r) => setTimeout(r, 500));
  }
});

after(async () => {
  await ab(["close", "--session", SESSION], { json: false }).catch(() => {});
  if (sessionId) {
    await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", headers: AUTH_HEADER }).catch(() => {});
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/** 在指定视口回放一次，返回 timeline 快照与可见时间。 */
async function replayAt(width, height) {
  // 顺序敏感：--init-script 只在浏览器启动时注册，所以先关掉旧浏览器（否则复用
  // 已运行的实例、注入脚本不生效），再带脚本启动 → 注入 UI 会话 cookie → 导航到
  // 会话 URL。页面首次加载即「已认证 + 已挂载注入脚本」。
  await ab(["close", "--session", SESSION], { json: false }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  try {
    await ab(["open", "--init-script", initScriptPath, "--session", SESSION], { json: false });
  } catch {
    // 浏览器刚被关掉时偶发启动竞态：退避后重试一次。
    await new Promise((r) => setTimeout(r, 1500));
    await ab(["open", "--init-script", initScriptPath, "--session", SESSION], { json: false });
  }
  await ab([
    "cookies",
    "set",
    AUTH_COOKIE_NAME,
    authCookie,
    "--url",
    ORIGIN,
    "--httpOnly",
    "--sameSite",
    "Strict",
    "--session",
    SESSION,
  ], { json: false });
  await ab(["set", "viewport", String(width), String(height), "--session", SESSION], { json: false });
  await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(sessionId)}`, "--session", SESSION], { json: false });
  // 聊天区挂载 + 回放完成 + 最终 delta 可见（同一 recording，最长 ~30s）。
  const deadline = Date.now() + 40_000;
  let snapshot = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    snapshot = await evalResult(chatSnapshotScript());
    // 等到「投递完毕」且「最终正文可见」：done 在最后一个事件后一拍才置位。
    if (snapshot?.probe?.done === true && snapshot?.probe?.finalSeen !== null && snapshot?.probe?.finalSeen !== undefined) break;
  }
  assert.ok(snapshot, `视口 ${width}×${height}：无法读取聊天区快照`);
  if (snapshot.messageCount < 0) {
    const diag = await evalResult("(() => ({ url: location.search, probe: !!window.__sseReplay, body: document.body.innerText.slice(0, 160) }))()");
    assert.fail(`视口 ${width}×${height}：聊天区未挂载（会话未打开）${JSON.stringify(diag)}`);
  }
  if (!snapshot.probe.done) {
    const diag = await evalResult("(() => ({ probe: window.__sseReplay ? { dispatched: window.__sseReplay.dispatched.length, errors: window.__sseReplay.errors, done: window.__sseReplay.done } : null, eventSource: String(window.EventSource).slice(0, 60) }))()");
    assert.fail(`视口 ${width}×${height}：回放未完成（probe.done=false）${JSON.stringify(diag)}`);
  }
  assert.deepEqual(snapshot.probe.errors, [], `视口 ${width}×${height}：回放期间页面报错`);
  assert.ok(
    snapshot.probe.finalSeen !== null,
    `视口 ${width}×${height}：最终 delta 未在聊天区可见（updates=${snapshot.probe.updateCount}）`,
  );
  return {
    ...snapshot,
    finalLatency: snapshot.probe.finalSeen - snapshot.probe.lastDeltaAt,
  };
}

test("固定 recording 在桌面与 390px 回放出同一 timeline，且移动端额外延迟 ≤250ms", { timeout: 240_000 }, async () => {
  // 挂载失败是硬失败：本脚本用独立浏览器会话 + 显式注入 UI 会话 cookie，
  // 导航/挂载必须确定性成功，不允许把「没跑起来」记成验收通过。
  const desktop = await replayAt(1280, 720);
  const mobile = await replayAt(390, 844);

  console.log(
    `[sse-replay] desktop ${JSON.stringify(desktop.probe)} mobile ${JSON.stringify(mobile.probe)}`,
  );

  // D1/D2 前提：录制里的每条 delta 都必须真的投递过（此前 text 块首批 delta 被静默丢弃，
  // 两端同样丢数据也会「彼此相等」而通过）。
  assert.equal(desktop.probe.updateCount, EXPECTED_UPDATES, "桌面端投递的 delta 数与录制不一致");
  assert.equal(mobile.probe.updateCount, EXPECTED_UPDATES, "移动端投递的 delta 数与录制不一致");

  // 流式可见必须早于该消息的 message_end 边界（整块在边界才出现＝回放丢帧）。
  const desktopAssistantEnds = desktop.probe.messageEnds.filter((item) => item.role === "assistant");
  assert.ok(desktopAssistantEnds.length >= 2, "录制应包含两轮 assistant 边界");
  assert.ok(
    desktop.probe.streamSeen !== null,
    `第一轮正文在回放结束前不可见（marker=${JSON.stringify(STREAM_MARKER)}）`,
  );
  assert.ok(
    desktop.probe.streamSeen < desktopAssistantEnds[0].at,
    `第一轮正文在该轮 message_end 之后才可见（seen=${desktop.probe.streamSeen} end=${desktopAssistantEnds[0].at}）`,
  );
  assert.ok(
    desktop.probe.finalSeen < desktopAssistantEnds.at(-1).at,
    `最终正文在最后一轮 message_end 之后才可见（seen=${desktop.probe.finalSeen} end=${desktopAssistantEnds.at(-1).at}）`,
  );

  // 队列投递（follow_up_flushed）后的第二轮用户消息必须渲染出来。
  assert.ok(
    desktop.text.includes(FLUSHED_USER_TEXT.slice(0, 12)),
    "队列投递后的用户消息未出现在 timeline",
  );
  assert.ok(desktop.text.includes(FIRST_USER_TEXT.slice(0, 12)), "第一轮用户消息未出现在 timeline");
  // D2：同一 recording → 最终 timeline 投影一致。
  assert.equal(mobile.messageCount, desktop.messageCount, "移动视口改变了 message 数量");
  assert.equal(mobile.entryCount, desktop.entryCount, "移动视口改变了 entryId 数量");
  assert.equal(mobile.entryIds, desktop.entryIds, "移动视口改变了 entryId 投影/顺序");
  assert.ok(desktop.entryIds && desktop.entryIds.split(",").length === desktop.entryCount, "entryId 投影与计数不一致");
  assert.equal(mobile.text, desktop.text, "移动视口改变了可见 timeline 文本");
  assert.ok(desktop.text.replace(/\s+/g, "").includes(FINAL_MARKER.replace(/\s+/g, "")), "桌面端未渲染最终 delta 文本");

  // D3：客户端可见时间差（390px 相对桌面）≤250ms。
  assert.ok(desktop.probe.updateCount > 0 && desktop.probe.updateCount === mobile.probe.updateCount, "回放 delta 数量不一致");
  assert.ok(
    desktop.finalLatency >= 0 && mobile.finalLatency >= 0,
    `延迟测量出现负值（desktop=${desktop.finalLatency}；mobile=${mobile.finalLatency}）`,
  );
  const extraFinal = mobile.finalLatency - desktop.finalLatency;
  console.log(
    `[sse-replay] 最终 delta 客户端可见延迟 desktop=${desktop.finalLatency.toFixed(1)}ms `
    + `mobile=${mobile.finalLatency.toFixed(1)}ms extra=${extraFinal.toFixed(1)}ms`,
  );
  assert.ok(extraFinal <= 250, `390px 最终 delta 额外客户端延迟 ${extraFinal.toFixed(1)}ms > 250ms`);

  // ── #28 D7：队列投递（follow_up_flushed）之后不得丢失跟随 ─────────────────────
  // 这条断言原先是 `if (pinned && pinned.overflow > 40) assert(...)`：滚动容器没找到、
  // 内容没撑出滚动条、或录制里压根没有队列投递时，三种情况都会静默跳过 —— 等于空转。
  // 现在把「前提」本身变成断言：投递确实发生、容器确实存在、内容确实超出，再判距离。
  for (const [name, run] of [["desktop", desktop], ["mobile", mobile]]) {
    assert.equal(
      run.probe.flushDelivered,
      true,
      `${name}：录制里的 follow_up_flushed 没有被投递（D7 断言会空转）`,
    );
    assert.equal(
      run.probe.scrollerSeen,
      true,
      `${name}：回放期间没有找到 [data-chat-scroller]（滚动断言无法成立）`,
    );
    assert.ok(
      run.probe.maxOverflow > 40,
      `${name}：聊天区始终没有可滚动内容（最大 overflow=${run.probe.maxOverflow}px），贴底断言会空转`,
    );
    assert.ok(
      run.probe.postFlushSamples >= 20,
      `${name}：队列投递后只采样到 ${run.probe.postFlushSamples} 帧，贴底判定会空转`,
    );
    console.log(
      `[sse-replay] ${name} 队列投递 ${run.probe.flushAt?.toFixed?.(0) ?? run.probe.flushAt}ms `
      + `投递后距底峰值 ${run.probe.maxPostFlushDistance}px（overflow 峰值 ${run.probe.maxOverflow}px）| `
      + `采样 ${run.probe.postFlushSamples} 帧，超容差 ${run.probe.framesAboveThreshold} 帧，`
      + `最长连续 ${run.probe.maxConsecutiveAboveThreshold} 帧，`
      + `首次 ${run.probe.aboveThresholdFirstAt?.toFixed?.(0)}ms → 末次 ${run.probe.aboveThresholdLastAt?.toFixed?.(0)}ms，`
      + `末帧距底 ${run.probe.distanceAtLastSample}px`,
    );
    // 「跟丢」的定义是**持续**离开底部：内容追加后允许 1–2 帧的追赶（实测最长连续 2 帧，
    // 峰值 182/240px 都在这两帧内被追平），但连续超过 4 帧（≈66ms）就是丢跟随了。
    assert.ok(
      run.probe.maxConsecutiveAboveThreshold <= 4,
      `${name}：队列投递后持续离开底部（最长连续 ${run.probe.maxConsecutiveAboveThreshold} 帧距底 >8px）`,
    );
    assert.ok(
      run.probe.distanceAtLastSample !== null && run.probe.distanceAtLastSample <= 8,
      `${name}：队列投递后直到回放结束都没回到贴底（末次采样距底 ${run.probe.distanceAtLastSample}px）`,
    );
  }

  // 收尾仍要贴底：投递后的新一轮正文全部到达时不能停在半路。
  const pinned = await evalResult(`(() => {
    const scroller = document.querySelector('[data-pidance-chat="true"]')?.querySelector('[data-chat-scroller="true"]') ?? null;
    if (!scroller) return null;
    return { distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight, overflow: scroller.scrollHeight - scroller.clientHeight };
  })()`);
  console.log(`[sse-replay] scroll ${JSON.stringify(pinned)}`);
  assert.ok(pinned, "回放结束时找不到聊天区滚动容器（#28 D7 断言无法成立）");
  assert.ok(
    pinned.distance <= 8,
    `流式/队列投递后聊天区未保持在底部（距底 ${pinned.distance}px，overflow ${pinned.overflow}px）`,
  );
});
