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
        // 时长要覆盖「上滚释放 + 冷挂载读数」两个阶段：先跑一次长 sleep（首个 step
        // 立刻结束，服务端随即有吞吐读数），再补几轮短命令把 run 拉长。
        // 尾部再补一次长 sleep：这条用例最后一步是「run 进行中冷挂载并立刻读速度」，
        // 挂载要等前面的上滚/释放阶段跑完（约 50s）才开始，run 必须那时仍在跑。
        message: "请用 bash 工具执行 seq 1 4000（一次调用），然后用 bash 工具执行 sleep 40（一次调用），然后用 bash 工具执行 echo a（一次调用），最后用 bash 工具执行 sleep 30（一次调用），最后一句话总结。",
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
    // 等待窗口放宽到 20s，并允许一次重新导航：会话列表 SWR 与 URL 恢复的竞态在负载高时会超过
    // 原先的 5s（仓库 #64 与本文件顶部说明都记过）。这里**不**把「页面还没加载完」判成产品失败——
    // 真挂不上就跳过（本文件原本就是这个口径）。
    let mounted = false;
    for (let round = 0; round < 3 && !mounted; round += 1) {
      if (round > 0) {
        await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(createdId)}`, "--session", SESSION], { json: false }).catch(() => {});
        // 重新导航后可能落回登录闸门（cookie 与会话恢复的时序），再登一次。
        await ensureAuthed();
      }
      for (let i = 0; i < 40 && !mounted; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        mounted = (await evalResult("!!document.querySelector('[data-pidance-chat=\"true\"]')")) === true;
        if (!mounted) {
          await evalResult(`(() => { const row = document.querySelector('[data-session-id="${createdId}"]'); if (row) row.click(); return true; })()`);
        }
      }
    }
    if (!mounted) {
      t.skip("聊天区未挂载（会话列表 SWR × URL 恢复竞态，非本用例验收目标）");
      return;
    }

    // 「上滚位置保持」需要一个真的滚得起来的页面，而它取决于模型这次输出多长：工具块有 320px 上限 +
    // 内部滚动，1280×720 下整段对话可能正好放得下（overflow=0），此时「上滚」这个前提根本不成立。
    // 先把视口压矮，让可滚动成为确定条件；下面所有滚动测量都在这个尺寸下进行。
    await ab(["set", "viewport", "1280", "420", "--session", SESSION], false).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    let initialOverflow = 0;
    for (let i = 0; i < 16; i += 1) {
      const sample = await evalResult(`(() => {
        const scroller = document.querySelector('[data-pidance-chat="true"]')?.querySelector('[data-chat-scroller="true"]');
        if (!scroller) return null;
        return scroller.scrollHeight - scroller.clientHeight;
      })()`);
      if (typeof sample === "number") initialOverflow = sample;
      if (initialOverflow > 120) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(initialOverflow > 120, `压矮视口后仍不可滚动（overflow=${initialOverflow}），无法验证上滚释放`);

    // #28：用户上滚意图（wheel 向上）后，自动跟随必须释放，不得把视图抢回底部。
    // 用真实 wheel 事件走 useChatAutoFollow 的释放路径；随后继续流式，检查滚动位置。
    const scrollIntent = await evalResult(`(() => {
      const scroller = document.querySelector('[data-pidance-chat="true"]')?.querySelector('[data-chat-scroller="true"]');
      if (!scroller) return null;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true }));
      return { overflow: scroller.scrollHeight - scroller.clientHeight };
    })()`);
    assert.ok(scrollIntent, "未找到聊天滚动容器，无法验证上滚意图");

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

    // 流式继续输出后，用户上滚的位置必须保持（未被自动跟随抢回底部）。
    const released = await evalResult(`(() => {
      const scroller = document.querySelector('[data-pidance-chat="true"]')?.querySelector('[data-chat-scroller="true"]');
      if (!scroller) return null;
      return {
        distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        overflow: scroller.scrollHeight - scroller.clientHeight,
        jumpVisible: !!document.querySelector('.chat-jump-bottom.is-visible'),
      };
    })()`);
    assert.ok(released, "未找到聊天滚动容器");
    assert.ok(
      released.distance > 40,
      `用户上滚后被自动跟随抢回底部（距底 ${released.distance}px）`,
    );

    // 刷新/冷挂载（手机后台被回收后回来）：本 run 的完整读数只有服务端有，
    // 顶栏必须靠服务端下发的 turn metrics 立刻给出速度，而不是等下一个完整 step。
    const stateRes = await fetch(`${URL_BASE}/api/agent/${encodeURIComponent(createdId)}?light=1`, { headers: AUTH_HEADER });
    const stateJson = stateRes.ok ? await stateRes.json() : {};
    assert.equal(stateJson?.live, true, "重新加载前 run 已结束，无法验证冷挂载读数（请放宽 prompt 时长）");
    await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(createdId)}`, "--session", SESSION], { json: false });
    let seeded = null;
    for (let i = 0; i < 20 && !seeded; i += 1) {
      await new Promise((r) => setTimeout(r, 700));
      const tip = await evalResult("document.querySelector('.app-top-bar-stats')?.getAttribute('data-tooltip') ?? null");
      if (typeof tip === "string" && tip.includes("词元/秒")) seeded = tip;
    }
    assert.ok(seeded, "冷挂载后顶栏没有恢复本 run 的速度读数（服务端 turn metrics 未接上）");
  } finally {
    if (createdId) {
      await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(createdId)}`, { method: "DELETE", headers: AUTH_HEADER }).catch(() => {});
    }
  }
});

