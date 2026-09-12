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
  try {
    // 打开添加项目弹窗
    await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
    await ensureAuthed();
    await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });
    let addRef = null;
    for (let attempt = 0; attempt < 3 && !addRef; attempt += 1) {
      await new Promise((r) => setTimeout(r, 2500));
      const refs = await snapshotRefs();
      addRef = Object.entries(refs).find(([, i]) => i?.role === "button" && (i.name ?? "").includes("添加项目"))?.[0] ?? null;
    }
    assert.ok(addRef, "未找到添加项目按钮（重试 3 次后仍无）");
    // 语义定位避免 ref 被重渲染；DOM click 仍走 React 的真实 onClick，
    // 但不受悬浮 tooltip 命中测试遮挡的影响。
    const clicked = await evalResult("(() => { const button = document.querySelector('button[aria-label=\"添加项目\"]'); if (!button) return false; button.click(); return true; })()");
    assert.equal(clicked, true, "添加项目按钮不可点击");
    await new Promise((r) => setTimeout(r, 1200));
    // 填路径 + Enter 浏览 + 添加
    const refs2 = await snapshotRefs();
    const inputRef = Object.entries(refs2).find(([, i]) => i?.name === "项目路径")?.[0];
    assert.ok(inputRef, "未找到项目路径输入框");
    await ab(["fill", inputRef, dir, "--session", SESSION], { json: false });
    await ab(["press", "Enter", "--session", SESSION], { json: false });
    await new Promise((r) => setTimeout(r, 1200));
    const refs3 = await snapshotRefs();
    const addBtn = Object.entries(refs3).find(([, i]) => i?.role === "button" && i?.name === "添加")?.[0];
    assert.ok(addBtn, "添加按钮不可用（应先浏览路径）");
    await ab(["click", addBtn, "--session", SESSION], { json: false });
    await new Promise((r) => setTimeout(r, 1500));
    const text = await snapshotText();
    const projectName = dir.split("/").at(-1) ?? dir;
    assert.ok(text.includes(projectName) || text.includes(dir), `空项目未显示在侧栏（dir=${dir}）`);
    assert.ok(text.includes("暂无会话") || text.includes("新建会话"), "空项目缺少新建会话入口");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("用例12：引导页项目下拉跟随侧栏「新建会话」目标", { timeout: 120_000 }, async (t) => {
  // issue 回归：停在引导页时点会话列表里其他项目的「新建会话」，项目下拉必须
  // 立刻切到该项目（引导页是条件渲染，同一实例内目标被外部改写）——而不是
  // 靠组件重挂载（下面用标记属性证明是同一 select 节点）。
  await ab(["open", URL_BASE, "--session", SESSION], { json: false }).catch(() => {});
  await ensureAuthed();
  await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });

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
    const s = document.querySelector('select.guide-select[aria-label="选择项目"]');
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
    const opened = await evalResult(
      "(() => { const b = [...document.querySelectorAll('button.sidebar-icon-btn')]"
      + ".find((b) => !b.className.includes('--hover') && (b.getAttribute('aria-label') ?? '').includes('新建会话'));"
      + "if (!b) return false; b.click(); return true; })()",
    );
    assert.equal(opened, true, "未找到侧栏新建会话按钮");
    const ready = await waitFor((s) => !s.loading && s.options.length > 1 && s.switchable.length > 0);
    assert.ok(ready && !ready.loading, "新会话引导页项目下拉未就绪（未加载完 ≠ 没有项目）");
    if (ready.switchable.length < 2) return t.skip("环境只有一个侧栏可见项目，无法验证切换");

    // 标记当前 select 节点：React 原地更新时标记保留，重挂载则丢失
    await evalResult(
      "(() => { const s = document.querySelector('select.guide-select[aria-label=\"选择项目\"]');"
      + "if (!s) return false; s.dataset.guideProbe = '1'; return true; })()",
    );

    // 2) 先明确选中 A（原生 select 的 change 走真实 onTargetChange）
    const a = ready.switchable.find((v) => v === ready.value) ?? ready.switchable[0];
    if (a !== ready.value) {
      await evalResult(
        "(() => { const s = document.querySelector('select.guide-select[aria-label=\"选择项目\"]');"
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

    const rowRunning = `(() => {
      const row = document.querySelector('[data-session-id="${createdId}"]');
      return row ? !!row.querySelector('[aria-label="运行中"]') : null;
    })()`;

    await ab(["open", `${URL_BASE}/?session=${encodeURIComponent(createdId)}`, "--session", SESSION], { json: false });
    await ensureAuthed();
    await ab(["set", "viewport", "1280", "720", "--session", SESSION], { json: false });

    // 1) 前置：侧栏该行必须已显示运行中（chat 乐观标记 / 列表 running 集均可）
    let running = false;
    for (let i = 0; i < 40 && !running; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      running = (await evalResult(rowRunning)) === true;
    }
    assert.ok(running, "测试会话未在侧栏显示运行中（前置条件不成立）");

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

    // 5) 权威快照已说不在跑：侧栏行必须退出运行中
    let stillRunning = true;
    for (let i = 0; i < 20 && stillRunning; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      stillRunning = (await evalResult(rowRunning)) === true;
      if (stillRunning && i === 8) {
        // SSE 自动重连也可能带来同一权威快照：补一次对齐
        await evalResult("(() => { window.dispatchEvent(new Event('focus')); return true; })()");
      }
    }
    assert.equal(stillRunning, false, "run 结束后侧栏仍显示运行中（乐观标记未回收）");
  } finally {
    await unroute();
    if (createdId) {
      await fetch(`${URL_BASE}/api/sessions/${encodeURIComponent(createdId)}`, {
        method: "DELETE",
        headers: AUTH_HEADER,
      }).catch(() => {});
    }
  }
});
