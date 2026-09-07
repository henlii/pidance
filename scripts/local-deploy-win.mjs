#!/usr/bin/env node
/**
 * Pidance 31416 持续测试部署（Windows）。
 *
 * 与 Linux 版 local-deploy.mjs 保持同一端口和构建产物约定，但不依赖
 * systemd、/proc 或 Unix 权限位：服务由独立 Node 子进程承载，状态和日志
 * 保存在当前用户临时目录，并在停止前通过独占控制管道校验进程归属。
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryKey = createHash("sha256").update(repository.toLowerCase()).digest("hex").slice(0, 12);
const port = 31416;
const host = "0.0.0.0";
const healthUrl = "http://127.0.0.1:31416/api/home";
const stateRoot = join(tmpdir(), `pidance-local-31416-${repositoryKey}`);
const stateFile = join(stateRoot, "state.json");
const logFile = join(stateRoot, "next.log");
const nextCli = join(repository, "node_modules", "next", "dist", "bin", "next");
const pidanceBin = join(repository, "bin", "pidance.js");
const scriptFile = fileURLToPath(import.meta.url);
const pipeName = `\\\\.\\pipe\\pidance-local-31416-${repositoryKey}`;
const stateRootName = `pidance-local-31416-${repositoryKey}`;

function fail(message) {
  throw new Error(message);
}

function assertStateRoot() {
  const tempRoot = resolve(tmpdir());
  const normalized = resolve(stateRoot);
  if (dirname(normalized) !== tempRoot || normalized.split(sep).pop() !== stateRootName) {
    fail("拒绝操作：Windows 状态目录不在允许的临时目录命名范围内");
  }
}

function readState() {
  if (!existsSync(stateFile)) return {};
  return JSON.parse(readFileSync(stateFile, "utf8"));
}

function saveState(value) {
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify(value, null, 2)}\r\n`, "utf8");
}

function runTool(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repository,
    encoding: "utf8",
    env: options.env ?? process.env,
    shell: false,
    windowsHide: true,
  });
}

function resolveNextCli() {
  if (!existsSync(nextCli)) {
    fail(`找不到 Next CLI：请先在仓库根目录安装依赖（${relative(repository, nextCli)}）`);
  }
  return nextCli;
}

function buildForProduction() {
  const cli = resolveNextCli();
  console.log("构建 31416 测试产物（Turbopack → .next-public；本链路唯一一次 build）……");
  const started = Date.now();
  const build = runTool(process.execPath, [cli, "build", "--turbopack"], {
    env: { ...process.env, PIDANCE_DIST_DIR: ".next-public" },
  });
  if (build.status !== 0) {
    fail(`生产构建失败：${(build.stderr || build.stdout || "").trim() || "非零退出"}`);
  }
  console.log(`构建完成（${((Date.now() - started) / 1000).toFixed(1)}s）。`);
}

function portFree() {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, host, () => server.close(() => done(true)));
  });
}

function probeController(state, command = "") {
  if (!Number.isInteger(state?.pid) || state.pid <= 0 || state.pipeName !== pipeName || typeof state.token !== "string") {
    return Promise.resolve({ owned: false, exists: false });
  }
  return new Promise((done) => {
    let settled = false;
    let response = "";
    const socket = createConnection(pipeName);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(result);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(800, () => finish({ owned: false, exists: true }));
    socket.once("connect", () => {
      if (command) socket.write(`${command}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\n")) finish({ owned: response.trim() === state.token, exists: true });
    });
    socket.once("error", (error) => finish({ owned: false, exists: error.code !== "ENOENT" && error.code !== "ECONNREFUSED" }));
    socket.once("close", () => finish({ owned: response.trim() === state.token, exists: true }));
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(healthUrl);
      if ((response.status >= 200 && response.status < 300) || response.status === 401) return true;
    } catch {
      // 服务尚未监听，继续等待。
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}

async function waitForExit(state) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!(await probeController(state)).exists) return true;
    await new Promise((done) => setTimeout(done, 250));
  }
  return !(await probeController(state)).exists;
}

async function stopOwned(state) {
  const before = await probeController(state);
  if (!before.exists) return;
  if (!before.owned) fail("拒绝停止：Windows 控制管道归属校验失败，未发送停止信号");
  const stopRequest = await probeController(state, "stop");
  if (!stopRequest.owned) fail("停止请求未被本仓 Windows 控制管道确认，未发送强制信号");
  if (await waitForExit(state)) {
    if (!(await portFree())) fail("控制管道已关闭但 31416 仍被占用，未继续操作未知进程");
    return;
  }

  // Windows 的 Node SIGTERM 可能无法结束子进程树；再次确认控制管道归属后才使用 taskkill。
  const beforeForce = await probeController(state);
  if (!beforeForce.owned) fail("停止超时后控制管道归属已变化，拒绝强制结束未知进程");
  const forced = runTool("taskkill.exe", ["/PID", String(state.pid), "/T", "/F"]);
  if (await waitForExit(state)) {
    if (!(await portFree())) fail("控制管道已关闭但 31416 仍被占用，未继续操作未知进程");
    return;
  }
  if (forced.status !== 0) {
    fail(`停止 31416 服务失败：${(forced.stderr || forced.stdout || "").trim() || "taskkill 非零退出"}`);
  }
  if (!(await waitForExit(state))) fail("停止 31416 服务超时：进程仍在运行");
  if (!(await portFree())) fail("停止 31416 服务后端口仍被占用，未继续操作未知进程");
}

async function runHost(token) {
  let requestStop = () => {};
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write(`${token}\n`);
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk;
      if (request.includes("\n") && request.trim() === "stop") requestStop();
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(pipeName, resolvePromise);
  });
  const child = spawn(process.execPath, [pidanceBin, "-p", String(port), "--no-open"], {
    cwd: repository,
    env: { ...process.env, PIDANCE_DIST_DIR: ".next-public" },
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  let stopping = false;
  const closeHost = (code) => {
    server.close(() => process.exit(code));
  };
  requestStop = () => {
    if (stopping) return;
    stopping = true;
    try {
      if (child.pid) process.kill(child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") console.error(`停止子服务失败：${error.message}`);
    }
    const force = setTimeout(() => {
      if (!child.pid) return closeHost(0);
      runTool("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"]);
    }, 8_000);
    force.unref();
    child.once("exit", () => {
      clearTimeout(force);
      closeHost(0);
    });
  };
  process.once("SIGTERM", requestStop);
  process.once("SIGINT", requestStop);
  child.once("error", (error) => {
    console.error(`Pidance 子服务启动失败：${error.message}`);
    closeHost(1);
  });
  child.once("exit", (code) => {
    if (!stopping) closeHost(code ?? 1);
  });
}

async function start() {
  assertStateRoot();
  const current = readState();
  if (current.pid) {
    const running = await probeController(current);
    if (running.owned) {
      console.log("持续测试部署已在运行，未重复启动。访问：http://127.0.0.1:31416");
      return;
    }
    if (running.exists) fail("拒绝启动：状态文件中的 Windows 控制管道属于未知进程，不会操作");
    saveState({ ...current, pid: null });
  }
  if (!(await portFree())) fail("拒绝启动：31416 已被未知进程占用；不会操作其他服务或 31415");
  if (!existsSync(pidanceBin)) fail(`Pidance 入口不存在：${pidanceBin}`);

  buildForProduction();
  mkdirSync(stateRoot, { recursive: true });
  const token = randomUUID();
  const logFd = openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptFile, "--host", token], {
    cwd: repository,
    detached: true,
    env: { ...process.env, PIDANCE_DIST_DIR: ".next-public" },
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  closeSync(logFd);
  await new Promise((resolvePromise, reject) => {
    const onError = (error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.off("error", onError);
      resolvePromise();
    };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  }).catch((error) => fail(`Windows 服务启动失败：${error.message}`));
  child.unref();
  if (!child.pid) fail("Windows 服务启动失败：未取得子进程 PID");

  const state = {
    prepared: true,
    alive: false,
    pid: child.pid,
    host,
    port,
    url: healthUrl,
    source: repository,
    cwd: repository,
    logFile,
    platform: "win32",
    pipeName,
    token,
  };
  saveState(state);
  if (!(await waitForHealth())) {
    if ((await probeController(state)).owned) await stopOwned(state);
    saveState({ ...state, alive: false, pid: null });
    fail(`持续测试部署未通过健康检查；日志保留于：${logFile}`);
  }
  const after = await probeController(state);
  if (!after.owned) {
    saveState({ ...state, alive: false, pid: null });
    fail(`健康检查通过但 Windows 控制管道校验失败；日志：${logFile}`);
  }
  saveState({ ...state, alive: true });
  console.log("持续测试部署已启动：http://127.0.0.1:31416");
}

async function stopIfOwned() {
  assertStateRoot();
  const current = readState();
  if (!current.pid) return;
  const running = await probeController(current);
  if (!running.exists) {
    if (!(await portFree())) fail("控制管道已关闭但 31416 仍被占用，未操作未知进程");
    saveState({ ...current, alive: false, pid: null });
    return;
  }
  if (!running.owned) fail("拒绝重启：Windows 控制管道归属校验失败，未发送停止信号");
  await stopOwned(current);
  saveState({ ...current, alive: false, pid: null });
}

async function stop() {
  await stopIfOwned();
  console.log("持续测试部署已停止；31416 应已释放。其他服务与 31415 未被操作。");
}

async function restart() {
  await stopIfOwned();
  await start();
}

async function status() {
  assertStateRoot();
  const current = readState();
  const running = await probeController(current);
  console.log(JSON.stringify({
    prepared: Boolean(current.prepared),
    alive: running.owned,
    host,
    port,
    url: healthUrl,
    pid: running.owned ? current.pid : null,
    platform: "win32",
    logFile,
  }, null, 2));
}

function help() {
  console.log([
    "用法：node local-deploy.mjs <start|restart|status|stop|help>",
    "Windows 使用独立 Node 子进程管理持续测试部署，固定端口 31416。",
    "启动前执行 next build --turbopack 到 .next-public；服务日志和状态在当前用户临时目录。",
    "永远不操作上游服务与 31415（正式版）。",
  ].join("\n"));
}

const command = process.argv[2] ?? "help";
try {
  if (command === "--host") {
    const token = process.argv[3];
    if (!/^[0-9a-f-]{36}$/i.test(token ?? "")) fail("Windows 控制管道 token 无效");
    await runHost(token);
  } else if (command === "start") await start();
  else if (command === "restart") await restart();
  else if (command === "status") await status();
  else if (command === "stop") await stop();
  else if (command === "help") help();
  else fail(`未知命令：${command}`);
} catch (error) {
  console.error(`错误：${error instanceof Error ? error.message : "操作失败"}`);
  process.exitCode = 1;
}
