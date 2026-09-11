/**
 * 顶栏上下文实时更新验收（真实浏览器 + 真实模型）。
 *
 * 单独成脚本：本用例需要一个干净浏览器会话（会话列表 SWR 缓存 + URL 恢复竞态会
 * 让它在共享回归套件里偶发不挂载聊天区），因此用独立 agent-browser 会话运行。
 *
 * 运行前提：31416 在运行（PIDANCE_TEST_URL）、有可用模型、agent-browser 已安装。
 * 用法：node --test scripts/context-live-regression.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const URL_BASE = process.env.PIDANCE_TEST_URL ?? "http://127.0.0.1:31416";
const PASSWORD = process.env.PIDANCE_TEST_PASSWORD ?? "";
const AUTH_HEADER = PASSWORD ? { Authorization: `Basic ${Buffer.from(`pi:${PASSWORD}`).toString("base64")}` } : {};
const SESSION = "pidance-ctx-regression";

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

/** 页面内登录：检测到密码框则填入密码登录。 */
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

before(async () => {
  await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
  await ensureAuthed();
});

after(async () => {
  await ab(["close", "--session", SESSION], { json: false }).catch(() => {});
});

test("顶栏上下文读数在 run 结束前就已更新", { timeout: 150_000 }, async (t) => {
  // 专用测试会话（cwd 用当前项目：客户端 URL 恢复要求会话属于已知项目，否则聊天区不挂载）。
  // 第一轮带系统提示/工具（约 1%），随后一次大 bash 输出把占用推高约 0.6%，
  // 跨过顶栏 0.1% 的显示精度，使“run 未结束就更新”可被观察。
  const cwd = process.cwd();
  let createdId = null;
  try {
    await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
    await ensureAuthed();
    await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });
    await new Promise((r) => setTimeout(r, 1500));

    const createRes = await fetch(`${URL_BASE}/api/agent/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        cwd,
        type: "prompt",
        // sleep 20 保证 run 足够长（页面打开前不会结束）；seq 的大输出把上下文
        // 推高约 0.6%，跨过顶栏 0.1% 的显示精度。
        message: "请用 bash 工具执行 sleep 20（一次调用），然后执行 seq 1 4000（一次调用），最后一句话总结。",
      }),
    });
    const created = await createRes.json();
    createdId = created?.sessionId ?? null;
    assert.ok(createdId, `测试会话创建失败: ${createRes.status} ${JSON.stringify(created)}`);

    // 客户端 URL 恢复从服务端会话列表里找目标：等它出现在列表里再打开。
    let listed = false;
    for (let i = 0; i < 30 && !listed; i += 1) {
      const res = await fetch(`${URL_BASE}/api/sessions`, { headers: AUTH_HEADER });
      const body = res.ok ? await res.json() : null;
      const items = Array.isArray(body) ? body : body?.sessions ?? body?.data ?? [];
      listed = Array.isArray(items) && items.some((item) => item && (item.id === createdId || item.sessionId === createdId));
      if (!listed) await new Promise((r) => setTimeout(r, 300));
    }
    assert.ok(listed, "测试会话未进入服务端列表，无法打开");

    // CDP Page.navigate 偶发超时（长会话列表 + 运行中会话的负载）：重试一次，
    // 仍失败按环境问题跳过——本用例验证的是「运行中读数更新」，不是导航本身。
    let navigated = true;
    try {
      await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(createdId)}`, "--session", SESSION], { json: false });
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(createdId)}`, "--session", SESSION], { json: false });
      } catch {
        navigated = false;
      }
    }
    if (!navigated) {
      t.skip("浏览器导航超时（CDP Page.navigate），跳过实时上下文验收");
      return;
    }

    // URL 恢复偶发落在列表未就绪的窗口（会话行已在侧栏但不挂载聊天区）；
    // 兜底点一次侧栏行，仍不行则跳过。
    let mounted = false;
    for (let i = 0; i < 10 && !mounted; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      mounted = (await evalResult("!!document.querySelector('[data-pidance-chat=\"true\"]')")) === true;
      if (!mounted) {
        await evalResult(`(() => { const row = document.querySelector('[data-session-id="${createdId}"]'); if (row) row.click(); return true; })()`);
      }
    }
    assert.ok(mounted, "测试会话聊天区未挂载（导航/恢复失败，不是验收通过）");

    const samples = [];
    let seenStreaming = false;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const stateRes = await fetch(`${URL_BASE}/api/agent/${encodeURIComponent(createdId)}?light=1`, { headers: AUTH_HEADER });
      const stateJson = stateRes.ok ? await stateRes.json() : {};
      const streaming = stateJson?.state?.isStreaming === true || stateJson?.state?.isPromptRunning === true;
      const tooltip = await evalResult("document.querySelector('.app-top-bar-stats')?.getAttribute('data-tooltip') ?? null");
      const pct = typeof tooltip === "string" ? Number(/([\d.]+)%/.exec(tooltip)?.[1] ?? NaN) : NaN;
      if (streaming) {
        seenStreaming = true;
        samples.push(pct);
      } else if (seenStreaming) {
        break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    const finite = samples.filter((value) => Number.isFinite(value));
    if (!seenStreaming) {
      t.skip("环境无可用模型或未捕捉到运行窗口，跳过实时上下文验收");
      return;
    }
    assert.ok(finite.length > 0, `运行中顶栏没有上下文读数（${JSON.stringify(await evalResult(`(() => ({ url: location.search, chat: !!document.querySelector('[data-pidance-chat="true"]'), rows: document.querySelectorAll('[data-session-id]').length, hasRow: !!document.querySelector('[data-session-id="${createdId}"]'), hasStats: !!document.querySelector('.app-top-bar-stats'), body: document.body.innerText.slice(0, 200) }))()`))}）`);
    assert.ok(
      Math.max(...finite) > Math.min(...finite),
      `运行中上下文读数未更新（samples=${JSON.stringify(finite)}）`,
    );
  } finally {
    if (createdId) {
      await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(createdId)}`, { method: "DELETE", headers: AUTH_HEADER }).catch(() => {});
    }
  }
});

