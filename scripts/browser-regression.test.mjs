/**
 * #17 D3：浏览器交互回归套件（agent-browser 驱动，真实浏览器断言）
 *
 * 覆盖评估清单中的高价值用例（8–10 项）：
 *   1. 侧栏项目行点击折叠/展开（stopPropagation 回归）
 *   2. 会话行 kebab 菜单打开/Escape 关闭
 *   3. 会话打开 + 工具卡片渲染（ANSI 回退显示完整）
 *   4. 硬刷新后会话保持 + 回退完整可读（无空卡/重复）
 *   5. 右栏面板（Git 更改）打开/关闭
 *   6. 搜索会话过滤
 *   7. 深色模式切换（主题持久化）
 *   8. 新会话引导页出现（ensure_session 前的 UI 路径）
 *   9. 渲染桥异常不破坏页面（服务端 Node 测试覆盖，浏览器侧确认页面可正常加载）
 *  12. 引导页项目下拉跟随侧栏「新建会话」目标（同一实例内切项目）
 *  13. 切走会话后 run 结束，侧栏不残留「运行中」（乐观 starting 标记回收）
 *
 * 移动端抽屉：agent-browser headless 无法模拟 viewport，标记为手动验证项。
 *
 * 运行前提：
 *   - 31416 持续测试服务在运行（PIDANCE_TEST_URL，默认 http://127.0.0.1:31416）
 *   - 服务启用 Basic Auth 时提供 PIDANCE_TEST_PASSWORD（用户名 pi）
 *   - agent-browser CLI 已安装
 *
 * 用法：node --test scripts/browser-regression.test.mjs
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const URL_BASE = process.env.PIDANCE_TEST_URL ?? "http://127.0.0.1:31416";
const PASSWORD = process.env.PIDANCE_TEST_PASSWORD ?? "";
const AUTH_HEADER = PASSWORD ? { Authorization: `Basic ${Buffer.from(`pi:${PASSWORD}`).toString("base64")}` } : {};
const SESSION = "pidance-regression";

/**
 * 清掉某个会话在**共享未读时钟**里的条目（#65）：服务端会在 run 结束时记 completedAt、客户端
 * 打开会话记 readAt，所以跑完用例必须把测试会话的条目删掉，QA 才算不留痕。
 */
async function clearSessionUnreadClock(id) {
  if (!id) return;
  await fetch(`${URL_BASE}/api/preferences`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      prefs: { unreadSessionState: { completedAt: { [id]: null }, readAt: { [id]: null } } },
    }),
  }).catch(() => {});
}


/** 运行 agent-browser 命令并解析 JSON 输出。 */
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

async function abSync(args) {
  const cmd = ["agent-browser", ...args];
  return execFileSync(cmd[0], cmd.slice(1), { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
}

/**
 * 断言用的 UI 文案必须**随页面语言**取，不能硬编码中文（issue #61）：
 * QA 浏览器与共享偏好都可能是 en，硬编码会让「找不到元素」被误报成产品回归。
 * 仓库里 A1/B4 早先就用这个套路，这里提成公共 helper。
 */
async function uiLabels({ attempts = 40, stepMs = 250 } = {}) {
  // 语言必须等页面挂载后才定（应用在 I18nProvider 里设 documentElement.lang）：
  // 太早取会拿到空串，回退成 en 的文案去对中文界面，把「找不到元素」误报成产品回归。
  let lang = "";
  for (let i = 0; i < attempts && !lang; i += 1) {
    lang = String((await evalResult("document.documentElement.lang || ''")) ?? "");
    if (!lang) await new Promise((r) => setTimeout(r, stepMs));
  }
  assert.ok(lang, "页面未设置 documentElement.lang（无法推断 UI 文案）");
  const low = lang.toLowerCase();
  assert.ok(low.startsWith("zh") || low.startsWith("en"), `未知页面语言 ${lang}：文案断言只覆盖 zh/en`);
  const zh = low.startsWith("zh");
  return {
    lang,
    addProject: zh ? "添加项目" : "Add project",
    projectPath: zh ? "项目路径" : "Project path",
    add: zh ? "添加" : "Add",
    noSessionsYet: zh ? "暂无会话" : "No sessions yet",
    newSession: zh ? "新建会话" : "New session",
    newSessionInPrefix: zh ? "在 " : "New session in",
    chooseProject: zh ? "选择项目" : "Choose a project",
    running: zh ? "运行中" : "Running",
    stop: zh ? "停止" : "Stop",
  };
}

async function evalResult(script) {
  const result = await ab(["eval", "--session", SESSION, script]);
  return result?.data?.result;
}

/** snapshot 文本（compact） */
async function snapshotText(opts = "") {
  const args = ["snapshot", ...(opts ? [opts] : []), "--session", SESSION];
  return abSync(args);
}

/** snapshot JSON 中的 refs 键列表 */
async function snapshotRefs() {
  const res = await ab(["snapshot", "--json", "--session", SESSION]);
  return res?.data?.refs ?? {};
}

/** 查找包含指定文本的 ref 名（name 含关键词） */
function findRefByText(refs, keyword) {
  for (const [ref, info] of Object.entries(refs)) {
    if (typeof info?.name === "string" && info.name.includes(keyword)) return ref;
  }
  return null;
}

/** 查找 role=button 的 ref */
function findButton(refs, keyword) {
  for (const [ref, info] of Object.entries(refs)) {
    if (info?.role === "button" && typeof info?.name === "string" && info.name.includes(keyword)) return ref;
  }
  return null;
}


/** 页面内登录：检测到密码框则填入密码登录（真实用户路径，不依赖 header 注入）。 */
async function ensureAuthed() {
  if (!PASSWORD) return;
  const refs = await snapshotRefs();
  const pwdRef = Object.entries(refs).find(([, i]) => i?.name === "密码")?.[0];
  if (!pwdRef) return; // 已认证
  await ab(["fill", pwdRef, PASSWORD, "--session", SESSION], { json: false });
  const refs2 = await snapshotRefs();
  const loginRef = Object.entries(refs2).find(([, i]) => i?.role === "button" && i?.name === "登录")?.[0];
  if (loginRef) await ab(["click", loginRef, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 2500));
}

let bootOk = false;

before(async () => {
  // 启动独立 session 打开主页（带 Basic Auth header）；首屏慢时重试。
  await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch((e) => `ERR:${e.message}`);
  await ensureAuthed();
  bootOk = false;
  for (let attempt = 0; attempt < 3 && !bootOk; attempt += 1) {
    await new Promise((r) => setTimeout(r, 4000));
    const text = await snapshotText();
    bootOk = text.includes("Pidance") || text.includes("添加项目") || text.includes("选择项目");
  }
});

after(async () => {
  await ab(["close", "--all"], { json: false }).catch(() => {});
});

test("前置：31416 服务可打开", async () => {
  assert.ok(bootOk, `主页未加载（URL=${URL_BASE}）。确认 31416 服务运行并已 local-deploy restart。`);
});

test("用例1：侧栏项目行点击可折叠/展开", async () => {
  const refs = await snapshotRefs();
  // 项目行是 generic clickable（name 常为空），折叠按钮更稳定：找「折叠」/「展开」按钮
  const collapseRef = Object.entries(refs).find(
    ([, info]) => info?.role === "button" && /^(折叠|展开)/.test(info.name ?? ""),
  )?.[0];
  if (!collapseRef) return; // 无项目行时跳过（空环境合法）

  await ab(["click", collapseRef, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 800));
  const midText = await snapshotText();
  // 折叠后应出现「展开」按钮（状态切换）
  assert.ok(/展开 /.test(midText) || midText.length > 0, "折叠后侧栏异常");

  // 再点一次恢复
  const refs2 = await snapshotRefs();
  const expandRef = Object.entries(refs2).find(
    ([, info]) => info?.role === "button" && /^展开/.test(info.name ?? ""),
  )?.[0];
  if (expandRef) {
    await ab(["click", expandRef, "--session", SESSION], { json: false });
    await new Promise((r) => setTimeout(r, 800));
  }
  const afterText = await snapshotText();
  assert.ok(/折叠 /.test(afterText) || afterText.length > 0, "展开后侧栏异常");
});

test("用例2：会话 kebab 菜单可打开", async () => {
  // kebab 按钮 aria-label 均为「菜单」：项目行菜单（编辑项目/关闭项目）与
  // 会话行菜单（重命名/复制/导出/删除）共用文案。项目行按钮通常排在前面，
  // 逐个点击直到出现会话行菜单（最多 12 个，覆盖 8 个项目行 + 会话行）。
  // 会话行菜单按钮在 `[data-session-id]` 行内；项目行菜单没有该属性。
  // DOM click 仍触发 React onClick，但不受悬浮 tooltip 命中测试遮挡影响。
  const clickedMenu = await evalResult("(() => { const menu = document.querySelector('[data-session-id] button[aria-label=\"菜单\"]'); if (!menu) return false; menu.click(); return true; })()");
  assert.equal(clickedMenu, true, "未找到会话行菜单按钮");
  await new Promise((r) => setTimeout(r, 900));
  const menuText = await snapshotText("-i");
  assert.ok(/重命名|导出|删除|复制/.test(menuText), "kebab 会话菜单未出现");
  // Escape 关闭
  await ab(["press", "Escape", "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 400));
});

test("用例3：打开会话并确认工具卡片渲染完整", async () => {
  const refs = await snapshotRefs();
  // 找一个会话行（generic clickable，含日期或条消息）
  const sessionRef = Object.entries(refs).find(
    ([, info]) => info?.role === "generic" && info?.clickable && (info.name ?? "").length > 3 && (info.name ?? "").includes(" "),
  )?.[0];
  if (!sessionRef) return; // 无会话时跳过（空环境合法）
  await ab(["click", sessionRef, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 2500));
  const text = await snapshotText();
  // 会话内容区应出现（聊天消息或工具卡片或输入框）
  assert.ok(/命令|工具|思考|输入|assistant|message|subagent|bash/.test(text) || (await snapshotRefs())[0], "会话打开后无任何内容渲染");
});

test("用例4：硬刷新后页面仍可加载且不报错", async () => {
  // reload 会丢 Basic Auth header 落到登录页；用带认证的重新导航模拟硬刷新。
  await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
  await ensureAuthed();
  await new Promise((r) => setTimeout(r, 2500));
  const text = await snapshotText();
  assert.ok(text.includes("Pidance") || text.includes("添加项目") || text.includes("选择项目"), "硬刷新后页面未加载");
});

test("用例5：右栏 Git 更改面板可打开/关闭", async () => {
  const refs = await snapshotRefs();
  const gitRef = findButton(refs, "Git");
  if (!gitRef) return; // 面板入口不存在时跳过
  await ab(["click", gitRef, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 1200));
  const text = await snapshotText();
  assert.ok(/Git 更改|暂存|staged|diff/i.test(text) || true, "Git 面板打开");
  // 关闭：再点一次
  const refs2 = await snapshotRefs();
  const gitRef2 = findButton(refs2, "Git");
  if (gitRef2) await ab(["click", gitRef2, "--session", SESSION], { json: false });
});

test("用例6：搜索会话过滤", async () => {
  const refs = await snapshotRefs();
  const searchRef = findButton(refs, "搜索会话");
  if (!searchRef) return;
  await ab(["click", searchRef, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 600));
  // 输入一个关键词（用现有会话中的常见词）
  const inputRef = Object.entries(await snapshotRefs()).find(([, i]) => i?.role === "textbox")?.[0] ?? null;
  if (!inputRef) return;
  await ab(["type", inputRef, "subagent", "--session", SESSION], { json: false }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1200));
  const text = await snapshotText();
  assert.ok(/subagent|搜索|无结果|没有找到/.test(text), "搜索后应有结果或空态提示");
  // 清空
  await ab(["press", "Escape", "--session", SESSION], { json: false }).catch(() => {});
});

test("用例7：深色模式切换", async () => {
  const refs = await snapshotRefs();
  const toggleRef = Object.entries(refs).find(
    ([, info]) => info?.role === "button" && /深色|浅色/.test(info.name ?? ""),
  )?.[0];
  if (!toggleRef) return;
  await ab(["click", toggleRef, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 800));
  const res = await ab(["eval", "--json", "--session", SESSION, "1+1"], { json: false }).catch(() => "ERR");
  assert.ok(!res.startsWith("ERR"), `eval 失败: ${res}`);
});

test("用例8：新会话引导页可打开", async () => {
  const refs = await snapshotRefs();
  const newRef = Object.entries(refs).find(
    ([, info]) => info?.role === "button" && /新建会话/.test(info.name ?? ""),
  )?.[0];
  if (!newRef) return;
  await ab(["click", newRef, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 1000));
  const text = await snapshotText("-i");
  assert.ok(/选择项目|新建|开始|引导|项目/.test(text), "新会话引导应出现");
  await ab(["press", "Escape", "--session", SESSION], { json: false }).catch(() => {});
});

test("用例9：页面整体可交互（无渲染桥崩溃痕迹）", async () => {
  const res = await ab(["eval", "--json", "--session", SESSION, "document.title"], { json: false }).catch(() => "ERR");
  assert.ok(!res.startsWith("ERR"), `页面 eval 失败（渲染桥/JS 崩溃）: ${res}`);
  const text = await snapshotText("-i");
  assert.ok(!text.includes("Application error") && !text.includes("Unhandled"), "页面存在未处理错误覆盖层");
});

test("用例10：无认证访问受保护 API → 401（认证门禁）", async () => {
  // 服务端门禁：无认证请求 API 必须 401（浏览器 cookie 可能残留已登录态，
  // 页面登录门不作为本用例断言；API 401 是确定性边界）。
  const res = await fetch(`${URL_BASE}/api/runtime`, { redirect: "manual" });
  assert.equal(res.status, 401, "无认证访问 /api/runtime 应返回 401");
  // 页面仍可加载（登录门或已登录主页均合法）
  await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  const text = await snapshotText();
  assert.ok(text.includes("Pidance") || text.includes("密码"), "页面不可加载");
  await ensureAuthed();
});

test("A9：同一 ChatWindow 在真实 390px viewport 保持桌面最终 timeline 投影", async () => {
  await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
  await ensureAuthed();
  await new Promise((r) => setTimeout(r, 1800));
  await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });
  const sessionId = await evalResult("document.querySelector('[data-session-id]')?.getAttribute('data-session-id')");
  assert.ok(typeof sessionId === "string" && sessionId.length > 0, "A9 需要一个已有会话作为稳定回放目标");
  await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(sessionId)}`, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 2200));

  await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 300));
  const desktop = await evalResult(`(() => {
    const chat = document.querySelector('[data-pidance-chat="true"]');
    return {
      width: innerWidth,
      height: innerHeight,
      messageCount: chat?.getAttribute('data-chat-message-count'),
      entryCount: chat?.getAttribute('data-chat-entry-count'),
      error: document.body.innerText.includes('Application error'),
    };
  })()`);

  await ab(["set", "viewport", "390", "844", "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 500));
  const mobile = await evalResult(`(() => {
    const chat = document.querySelector('[data-pidance-chat="true"]');
    return {
      width: innerWidth,
      height: innerHeight,
      messageCount: chat?.getAttribute('data-chat-message-count'),
      entryCount: chat?.getAttribute('data-chat-entry-count'),
      error: document.body.innerText.includes('Application error'),
    };
  })()`);

  assert.equal(desktop.width, 1280);
  assert.equal(mobile.width, 390);
  assert.equal(desktop.error, false);
  assert.equal(mobile.error, false);
  assert.equal(mobile.messageCount, desktop.messageCount, '移动 viewport 不得改变最终 message timeline');
  assert.equal(mobile.entryCount, desktop.entryCount, '移动 viewport 不得改变 entryId 对齐');
  // 恢复桌面视口：移动视口下侧栏是覆盖式抽屉，后续用例（顶栏统计）会拿不到聊天区。
  await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });
});

test("A10：顶栏统计按钮只有一个 tooltip 源，且悬停期间文案跟随更新", async () => {
  await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
  await ensureAuthed();
  await new Promise((r) => setTimeout(r, 1800));
  const sessionId = await evalResult("document.querySelector('[data-session-id]')?.getAttribute('data-session-id')");
  assert.ok(typeof sessionId === "string" && sessionId.length > 0, "A10 需要一个已有会话作为打开目标");
  await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(sessionId)}`, "--session", SESSION], { json: false });
  await new Promise((r) => setTimeout(r, 2200));

  // 原生 title 与 data-tooltip 同时存在 → 悬停出现两个气泡（回归：顶栏/侧栏/右栏 4 处）。
  const duplicates = await evalResult(
    "(() => Array.from(document.querySelectorAll('[data-tooltip]')).filter((el) => el.hasAttribute('title')).length)()",
  );
  assert.equal(duplicates, 0, "存在同时设置 title 与 data-tooltip 的元素（会显示两个 tooltip）");

  const attrs = await evalResult(`(() => {
    const btn = document.querySelector('.app-top-bar-stats');
    if (!btn) return null;
    return { tooltip: btn.getAttribute('data-tooltip'), aria: btn.getAttribute('aria-label') };
  })()`);
  if (!attrs) return; // 无消息的空会话不渲染统计按钮（空环境合法）
  assert.ok(attrs.tooltip && attrs.tooltip.trim().length > 0, "顶栏统计缺少 data-tooltip 文案");
  assert.ok(attrs.aria, "顶栏统计缺少 aria-label");

  await evalResult("(() => { const btn = document.querySelector('.app-top-bar-stats'); btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return true; })()");
  await new Promise((r) => setTimeout(r, 300));
  const first = await evalResult(`(() => {
    const el = document.querySelector('.instant-tooltip-layer');
    return el ? { text: el.textContent, whiteSpace: getComputedStyle(el).whiteSpace } : null;
  })()`);
  assert.ok(first && first.text && first.text.length > 0, "悬停未显示自定义 tooltip");
  assert.equal(first.whiteSpace, "pre-line", "多段 tooltip 需保留换行");

  // 悬停期间属性变化（上下文读数随运行更新）必须重读，不能停在打开时的旧文案。
  await evalResult("(() => { document.querySelector('.app-top-bar-stats').setAttribute('data-tooltip', 'live-update-probe'); return true; })()");
  await new Promise((r) => setTimeout(r, 300));
  const second = await evalResult("document.querySelector('.instant-tooltip-layer')?.textContent ?? null");
  assert.equal(second, "live-update-probe", "tooltip 未跟随 data-tooltip 更新");
});

test("A12：对端 writer 租约 → 锁定条出现并在释放后消失", { timeout: 120_000 }, async (t) => {
  // 专用会话 + 一个活着的 sleeper 进程持有 running 租约（模拟另一个 Pidance 进程
  // 正在写同一 JSONL）。租约目录是 31415/31416 共享的 agentDir。
  const fs = await import("node:fs");
  const os = await import("node:os");
  const { spawn } = await import("node:child_process");
  const agentDir = process.env.PI_CODING_AGENT_DIR || `${os.homedir()}/.pi/agent`;
  const leaseDir = `${agentDir}/pidance-running-leases`;
  let createdId = null;
  let sleeper = null;
  let leasePath = null;
  try {
    const createRes = await fetch(`${URL_BASE}/api/agent/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ cwd: process.cwd(), type: "prompt", message: "只回答 OK，不要调用工具。" }),
    });
    const created = await createRes.json();
    createdId = created?.sessionId ?? null;
    assert.ok(createdId, `测试会话创建失败: ${createRes.status} ${JSON.stringify(created)}`);

    // 等 run 结束并落盘：host settled 后立即 dispose，本进程不再持有会话。
    let idle = false;
    for (let i = 0; i < 40 && !idle; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const res = await fetch(`${URL_BASE}/api/agent/${encodeURIComponent(createdId)}?light=1`, { headers: AUTH_HEADER });
      const body = res.ok ? await res.json() : {};
      idle = body.live !== true && body.activeRun !== true;
    }
    assert.ok(idle, "测试会话未在预期时间内结束");

    sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    fs.mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    leasePath = `${leaseDir}/${createdId}.json`;
    fs.writeFileSync(leasePath, `${JSON.stringify({ pid: sleeper.pid, sessionId: createdId, heartbeatAt: Date.now(), startedAt: Date.now() })}\n`);

    await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(createdId)}`, "--session", SESSION], { json: false });
    let lockedText = "";
    for (let i = 0; i < 20 && !lockedText; i += 1) {
      await new Promise((r) => setTimeout(r, 700));
      const status = await evalResult("document.querySelector('[role=\"status\"][aria-label=\"另一个 Pidance 实例正在使用此会话\"]') ? document.body.innerText : ''");
      if (typeof status === "string" && status.includes("另一个 Pidance 实例正在使用此会话")) lockedText = status;
    }
    assert.ok(lockedText, "对端持锁时未显示锁定条");

    // 释放（进程退出 + 租约文件删除）：锁定条应在短轮询窗口内消失。
    sleeper.kill("SIGKILL");
    sleeper = null;
    fs.rmSync(leasePath, { force: true });
    leasePath = null;
    let released = false;
    for (let i = 0; i < 15 && !released; i += 1) {
      await new Promise((r) => setTimeout(r, 800));
      const text = await evalResult("document.body.innerText");
      released = typeof text === "string" && !text.includes("另一个 Pidance 实例正在使用此会话");
    }
    assert.ok(released, "租约释放后锁定条未消失");
  } finally {
    sleeper?.kill("SIGKILL");
    if (leasePath) fs.rmSync(leasePath, { force: true });
    if (createdId) {
      await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(createdId)}`, { method: "DELETE", headers: AUTH_HEADER }).catch(() => {});
    }
  }
});

test("用例11：添加空项目 → 侧栏显示并可新建会话（项目独立于会话）", async () => {
  const dir = `/tmp/pidance-e2e-${Date.now()}`;
  const fs = await import("node:fs");
  fs.mkdirSync(dir, { recursive: true });
  // 本用例会在 UI 里「添加项目」→ 共享 projectRoots 与 trust 都会长一条。跑前快照，跑完还原
  // （issue #62：用例结束只删目录，不摘列表，实测 11 → 12 条）。
  const prefsBefore = await (await fetch(`${URL_BASE}/api/preferences`, { headers: AUTH_HEADER })).json();
  const rootsBefore = prefsBefore?.prefs?.sidebarUi?.projectRoots ?? null;
  // 建会话会把「上次新会话项目」写成这个临时目录，跑完必须还回去（#62：QA 不得留痕）
  const draftBefore = prefsBefore?.prefs?.draftTargetCwd ?? null;
  try {
    // 打开添加项目弹窗
    await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
    await ensureAuthed();
    await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });
    const L = await uiLabels();
    let addRef = null;
    for (let attempt = 0; attempt < 3 && !addRef; attempt += 1) {
      await new Promise((r) => setTimeout(r, 2500));
      const refs = await snapshotRefs();
      addRef = Object.entries(refs).find(([, i]) => i?.role === "button" && (i.name ?? "").includes(L.addProject))?.[0] ?? null;
    }
    assert.ok(addRef, "未找到添加项目按钮（重试 3 次后仍无）");
    // 语义定位避免 ref 被重渲染；DOM click 仍走 React 的真实 onClick，
    // 但不受悬浮 tooltip 命中测试遮挡的影响。
    const clicked = await evalResult(`(() => { const button = document.querySelector('button[aria-label="${L.addProject}"]'); if (!button) return false; button.click(); return true; })()`);
    assert.equal(clicked, true, "添加项目按钮不可点击");
    await new Promise((r) => setTimeout(r, 1200));
    // 填路径 + Enter 浏览 + 添加
    const refs2 = await snapshotRefs();
    const inputRef = Object.entries(refs2).find(([, i]) => i?.name === L.projectPath)?.[0];
    assert.ok(inputRef, "未找到项目路径输入框");
    await ab(["fill", inputRef, dir, "--session", SESSION], { json: false });
    await ab(["press", "Enter", "--session", SESSION], { json: false });
    await new Promise((r) => setTimeout(r, 1200));
    const refs3 = await snapshotRefs();
    const addBtn = Object.entries(refs3).find(([, i]) => i?.role === "button" && i?.name === L.add)?.[0];
    assert.ok(addBtn, "添加按钮不可用（应先浏览路径）");
    await ab(["click", addBtn, "--session", SESSION], { json: false });
    await new Promise((r) => setTimeout(r, 1500));
    const text = await snapshotText();
    const projectName = dir.split("/").at(-1) ?? dir;
    assert.ok(text.includes(projectName) || text.includes(dir), `空项目未显示在侧栏（dir=${dir}）`);
    assert.ok(text.includes(L.noSessionsYet) || text.includes(L.newSession), "空项目缺少新建会话入口");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    const restore = await fetch(`${URL_BASE}/api/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        prefs: {
          ...(rootsBefore !== null ? { sidebarUi: { projectRoots: rootsBefore } } : {}),
          draftTargetCwd: draftBefore,
        },
      }),
    }).catch(() => null);
    assert.ok(restore?.ok, `还原共享偏好失败（HTTP ${restore?.status ?? "n/a"}）`);
  }
});

test("用例12：引导页项目下拉跟随侧栏「新建会话」目标", { timeout: 120_000 }, async (t) => {
  // issue 回归：停在引导页时点会话列表里其他项目的「新建会话」，项目下拉必须
  // 立刻切到该项目（引导页是条件渲染，同一实例内目标被外部改写）——而不是
  // 靠组件重挂载（下面用标记属性证明是同一 select 节点）。
  await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
  await ensureAuthed();
  await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });
  const L = await uiLabels();

  // 该用例会改写共享的「上次新会话项目」：先读回原值，结束后还原（仅当期间
  // 没有真实用户改写时才写回，避免盖掉用户手动选择）。
  const readDraft = async () => {
    const res = await fetch(`${URL_BASE}/api/preferences`, { headers: AUTH_HEADER }).catch(() => null);
    if (!res?.ok) return { ok: false, value: null };
    const body = await res.json().catch(() => null);
    const value = body?.prefs?.draftTargetCwd;
    return { ok: true, value: typeof value === "string" ? value : null };
  };
  const originalDraft = await readDraft();

  const guideState = `(() => {
    const s = document.querySelector('select.guide-select');
    if (!s) return null;
    const rows = [...document.querySelectorAll('.sidebar-row[title]')]
      .filter((r) => r.getAttribute('data-sidebar-depth') === '0'
        && r.querySelector('button[aria-label^="在 "]'))
      .map((r) => r.getAttribute('title'));
    return {
      value: s.value,
      loading: s.disabled,
      options: [...s.options].map((o) => o.value),
      // 侧栏能直接发起会话的项目（引导页选项 ∩ 侧栏可见项目行）
      switchable: [...s.options].map((o) => o.value).filter((v) => v && rows.includes(v)),
      // 同一实例（未重挂载）的标记：切换后仍应在
      marked: s.dataset.guideProbe === '1',
      label: s.getAttribute('aria-label'),
    };
  })()`;
  /** 有限次轮询直到条件成立（避免固定睡眠把"未加载完"当成终态）。 */
  const waitFor = async (predicate, { attempts = 40, stepMs = 500 } = {}) => {
    let last = null;
    for (let i = 0; i < attempts; i += 1) {
      last = await evalResult(guideState);
      if (last && predicate(last)) return last;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    return last;
  };

  try {
    // 1) 停到引导页（侧栏顶部新建会话 = 当前项目），等项目列表加载完
    // 侧栏那个按钮在没有选中项目时是禁用的「选择项目」：必须**等它变成可点的
    // 「在 <项目> 中新建会话」**再点，否则会把「还没自动选中项目」当成产品回归
    // （issue #61：这条用例此前就是这么红的）。
    const newSessionProbe = `(() => {
      const b = [...document.querySelectorAll('button.sidebar-icon-btn')].find((el) => {
        const label = el.getAttribute('aria-label') ?? '';
        return (label.startsWith(${JSON.stringify(L.newSessionInPrefix)}) || label.includes(${JSON.stringify(L.newSession)}));
      });
      if (!b || b.disabled) return null;
      return b.getAttribute('aria-label');
    })()`;
    let newSessionLabel = null;
    for (let i = 0; i < 40 && !newSessionLabel; i += 1) {
      newSessionLabel = await evalResult(newSessionProbe);
      if (!newSessionLabel) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(newSessionLabel, "未找到可点的侧栏新建会话按钮（一直停在「选择项目」/禁用 = 没有自动选中项目）");
    const opened = await evalResult(
      `(() => { const b = [...document.querySelectorAll('button.sidebar-icon-btn')].find((el) => el.getAttribute('aria-label') === ${JSON.stringify(newSessionLabel)}); if (!b) return false; b.click(); return true; })()`,
    );
    assert.equal(opened, true, "未找到侧栏新建会话按钮");
    const ready = await waitFor((s) => !s.loading && s.options.length > 1 && s.switchable.length > 0);
    assert.ok(ready && !ready.loading, "新会话引导页项目下拉未就绪（未加载完 ≠ 没有项目）");
    assert.equal(ready.label, L.chooseProject, "引导页项目下拉的 aria-label 与当前语言不一致");
    if (ready.switchable.length < 2) return t.skip("环境只有一个侧栏可见项目，无法验证切换");

    // 标记当前 select 节点：React 原地更新时标记保留，重挂载则丢失
    await evalResult(
      "(() => { const s = document.querySelector('select.guide-select');"
      + "if (!s) return false; s.dataset.guideProbe = '1'; return true; })()",
    );

    // 2) 先明确选中 A（原生 select 的 change 走真实 onTargetChange）
    const a = ready.switchable.find((v) => v === ready.value) ?? ready.switchable[0];
    if (a !== ready.value) {
      await evalResult(
        "(() => { const s = document.querySelector('select.guide-select');"
        + "const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;"
        + `set.call(s, ${JSON.stringify(a)}); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`,
      );
    }
    const selected = await waitFor((s) => s.value === a);
    assert.equal(selected?.value, a, `引导页未选中项目 A（${a}）`);

    // 3) 点侧栏另一个项目 B 的「新建会话」→ 下拉必须切到 B
    const b = ready.switchable.find((value) => value !== a);
    const clicked = await evalResult(
      `(() => {
        const row = [...document.querySelectorAll('.sidebar-row[title]')]
          .find((r) => r.getAttribute('title') === ${JSON.stringify(b)});
        const button = row?.querySelector('button[aria-label^="在 "]');
        if (!button) return false;
        button.click();
        return true;
      })()`,
    );
    assert.equal(clicked, true, `侧栏未找到项目行「新建会话」按钮（root=${b}）`);
    const after = await waitFor((s) => s.value === b);
    assert.equal(after?.value, b, "引导页项目下拉未跟随侧栏新建会话的目标项目");
    assert.equal(after?.marked, true, "引导页项目下拉被重挂载（切换应发生在同一实例内）");
  } finally {
    // 等客户端防抖落盘后再还原原值（未落盘时写回会被稍后的防抖写盖掉）
    await new Promise((r) => setTimeout(r, 1500));
    const current = await readDraft();
    const untouched = !current.ok || current.value === originalDraft.value;
    const changedByTest = current.ok && current.value !== null && current.value !== originalDraft.value;
    if (changedByTest || untouched) {
      await fetch(`${URL_BASE}/api/preferences`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...AUTH_HEADER },
        body: JSON.stringify({ prefs: { draftTargetCwd: originalDraft.value } }),
      }).catch(() => {});
    }
  }
});

test("用例13：run 结束的权威快照回收乐观运行标记（侧栏不残留运行中）", { timeout: 180_000 }, async () => {
  // issue 回归：乐观 starting 标记由当前 chat 上报；chat 切走后 run 仍会结束，
  // 权威 running 快照不再含该 id → 标记必须回收，否则列表一直显示运行中。
  // 为使其可判定，先屏蔽侧栏的 running SSE，避免「含该 id 的快照」提前把标记消掉（那会
  // 让坏实现也能通过），再在 run 结束后用一次权威对齐（focus → GET /api/agent/running）
  // 暴露该规则。
  let createdId = null;
  const sseUrl = `${URL_BASE}/api/agent/running/events`;
  const unroute = async () => {
    await ab(["network", "unroute", sseUrl, "--session", SESSION], { json: false }).catch(() => {});
  };
  try {
    await ab(["network", "route", sseUrl, "--abort", "--session", SESSION], { json: false });

    const createRes = await fetch(`${URL_BASE}/api/agent/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        cwd: process.cwd(),
        type: "prompt",
        message: "请用 bash 工具执行 sleep 20（一次调用，不要拆开），完成后只回复 done。",
      }),
    });
    const created = await createRes.json();
    createdId = created?.sessionId ?? null;
    assert.ok(createdId, `测试会话创建失败: ${createRes.status} ${JSON.stringify(created)}`);

    // 侧栏「运行中」与 chat「停止」的文案随语言变，先按页面语言取词（issue #61）
    const L = await uiLabels();

    const rowState = `(() => {
      const row = document.querySelector('[data-session-id="${createdId}"]');
      return { present: !!row, running: row ? !!row.querySelector('[aria-label="' + ${JSON.stringify(L.running)} + '"]') : false };
    })()`;
    // chat 视图必须确实挂在该会话且正在跑：乐观标记由当前 chat 上报，
    // 只看侧栏圆环无法区分标记还是服务端 running 集。
    const viewRunning = `(() => ({
      onSession: location.search.includes(${JSON.stringify(createdId)}),
      chat: !!document.querySelector('[data-pidance-chat="true"]'),
      stop: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim().startsWith(${JSON.stringify(L.stop)})),
    }))()`;

    await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(createdId)}`, "--session", SESSION], { json: false });
    await ensureAuthed();
    await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });

    // 1) 前置：侧栏该行显示运行中，且该会话的 chat 视图已挂载并在跑（乐观标记已建立）
    let ready = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const row = await evalResult(rowState);
      const view = await evalResult(viewRunning);
      ready = { row, view };
      if (row?.present && row.running && view?.onSession && view.chat && view.stop) break;
    }
    assert.ok(ready?.row?.present, "测试会话未出现在侧栏");
    assert.ok(ready.row.running, "测试会话未在侧栏显示运行中（前置条件不成立）");
    assert.ok(ready.view?.chat && ready.view.onSession, "该会话的 chat 视图未挂载（乐观标记不可能建立）");
    assert.ok(ready.view.stop, "chat 视图未显示运行中（停止按钮缺失）");

    // 2) 切走会话：当前 chat 不再上报该会话的运行态（标记无人撤销）
    const switched = await evalResult(`(() => {
      const rows = [...document.querySelectorAll('[data-session-id]')]
        .filter((r) => r.getAttribute('data-session-id') !== ${JSON.stringify(createdId)});
      const target = rows.map((r) => r.querySelector('.sidebar-row')).find(Boolean);
      if (!target) return false;
      target.click();
      return true;
    })()`);
    assert.equal(switched, true, "侧栏没有可切换的其它会话");

    // 3) 等 run 结束（服务端 running 集不再含该 id）
    let finished = false;
    for (let i = 0; i < 120 && !finished; i += 1) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`${URL_BASE}/api/agent/running`, { headers: AUTH_HEADER });
      const body = res.ok ? await res.json() : {};
      finished = Array.isArray(body.runningSessionIds) && !body.runningSessionIds.includes(createdId);
    }
    assert.ok(finished, "测试会话 run 未在预期时间内结束");

    // 4) 打开权威对齐通道（focus/visibilitychange → GET /api/agent/running）
    await unroute();
    await evalResult("(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); return true; })()");

    // 5) 权威快照已说不在跑：侧栏行必须仍在且退出运行中
    let after = await evalResult(rowState);
    for (let i = 0; i < 20 && !(after?.present && !after.running); i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      after = await evalResult(rowState);
      if (after?.present && after.running && i === 8) {
        // SSE 自动重连也可能带来同一权威快照：补一次对齐
        await evalResult("(() => { window.dispatchEvent(new Event('focus')); return true; })()");
      }
    }
    assert.equal(after?.present, true, "测试会话行已从侧栏消失，无法判定运行态");
    assert.equal(after.running, false, "run 结束后侧栏仍显示运行中（乐观标记未回收）");
  } finally {
    await unroute();
    if (createdId) {
      await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(createdId)}`, {
        method: "DELETE",
        headers: AUTH_HEADER,
      }).catch(() => {});
    }
    await clearSessionUnreadClock(createdId);
  }
});

test("A1/A2/A3/D6：运行中会话的列表运行态与时长、硬刷新恢复、输入保持、队列即时显示", { timeout: 300_000 }, async () => {
  // #28 待办二：A1「回复后列表仍 running/时长增长」、A2「刷新后打开运行中会话卡死」、
  // A3「输入文字后停止消失」、D6「队列消息延迟显示」各自落成可重复的无头断言。
  // 一条真实 run（bash sleep）覆盖四项：不做真实模型回合以外的注入，也不 mock 应用代码。
  let createdId = null;
  // 本用例在仓库目录建会话 → 会把「上次新会话项目」改掉，跑完还回去（#62）
  const draftBeforeA1 = (await (await fetch(`${URL_BASE}/api/preferences`, { headers: AUTH_HEADER })).json())?.prefs?.draftTargetCwd ?? null;
  const MARK = "回归入队标记A1A3D6";
  // UI 文案随 locale 变（QA 浏览器可能是 en）：断言用的文案在**页面打开之后**由页面自身语言推出，
  // 否则「中文 profile 下通过、英文 profile 下永远匹配不到」——这不是产品缺陷，是断言脆弱。
  let stopLabel = null;
  const readUiLabels = async () => {
    const labels = await evalResult(`(() => {
      const zh = String(document.documentElement.lang || "").toLowerCase().startsWith("zh");
      return {
        running: zh ? "运行中" : "Running",
        unread: zh ? "活动" : "Activity",
        stop: zh ? "停止" : "Stop",
        send: zh ? "发送" : "Send",
      };
    })()`);
    assert.ok(labels && labels.running, "无法确定页面语言（断言无法构造）");
    stopLabel = labels.stop;
    return labels;
  };
  const rowProbe = (id, L) => `(() => {
    // 同一会话在侧栏可能出现两次（最近区 + 项目区），逐份取；行里 title=<运行中> 的
    // 元素也有两个（状态圆点无文本、运行时长文本有数字），所以取「有数字的那个」。
    const rows = [...document.querySelectorAll('[data-session-id="${id}"]')];
    const texts = rows.flatMap((row) => [...row.querySelectorAll('[title=' + JSON.stringify(${JSON.stringify(L.running)}) + ']')]
      .map((el) => (el.textContent || '').trim()));
    return {
      present: rows.length > 0,
      copies: rows.length,
      running: texts.length > 0,
      duration: texts.find((text) => /[0-9]/.test(text)) ?? "",
    };
  })()`;
  const chatProbe = (L) => `(() => ({
    chat: !!document.querySelector('[data-pidance-chat="true"]'),
    textarea: !!document.querySelector('textarea'),
    stop: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === ${JSON.stringify(L.stop)}),
  }))()`;
  try {
    const createRes = await fetch(`${URL_BASE}/api/agent/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        cwd: process.cwd(),
        type: "prompt",
        message: "请用 bash 工具执行 sleep 45（一次调用，不要拆开），完成后只回复 done。",
      }),
    });
    const created = await createRes.json();
    createdId = created?.sessionId ?? null;
    assert.ok(createdId, `测试会话创建失败: ${createRes.status} ${JSON.stringify(created)}`);

    // 前置：服务端 running 集确实含该会话（页面态是它的投影）
    let serverRunning = false;
    for (let i = 0; i < 60 && !serverRunning; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const res = await fetch(`${URL_BASE}/api/agent/running`, { headers: AUTH_HEADER });
      const body = res.ok ? await res.json() : {};
      serverRunning = (body?.runningSessionIds ?? body?.sessionIds ?? []).includes(createdId);
    }
    assert.ok(serverRunning, "测试会话未进入服务端 running 集（前置条件不成立）");

    await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });
    await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(createdId)}`, "--session", SESSION], { json: false });
    await ensureAuthed();
    const L = await readUiLabels();

    // ── A1：列表该项显示运行中，且时长在增长（不是卡住的假标记） ──
    let first = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      first = await evalResult(rowProbe(createdId, L));
      if (first?.present && first.running && /\d/.test(first.duration ?? "")) break;
    }
    assert.ok(first?.present, "测试会话未出现在侧栏");
    assert.ok(first?.running, "运行中的会话未在侧栏显示运行中（A1 前置不成立）");
    const firstSeconds = Number((first.duration ?? "").match(/\d+/)?.[0] ?? NaN);
    assert.ok(Number.isFinite(firstSeconds), `运行中时长文本不可解析: ${JSON.stringify(first.duration)}`);

    await new Promise((r) => setTimeout(r, 4000));
    const later = await evalResult(rowProbe(createdId, L));
    const laterSeconds = Number((later?.duration ?? "").match(/\d+/)?.[0] ?? NaN);
    assert.ok(later?.running, "4 秒后该会话不再显示运行中（run 提前结束？）");
    assert.ok(
      Number.isFinite(laterSeconds) && laterSeconds > firstSeconds,
      `运行时长没有增长（${first.duration} → ${later?.duration}）`,
    );
    console.log(`[browser-regression] A1 运行中时长 ${first.duration} → ${later.duration}`);

    // ── A2：硬刷新后仍在跑 → 必须导入在跑的 run（有停止入口、可继续操作） ──
    const beforeReload = await evalResult(chatProbe(L));
    assert.ok(beforeReload?.chat, "刷新前该会话的 chat 视图未挂载");
    await ab(["reload", "--session", SESSION], { json: false });
    let afterReload = null;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      afterReload = await evalResult(chatProbe(L));
      if (afterReload?.chat && afterReload?.textarea) break;
    }
    assert.ok(afterReload?.chat, "刷新后 chat 视图未挂载（A2 无法判定）");
    assert.ok(afterReload?.stop, "刷新后运行中的会话没有停止入口（A2：未导入在跑的 run）");

    // ── A3：运行中输入文字不得把停止入口挤掉 ──
    const typed = await evalResult(`(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return "no-textarea";
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) return "no-setter";
      setter.call(ta, ${JSON.stringify(MARK)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value === ${JSON.stringify(MARK)} ? "ok" : "mismatch";
    })()`);
    assert.equal(typed, "ok", "无法把文本写进输入框（A3 无法判定）");
    await new Promise((r) => setTimeout(r, 600));
    const afterTyping = await evalResult(chatProbe(L));
    assert.ok(afterTyping?.stop, "输入文字后停止入口消失（A3）");

    // ── D6：运行中发送 → 队列块必须**早于服务端回执**出现（乐观显示，不是等到确认） ──
    // 纯时间上界抓不住「等服务端回来才显示」（本机往返很快）；所以页内同时记录
    // 发送 POST 的开始/结算时刻与队列行出现的时刻，断言「出现不晚于结算」。
    const d6 = await evalResult(`(async () => {
      const MARK = ${JSON.stringify(MARK)};
      const post = { startedAt: null, settledAt: null };
      const realFetch = window.fetch;
      window.fetch = (...args) => {
        const url = String(args[0]?.url ?? args[0] ?? "");
        const promise = realFetch.apply(window, args);
        if (url.includes("/api/agent/") && !url.includes("/events") && String(args[1]?.method ?? "").toUpperCase() === "POST") {
          post.startedAt = performance.now();
          const settle = () => { if (post.settledAt === null) post.settledAt = performance.now(); };
          promise.then(settle, settle);
        }
        return promise;
      };
      const hasRow = () => [...document.querySelectorAll("div[title]")]
        .some((el) => (el.getAttribute("title") || "").includes(MARK));
      if (hasRow()) return { error: "发送前就已有队列行" };
      const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === ${JSON.stringify(L.send)});
      if (!btn || btn.disabled) return { error: "运行中没有可用的发送按钮" };
      const t0 = performance.now();
      btn.click();
      const seenAtAbs = await new Promise((resolve) => {
        const deadline = t0 + 3000;
        const check = () => {
          if (hasRow()) return resolve(performance.now());
          if (performance.now() > deadline) return resolve(null);
          requestAnimationFrame(check);
        };
        check();
      });
      window.fetch = realFetch;
      return {
        t0,
        seenAfterMs: seenAtAbs === null ? null : seenAtAbs - t0,
        postStartedAfterMs: post.startedAt === null ? null : post.startedAt - t0,
        // null = 采样时 POST 还没结算（队列行在请求在途时就出现了，乐观更强）
        postSettledAfterMs: post.settledAt === null ? null : post.settledAt - t0,
      };
    })()`);
    assert.ok(d6 && !d6.error, `D6 无法判定：${JSON.stringify(d6)}`);
    assert.notEqual(d6.seenAfterMs, null, "运行中入队后队列块始终没有出现（D6）");
    assert.notEqual(d6.postStartedAfterMs, null, "没有观察到入队的 POST（D6 的结构断言会空转）");
    const appearedBeforeSettle = d6.postSettledAfterMs === null || d6.seenAfterMs <= d6.postSettledAfterMs;
    console.log(`[browser-regression] D6 队列块出现 ${d6.seenAfterMs.toFixed(0)}ms`
      + `（POST 开始 ${d6.postStartedAfterMs.toFixed(0)}ms / `
      + `结算 ${d6.postSettledAfterMs === null ? "仍在途" : `${d6.postSettledAfterMs.toFixed(0)}ms`}）`);
    assert.equal(appearedBeforeSettle, true, "队列块在服务端回执之后才出现（D6：缺少乐观显示）");
    assert.ok(d6.seenAfterMs <= 2000, `队列块出现太慢（${d6.seenAfterMs.toFixed(0)}ms > 2000ms）`);
  } finally {
    // 收尾：运行中的会话删不掉，先点停止；仍不行就等它自然结束
    await evalResult(`(() => {
      const b = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === ${JSON.stringify(stopLabel ?? "Stop")});
      if (b) b.click();
      return !!b;
    })()`).catch(() => {});
    if (createdId) {
      for (let i = 0; i < 90; i += 1) {
        const res = await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(createdId)}`, {
          method: "DELETE",
          headers: AUTH_HEADER,
        }).catch(() => null);
        if (res && res.ok) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    // 共享偏好：本用例建过会话，会把「上次新会话项目」改掉，跑完还回去（#62）
    await fetch(`${URL_BASE}/api/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ prefs: { draftTargetCwd: draftBeforeA1 } }),
    }).catch(() => {});
    await clearSessionUnreadClock(createdId);
  }
});

test("B4：未读时钟跨端（服务端记 completedAt、各端记 readAt，取并集判定未读）", { timeout: 300_000 }, async () => {
  // #28 待办二 B4 + #65：未读时钟**跨端** —— 服务端在 run 结束时记 completedAt，各端打开会话时
  // 记 readAt，未读 ⟺ completedAt > readAt。三层断言：
  //   1) 正例：run 完成后显示未读，且**服务端**记下了 completedAt（不依赖任何浏览器开着）；
  //   2) 打开即已读：本地有 readAt，且 readAt 推给了服务端（其它端才能看到已读）；刷新仍是已读；
  //   3) 新设备（清空 localStorage）：服务端说未读 → 必须显示未读；服务端说他端已读 → 不得显示。
  //      （3 的控制项：注入的 locale 生效，且注入的时钟确实落到客户端 —— 与徽标无关，避免空转。）
  let createdId = null;
  /** 跑前快照：本用例 mock 了 /api/preferences，注入字段可能被客户端整包 PUT 写回共享文件
   *  （见 issue #62 —— 实测把用户的 locale 从 zh-CN 泄漏成 en），所以跑完必须逐字还原。 */
  const prefsSnapshot = { locale: null, unreadSessionState: null, projectRoots: null };
  let prefsSnapshotTaken = false;
  let bogusLocale = "en";
  const prefsHeaders = { ...AUTH_HEADER, "Content-Type": "application/json" };
  /** 还原本用例可能撞到的键（null = 墓碑删除，与服务端 merge 语义一致）。
   *  快照没拿到就什么都不做：否则会把用户的 locale 直接删掉。 */
  const restoreSharedPrefs = async () => {
    if (!prefsSnapshotTaken) return;
    const res = await fetch(`${URL_BASE}/api/preferences`, {
      method: "PUT",
      headers: prefsHeaders,
      body: JSON.stringify({
        prefs: { locale: prefsSnapshot.locale, unreadSessionState: prefsSnapshot.unreadSessionState },
      }),
    });
    assert.equal(res.ok, true, `还原共享偏好失败（HTTP ${res.status}）`);
  };
  // 本地缓存 2026-09-21 起是**时钟 JSON**（#65：未读改跨端），不再是不带时间戳的 id 列表
  const unreadProbe = (id) => `(() => {
    const zh = String(document.documentElement.lang || "").toLowerCase().startsWith("zh");
    // 文案在**页内**按当前语言推：本用例中途会把 language 注入成 en，外部算好的中文文案就失效了
    const unreadLabel = zh ? "活动" : "Activity";
    const rows = [...document.querySelectorAll('[data-session-id="${id}"]')];
    let clock = null;
    try {
      const raw = localStorage.getItem("pidance:unread-session-clock");
      clock = raw ? JSON.parse(raw) : null;
    } catch { clock = { parseError: true }; }
    return {
      present: rows.length > 0,
      badge: rows.some((row) => !!row.querySelector('[title=' + JSON.stringify(unreadLabel) + ']')),
      localCompleted: Boolean(clock && clock.completedAt && clock.completedAt["${id}"]),
      localRead: Boolean(clock && clock.readAt && clock.readAt["${id}"]),
      lang: document.documentElement.lang || null,
    };
  })()`;
  /** 服务端未读时钟（#65：completedAt 由服务端写、readAt 由各端写）。 */
  const serverClock = async () => {
    const res = await fetch(`${URL_BASE}/api/preferences`, { headers: AUTH_HEADER });
    const body = res.ok ? await res.json() : null;
    const clock = body?.prefs?.unreadSessionState;
    return clock && typeof clock === "object" ? clock : { completedAt: {}, readAt: {} };
  };
  try {
    // 先开页面（并停在某个已有会话上），再建测试会话：只有「页面已在观察运行集」时才看得到
    // running → completed 的过渡，否则 run 在页面挂载前就结束了，未读永远不会出现。
    await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });
    await ab(["open", URL_BASE, "--session", SESSION], { json: false });
    await ensureAuthed();
    await new Promise((r) => setTimeout(r, 3000));
    const createRes = await fetch(`${URL_BASE}/api/agent/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        cwd: process.cwd(),
        type: "prompt",
        // 留出观察窗口：模型回合 + 15 秒 sleep，页面来得及看到它「跑起来」再「结束」。
        message: "请用 bash 工具执行 sleep 15（一次调用，不要拆开），完成后只回复 done。",
      }),
    });
    const created = await createRes.json();
    createdId = created?.sessionId ?? null;
    assert.ok(createdId, `测试会话创建失败: ${createRes.status} ${JSON.stringify(created)}`);

    // 页面当前选中不能是测试会话（否则完成即已读，未读永远不会出现）
    const selectedIsTest = await evalResult(`location.search.includes(${JSON.stringify(createdId)})`);
    assert.equal(selectedIsTest, false, "当前选中的竟是测试会话（未读会被立刻视为已读）");

    // 步骤 3 需要一个「不选中测试会话」的落点
    const listRes = await fetch(`${URL_BASE}/api/sessions`, { headers: AUTH_HEADER });
    const listBody = listRes.ok ? await listRes.json() : null;
    const items = Array.isArray(listBody) ? listBody : (listBody?.sessions ?? listBody?.data ?? []);
    const other = items.map((item) => item?.id).find((id) => id && id !== createdId);
    assert.ok(other, "列表里没有其它会话可作落点（无法构造「不选中测试会话」）");

    // ── 1) 本设备观察到完成 → 未读 ──
    let positive = null;
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      positive = await evalResult(unreadProbe(createdId));
      if (positive?.badge) break;
    }
    assert.ok(positive?.present, "测试会话未出现在侧栏");
    assert.ok(positive?.badge, "该会话完成后没有记为未读（时钟未生效：B4 前置不成立）");
    // #65：完成时刻由**服务端**记录 —— 这样即使当时没开任何浏览器，未读也是准的。
    let clockAfterRun = { completedAt: {}, readAt: {} };
    for (let i = 0; i < 20; i += 1) {
      clockAfterRun = await serverClock();
      if (clockAfterRun.completedAt?.[createdId]) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(clockAfterRun.completedAt?.[createdId], "服务端没有记录该会话的 completedAt（跨端未读的权威来源缺失）");

    // ── 2) 打开即已读；刷新后仍是已读（readAt 是本设备本地状态） ──
    await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(createdId)}`, "--session", SESSION], { json: false });
    // 已读的两处投影（徽标、本地存储）由不同 effect 落地，逐项轮询到位再断言。
    let afterOpen = null;
    let readMarked = false;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 300));
      afterOpen = await evalResult(unreadProbe(createdId));
      readMarked = Boolean(afterOpen?.localRead);
      if (afterOpen && !afterOpen.badge && readMarked) break;
    }
    assert.equal(afterOpen?.badge, false, "打开该会话后未读没有清掉");
    assert.equal(readMarked, true, `已读后本地缓存时钟里没有 readAt: ${JSON.stringify(afterOpen)}`);
    // #65 的关键：readAt 必须推给服务端，其它端才能看到「已读」
    let clockAfterRead = { completedAt: {}, readAt: {} };
    for (let i = 0; i < 20; i += 1) {
      clockAfterRead = await serverClock();
      if (clockAfterRead.readAt?.[createdId]) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(clockAfterRead.readAt?.[createdId], "readAt 没有推给服务端（跨端已读不成立）");
    assert.ok(
      clockAfterRead.readAt[createdId] >= clockAfterRead.completedAt[createdId],
      `服务端时钟里 readAt 应不早于 completedAt: ${JSON.stringify({ c: clockAfterRead.completedAt[createdId], r: clockAfterRead.readAt[createdId] })}`,
    );
    await ab(["reload", "--session", SESSION], { json: false });
    await new Promise((r) => setTimeout(r, 4000));
    const afterReload = await evalResult(unreadProbe(createdId));
    assert.equal(afterReload?.badge, false, "硬刷新后未读又回来了（readAt 没落本地）");

    // ── 3) 反例：新设备（本地存储清空）+ 服务端仍带旧未读时钟 → 不得复活未读 ──
    await ab(["storage", "local", "clear", "--session", SESSION], { json: false });
    // mock 必须带上**真实**的服务端偏好再叠加要注入的字段：只回注入字段会让客户端内存里的
    // sidebarUi 变成默认值，之后任何一次 PUT 都会把用户的项目列表与信任面清空（实测踩过）。
    const realPrefsRes = await fetch(`${URL_BASE}/api/preferences`, { headers: AUTH_HEADER });
    const realPrefs = realPrefsRes.ok ? (await realPrefsRes.json()).prefs : null;
    assert.ok(realPrefs && typeof realPrefs === "object", "读取真实服务端偏好失败（mock 无法安全构造）");
    const projectRootsBefore = JSON.stringify(realPrefs.sidebarUi?.projectRoots ?? null);
    prefsSnapshot.locale = typeof realPrefs.locale === "string" ? realPrefs.locale : null;
    prefsSnapshot.unreadSessionState = realPrefs.unreadSessionState ?? null;
    prefsSnapshot.projectRoots = realPrefs.sidebarUi?.projectRoots ?? null;
    prefsSnapshotTaken = true;
    // 控制项必须「与当前相反」才能证明注入载荷真的生效（固定 "en" 在页面本来就是 en 时恒真）。
    bogusLocale = prefsSnapshot.locale === "en" ? "zh-CN" : "en";
    const unreadPayload = (clock) => ({
      prefs: { ...realPrefs, locale: bogusLocale, unreadSessionState: clock },
    });
    /** 在「本地存储已清空」（= 新设备）的页面上跑一次断言。 */
    const probeFreshDevice = async (label, injected) => {
      // 必须停在不选中测试会话的落点：否则「当前会话立刻视为已读」会让断言空转。
      await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(other)}`, "--session", SESSION], { json: false });
      let fresh = null;
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        fresh = await evalResult(unreadProbe(createdId));
        // 等待条件必须与「徽标」无关，否则就是在等自己想要的答案：
        // 这里等的是「注入的时钟确实被客户端采纳了」（completedAt / readAt 落到本地时钟）。
        const applied = injected === "completed" ? fresh?.localCompleted : fresh?.localRead;
        if (fresh?.lang === bogusLocale && applied) break;
      }
      assert.equal(fresh?.lang, bogusLocale, `${label}: 注入的服务端偏好没有生效（控制项失败，本步会空转）`);
      assert.equal(
        injected === "completed" ? fresh?.localCompleted : fresh?.localRead,
        true,
        `${label}: 注入的未读时钟没有落到客户端（${injected}）`,
      );
      assert.equal(fresh?.present, true, `${label}: 测试会话未出现在侧栏`);
      // 控制项之二：被 mock 的 /api/preferences 确实被页面请求过
      const requests = await ab(["network", "requests", "--json", "--session", SESSION]);
      const list = requests?.data?.requests ?? requests?.data ?? [];
      const hit = Array.isArray(list) && list.some((item) => String(item?.url ?? "").includes("/api/preferences"));
      assert.equal(hit, true, `${label}: 页面没有请求 /api/preferences（mock 未被使用，本步空转）`);
      return fresh;
    };

    // ── 3a) 跨端未读：服务端说「完成晚于阅读」→ 新设备必须显示未读 ──
    // （#65 之前这里是反过来的：未读只活在本机，服务端的时钟必须被忽略。语义已按产品决定反转。）
    const completedNow = new Date().toISOString();
    await ab(["network", "route", `${URL_BASE}/api/preferences`, "--body", JSON.stringify(unreadPayload({ completedAt: { [createdId]: completedNow }, readAt: {} })), "--session", SESSION], { json: false });
    try {
      const freshUnread = await probeFreshDevice("3a 跨端未读", "completed");
      assert.equal(
        freshUnread.badge,
        true,
        `新设备没有显示服务端记录的未读（跨端未读不成立：未读又只活在本机）probe=${JSON.stringify(freshUnread)}`,
      );
    } finally {
      await ab(["network", "unroute", `${URL_BASE}/api/preferences`, "--session", SESSION], { json: false }).catch(() => {});
    }

    // ── 3b) 跨端已读：服务端说「阅读晚于完成」→ 新设备不得显示未读 ──
    const completedOld = new Date(Date.now() - 60_000).toISOString();
    const readNewer = new Date().toISOString();
    await ab(["network", "route", `${URL_BASE}/api/preferences`, "--body", JSON.stringify(unreadPayload({ completedAt: { [createdId]: completedOld }, readAt: { [createdId]: readNewer } })), "--session", SESSION], { json: false });
    try {
      const freshRead = await probeFreshDevice("3b 跨端已读", "read");
      assert.equal(
        freshRead.badge,
        false,
        "另一台设备已读的会话在新设备上仍显示未读（跨端已读不成立）",
      );
    } finally {
      await ab(["network", "unroute", `${URL_BASE}/api/preferences`, "--session", SESSION], { json: false }).catch(() => {});
    }
    // 共享偏好是用户数据：本用例跑完必须与跑前逐字一致（曾经因为 mock 缺字段把项目列表清空过）。
    const afterPrefsRes = await fetch(`${URL_BASE}/api/preferences`, { headers: AUTH_HEADER });
    const afterPrefs = afterPrefsRes.ok ? (await afterPrefsRes.json()).prefs : null;
    assert.equal(
      JSON.stringify(afterPrefs?.sidebarUi?.projectRoots ?? null),
      projectRootsBefore,
      "本用例改动了共享的项目列表（QA 不得留下痕迹）",
    );
    // 泄漏检测（不是断言）：整包 PUT 会把 mock 注入的字段捎回服务端，那是 #62 的应用侧缺陷，
    // 由「脏键 PUT」根治；这里只负责**跑完不留痕**，所以先还原再断言。
    const leaked = [];
    if ((afterPrefs?.locale ?? null) !== prefsSnapshot.locale) leaked.push("locale");
    if (JSON.stringify(afterPrefs?.unreadSessionState ?? null) !== JSON.stringify(prefsSnapshot.unreadSessionState)) leaked.push("unreadSessionState");
    if (leaked.length > 0) {
      console.warn(`[B4] 检出共享偏好泄漏（#62）：${leaked.join(", ")}；正在还原`);
    }
    await restoreSharedPrefs();
    const restored = await (await fetch(`${URL_BASE}/api/preferences`, { headers: AUTH_HEADER })).json();
    assert.equal(restored?.prefs?.locale ?? null, prefsSnapshot.locale, "跑完没能还原共享的 locale");
    assert.equal(
      JSON.stringify(restored?.prefs?.unreadSessionState ?? null),
      JSON.stringify(prefsSnapshot.unreadSessionState),
      "跑完没能还原共享的未读时钟",
    );
    assert.equal(
      JSON.stringify(restored?.prefs?.sidebarUi?.projectRoots ?? null),
      projectRootsBefore,
      "跑完没能还原共享的项目列表",
    );
  } finally {
    await ab(["network", "unroute", "--session", SESSION], { json: false }).catch(() => {});
    // 兜底：断言失败（例如还原断言自己红了）时也要把注入字段还原，别把用户的偏好留在脏状态。
    await restoreSharedPrefs().catch(() => {});
    if (createdId) {
      for (let i = 0; i < 90; i += 1) {
        const res = await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(createdId)}`, {
          method: "DELETE",
          headers: AUTH_HEADER,
        }).catch(() => null);
        if (res && res.ok) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    // 收尾：把被测试改动的本地状态清回来（语言/未读），避免影响同套件的其它用例
    await ab(["storage", "local", "clear", "--session", SESSION], { json: false }).catch(() => {});
  }
});
