#!/usr/bin/env node
"use strict";

/**
 * 打包产物功能验证（CI 与本地都能跑）：在**真实打包输入**上起服务，断言关键运行路径，
 * 而不是只看「端口有人应答」。
 *
 * 断言项：
 *   1. 页面：`/` 200 且含 Pidance 标题；
 *   2. 静态资源：页面引用的 `_next/static/...` 真的能取到（瘦身不能把构建产物删坏）；
 *   3. 身份：`/api/about` 返回的版本 === 包内 @henlii/pidance 的 package.json 版本；
 *   4. 运行时：Electron 自带的 Node 真的满足主包 engines（读包内 package.json 的 engines.node）；
 *   5. 原生模块：`/api/pty` 真建一个终端，往 shell 里发一条不存在的命令，
 *      等到 shell 的错误回显（证明 node-pty 加载、PTY 起来了、输入输出双向通）；
 *   6. SDK 会话：`POST /api/agent/new`（type=ensure_session）能建出真实会话，
 *      且 `GET /api/agent/<id>?light=1` 认这个会话（走 SessionService → registry → SDK）；
 *   7. 可停：SIGTERM/taskkill 后进程真的退出、端口释放、临时状态目录能删除
 *      （没有被子进程占着文件）。
 *
 * 状态隔离：全程只用临时目录（PI_CODING_AGENT_DIR + 临时工作目录），不碰真实 ~/.pi/agent。
 *
 * 用法：
 *   node scripts/verify-packaged.mjs --app-dir <解包后的应用目录>
 *        [--service-entry <相对路径>] [--node <可执行文件>] [--port 31419]
 *        [--timeout 90] [--keep-temp] [--label <名称>]
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PACKAGED_SERVICE_REL = "resources/app/node_modules/@henlii/pidance/bin/pidance.js";
const DEV_TREE_SERVICE_REL = "node_modules/@henlii/pidance/bin/pidance.js";

function parseArgs(argv) {
  const args = {
    appDir: null,
    serviceEntry: null,
    node: null,
    port: 31419,
    timeout: 90,
    keepTemp: false,
    label: "packaged",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--app-dir") args.appDir = argv[i += 1];
    else if (arg === "--service-entry") args.serviceEntry = argv[i += 1];
    else if (arg === "--node") args.node = argv[i += 1];
    else if (arg === "--port") args.port = Number.parseInt(argv[i += 1] ?? "31419", 10);
    else if (arg === "--timeout") args.timeout = Number.parseInt(argv[i += 1] ?? "90", 10);
    else if (arg === "--label") args.label = argv[i += 1];
    else if (arg === "--keep-temp") args.keepTemp = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!args.appDir) throw new Error("缺少 --app-dir");
  return args;
}

const failures = [];
const checks = [];

function ok(name, detail = "") {
  checks.push({ name, status: "ok", detail });
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}

function bad(name, detail = "") {
  checks.push({ name, status: "fail", detail });
  failures.push(`${name}${detail ? `：${detail}` : ""}`);
  console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name, detail = "") {
  checks.push({ name, status: "skip", detail });
  console.log(`  · 跳过 ${name}${detail ? ` — ${detail}` : ""}`);
}

function log(message) {
  console.log(`[verify] ${message}`);
}

async function get(url, { timeoutMs = 10_000 } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  return { status: response.status, text };
}

async function postJson(url, body, { timeoutMs = 30_000 } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(url).origin, "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function waitForReady(baseUrl, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return "exited";
    try {
      const response = await get(`${baseUrl}/`, { timeoutMs: 5_000 });
      if (response.status === 200 && /<title>\s*Pidance/i.test(response.text)) return "ready";
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return "timeout";
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function waitExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function resolveServiceEntry(appDir, explicit) {
  if (explicit) {
    const candidate = path.isAbsolute(explicit) ? explicit : path.join(appDir, explicit);
    return fs.existsSync(candidate) ? candidate : null;
  }
  for (const rel of [PACKAGED_SERVICE_REL, DEV_TREE_SERVICE_REL]) {
    const candidate = path.join(appDir, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveNodeBinary(appDir, explicit) {
  if (explicit) return { bin: explicit, electron: false };
  const winExe = path.join(appDir, "Pidance Desktop.exe");
  if (fs.existsSync(winExe)) return { bin: winExe, electron: true };
  return { bin: process.execPath, electron: false };
}

/** 从 `>=22.19.0` / `^22.19.0` 这类范围里取出最低版本。 */
function minVersionFromRange(range) {
  if (typeof range !== "string") return null;
  const match = range.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function versionAtLeast(actual, minimum) {
  const parse = (value) => String(value).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(actual);
  const b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/**
 * 真建一个 PTY 并跑一次输入输出往返。
 *
 * 只查 `/api/pty` 的 available 不能证明原生模块能用。这里发一条 `echo <标记>`，标记出现
 * **两次**才算成功：一次是终端回显我们发过去的输入，一次是 shell 真的执行后打出来的结果。
 * 不依赖 shell 的错误文案（本机 bash 就是中文 locale，回显是「未找到命令」），也不依赖
 * shell 类型（bash / PowerShell / cmd 的 echo 都直接打出标记）。
 */
function probePtyRoundTrip(port, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const marker = `PIDANCE-PTY-${randomBytes(3).toString("hex")}`;
    const probe = `echo ${marker}`;
    let settled = false;
    let socket = null;
    let collected = "";
    let retryTimer = null;
    const occurrences = () => collected.split(marker).length - 1;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      if (retryTimer) clearInterval(retryTimer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      resolve({ ok, detail });
    };
    const timer = setTimeout(
      () =>
        finish(
          false,
          `${timeoutMs}ms 内没看到 ${marker} 被真正执行（出现 ${occurrences()} 次）；已收到 ${collected.length} 字符：${collected.slice(0, 160)}`,
        ),
      timeoutMs,
    );
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}/api/pty`);
    } catch (error) {
      clearTimeout(timer);
      finish(false, `打不开终端：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "rs", cols: 80, rows: 24 }));
      // shell 刚起来时 readline 会丢掉输入（本机实测），所以隔一段重发一次，
      // 重发用的是同一条命令：只要它真被执行，标记就会多出一次。
      socket.send(JSON.stringify({ type: "in", d: `${probe}\r` }));
      retryTimer = setInterval(() => {
        try {
          socket.send(JSON.stringify({ type: "in", d: `${probe}\r` }));
        } catch {
          /* ignore */
        }
      }, 1_500);
    });
    socket.addEventListener("message", (event) => {
      let parsed = null;
      try {
        parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (parsed?.type === "error") {
        finish(false, `终端报错：${parsed.message}`);
        return;
      }
      if (parsed?.type !== "out" || typeof parsed.d !== "string") return;
      collected += parsed.d;
      // 标记出现两次：一次是我们发过去的输入回显，一次是 shell 执行 echo 的结果。
      if (occurrences() >= 2) {
        clearTimeout(timer);
        finish(true, `shell 执行了 ${probe}（回显 ${collected.length} 字符）`);
      }    });
    socket.addEventListener("error", () => finish(false, "终端 WebSocket 出错（node-pty 可能没加载起来）"));
    socket.addEventListener("close", () =>
      finish(false, `终端连接被服务端关闭；已收到 ${collected.length} 字符：${collected.slice(0, 160)}`),
    );
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appDir = path.resolve(args.appDir);
  const baseUrl = `http://127.0.0.1:${args.port}`;

  log(`验证目标：${args.label}（${appDir}）`);
  const serviceEntry = resolveServiceEntry(appDir, args.serviceEntry);
  if (!serviceEntry) {
    bad("定位服务入口", `在 ${appDir} 下既没有 ${PACKAGED_SERVICE_REL} 也没有 ${DEV_TREE_SERVICE_REL}`);
    return finish();
  }
  ok("定位服务入口", path.relative(appDir, serviceEntry));

  const expectedVersion = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(path.dirname(serviceEntry), "..", "package.json"), "utf8")).version ?? null;
    } catch {
      return null;
    }
  })();
  const enginesNode = (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(serviceEntry), "..", "package.json"), "utf8"));
      return minVersionFromRange(pkg.engines?.node);
    } catch {
      return null;
    }
  })();

  const { bin: nodeBin, electron } = resolveNodeBinary(appDir, args.node);
  ok("运行时", `${nodeBin}${electron ? "（ELECTRON_RUN_AS_NODE）" : ""}`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-verify-"));
  const agentDir = path.join(tempRoot, "agent");
  const workDir = path.join(tempRoot, "work");
  fs.mkdirSync(workDir, { recursive: true });

  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete env.PIDANCE_PASSWORD;
  delete env.PI_WEB_PASSWORD;
  if (electron) env.ELECTRON_RUN_AS_NODE = "1";

  // 4. 运行时 Node 版本：打包版用的是包内 Electron 自带的 Node，必须自己报出来验证
  if (electron && enginesNode) {
    const probed = spawnSync(nodeBin, ["-e", "process.stdout.write(process.versions.node)"], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    const runtimeNode = (probed.stdout ?? "").trim();
    if (runtimeNode && versionAtLeast(runtimeNode, enginesNode)) {
      ok("运行时 Node 满足 engines", `${runtimeNode} >= ${enginesNode}`);
    } else {
      bad("运行时 Node 满足 engines", `实际 ${runtimeNode || "未知"}，要求 >= ${enginesNode}；stderr ${(probed.stderr ?? "").slice(0, 200)}`);
    }
  } else if (electron) {
    skip("运行时 Node 满足 engines", "包内 package.json 没有可解析的 engines.node");
  } else {
    skip("运行时 Node 满足 engines", "本地模式用的是外部 node（CI 走包内 Electron）");
  }

  let stderr = "";
  // cwd 用服务目录，与真实壳一致（`desktop/src/main.js` 也是 `cwd: serverDir`）。
  // 不能随便找个临时目录当 cwd：Windows 上 cwd 与 dir 不同盘时，Next 会把绝对 distDir
  // 再拼一次，`join(cwd, dir, join(dir, ".next"))` → 路由清单路径错乱、服务起不来。
  const serviceDir = path.dirname(path.dirname(serviceEntry));
  const child = spawn(nodeBin, [serviceEntry, "--port", String(args.port), "--hostname", "127.0.0.1", "--no-open"], {
    cwd: serviceDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout?.on("data", () => {});

  try {
    const ready = await waitForReady(baseUrl, args.timeout * 1_000, child);
    if (ready !== "ready") {
      bad("服务就绪", `${ready}；stderr 末尾：${stderr.split("\n").slice(-6).join(" | ")}`);
      return await finish(child, tempRoot);
    }
    ok("服务就绪", `${baseUrl}/ 返回 Pidance 页面`);

    // 1&2. 页面 + 页面引用的静态资源
    const page = await get(`${baseUrl}/`, { timeoutMs: 20_000 });
    const staticPath = page.text.match(/\/_next\/static\/[^"'\\\s]+/)?.[0] ?? null;
    if (!staticPath) {
      bad("页面静态资源", "页面 HTML 里找不到 /_next/static 引用");
    } else {
      const asset = await get(`${baseUrl}${staticPath}`, { timeoutMs: 20_000 });
      if (asset.status === 200 && asset.text.length > 0) ok("页面静态资源", staticPath);
      else bad("页面静态资源", `${staticPath} → HTTP ${asset.status}，长度 ${asset.text.length}`);
    }

    // 3. 身份/版本
    try {
      const about = await get(`${baseUrl}/api/about`);
      const info = JSON.parse(about.text);
      if (about.status === 200 && (!expectedVersion || info.version === expectedVersion)) {
        ok("/api/about 版本一致", `${info.version}（包内 ${expectedVersion ?? "未知"}）`);
      } else {
        bad("/api/about 版本一致", `HTTP ${about.status}，返回 ${info.version}，包内 ${expectedVersion}`);
      }
    } catch (error) {
      bad("/api/about 版本一致", error instanceof Error ? error.message : String(error));
    }

    // 4. 原生模块（node-pty）：先确认树上确实有本平台预编译/已编译产物，
    // 否则测的是「本机能不能现场编译」。win32/darwin 走 prebuilds，linux 通常是本地编译产物。
    const ptyRoot = path.join(path.dirname(serviceEntry), "..", "..", "..", "node-pty");
    const ptyPrebuild = path.join(ptyRoot, "prebuilds", `${process.platform}-${process.arch}`);
    const ptyBuilt = path.join(ptyRoot, "build", "Release");
    if (!fs.existsSync(ptyPrebuild) && !fs.existsSync(ptyBuilt)) {
      skip(
        "原生模块 node-pty",
        `树上没有 node-pty 的 ${process.platform}-${process.arch} 产物（prebuilds 或本地编译）`,
      );
    } else {
      // 服务刚就绪时 Next 可能还挂着第二个 upgrade 监听器，会抢走同一个 socket
      // （表现为 WebSocket 刚收到首帧就被断开）。重试几次能在不改服务的前提下把这种情况
      // 与「node-pty 真的坏了」区分开：真的坏了就是四次全失败。
      let probed = { ok: false, detail: "未开始探测" };
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        probed = await probePtyRoundTrip(Number(args.port), 12_000);
        if (probed.ok) break;
        if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (probed.ok) ok("原生模块 node-pty", `终端输入输出往返（${probed.detail}）`);
      else bad("原生模块 node-pty", `连续 4 次探测都失败：${probed.detail}`);
    }

    // 5. SDK 会话（ensure_session 不调模型，只建真实会话）
    try {
      const created = await postJson(`${baseUrl}/api/agent/new`, { cwd: workDir, type: "ensure_session" });
      const payload = JSON.parse(created.text);
      const sessionId = payload.sessionId;
      if (created.status === 200 && typeof sessionId === "string" && sessionId.length > 0) {
        ok("创建 SDK 会话", sessionId);
        const light = await get(`${baseUrl}/api/agent/${encodeURIComponent(sessionId)}?light=1`);
        const state = JSON.parse(light.text);
        if (light.status === 200 && state.live === true) ok("会话在 runtime 中", "live=true");
        else bad("会话在 runtime 中", `HTTP ${light.status}，返回 ${light.text.slice(0, 200)}`);
      } else {
        bad("创建 SDK 会话", `HTTP ${created.status}，返回 ${created.text.slice(0, 300)}`);
      }
    } catch (error) {
      bad("创建 SDK 会话", error instanceof Error ? error.message : String(error));
    }

    // 6. 关停：进程必须真的退出，端口必须释放
    await stopChild(child);
    if (await waitExit(child, 15_000)) ok("服务退出", `exit=${child.exitCode ?? "signal"}`);
    else bad("服务退出", "15s 内没有退出");

    const portStillOpen = await isPortOpen(args.port);
    if (!portStillOpen) ok("端口已释放", String(args.port));
    else bad("端口已释放", `${args.port} 仍可连接`);

    const moduleErrors = stderr.match(/Cannot find module|MODULE_NOT_FOUND|Error: Cannot find package/g);
    if (!moduleErrors) ok("stderr 无模块缺失", "");
    else bad("stderr 无模块缺失", [...new Set(moduleErrors)].join(", "));
  } finally {
    await finish(child, tempRoot);
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

async function finish(child, tempRoot) {
  if (child) {
    await stopChild(child);
    if (!(await waitExit(child, 10_000))) {
      bad("进程清理", `PID ${child.pid} 未退出`);
    }
  }
  if (tempRoot) {
    if (process.argv.includes("--keep-temp")) {
      console.log(`  · 保留临时目录：${tempRoot}`);
    } else {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        ok("临时状态目录可删除", path.basename(tempRoot));
      } catch (error) {
        bad("临时状态目录可删除", error instanceof Error ? error.message : String(error));
      }
    }
  }
  const failed = failures.length > 0;
  const passed = checks.filter((check) => check.status === "ok").length;
  const skipped = checks.filter((check) => check.status === "skip").length;
  console.log(
    `${failed ? "✗" : "✓"} 验证${failed ? `失败（${failures.length} 项）` : "通过"}：${passed}/${checks.length} 项通过${
      skipped > 0 ? `，${skipped} 项跳过` : ""
    }`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`[verify] 未捕获错误：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
