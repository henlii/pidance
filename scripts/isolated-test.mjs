#!/usr/bin/env node
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 隔离 smoke 端口规范：31416（与持续测试同端口族；运行前须 stop 持续部署）。30141/31415 永不操作。
const uid = process.getuid?.() ?? "user";
const defaultRoot = join(tmpdir(), `pidance-isolated-${uid}`);
const root = resolve(process.env.PIDANCE_ISOLATED_ROOT ?? defaultRoot);
const app = join(root, "app");
const stateFile = join(root, "state.json");
const logFile = join(root, "next.log");
const port = 31416;
const host = "127.0.0.1";
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const namePattern = /^pidance-isolated-(?:\d+|user)$/;
const pidanceBin = join(app, "bin", "pidance.js");

function fail(message) { throw new Error(message); }
function state() { return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {}; }
function save(value) { mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700); writeFileSync(stateFile, JSON.stringify(value, null, 2) + "\r\n", { mode: 0o600 }); }
function assertRoot() {
  if (dirname(root) !== resolve(tmpdir()) || !namePattern.test(root.split(sep).pop())) fail("拒绝操作：隔离根目录不在允许的临时目录命名范围内");
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) fail("拒绝操作：隔离根目录不能是符号链接");
}
function sleep(milliseconds) { return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)); }
function commonAncestor(left, right) {
  let candidate = resolve(left);
  while (relative(candidate, resolve(right)) === ".." || relative(candidate, resolve(right)).startsWith(".." + sep)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}
async function free() { return new Promise((resolvePromise) => { const s = createServer(); s.once("error", () => resolvePromise(false)); s.listen(port, host, () => s.close(() => resolvePromise(true))); }); }
async function prepare() {
  assertRoot();
  if (source === root || source.startsWith(root + sep)) fail("拒绝准备：必须从源仓库运行隔离脚本");
  const modules = join(source, "node_modules");
  if (!existsSync(join(source, "package.json")) || !existsSync(modules)) fail("源仓库缺少 package.json 或 node_modules");
  const modulesTarget = realpathSync(modules);
  if (existsSync(root)) {
    const current = state();
    if (current.pid && await ownsProcess(current)) fail("拒绝准备：隔离服务仍在运行，请先 stop");
  }
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const excluded = new Set([".codegraph", ".git", ".next", "node_modules", "coverage", "dist"]);
  await cp(source, app, {
    recursive: true,
    filter: (path) => {
      const rel = relative(source, path);
      if (!rel) return true;
      const segments = rel.split(sep);
      return !excluded.has(segments[0]) && !segments.some((segment) => segment.startsWith(".env"));
    },
  });
  symlinkSync(modulesTarget, join(app, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const configPath = join(app, "next.config.ts");
  // 隔离镜像内临时副本名；不写回源仓。优先新名，避免与产品前缀混淆。
  const sourceConfigPath = join(app, "next.config.pidance-source.ts");
  if (!existsSync(configPath) || existsSync(sourceConfigPath)) fail("无法生成隔离 Next 配置：源配置缺失或保留文件已存在");
  renameSync(configPath, sourceConfigPath);
  const turbopackRoot = commonAncestor(app, modulesTarget);
  const isolatedConfig = [
    'import type { NextConfig } from "next";',
    'import sourceConfig from "./next.config.pidance-source";',
    "",
    "const isolatedConfig: NextConfig = {",
    "  ...sourceConfig,",
    "  turbopack: {",
    "    ...sourceConfig.turbopack,",
    `    root: ${JSON.stringify(turbopackRoot)},`,
    "  },",
    "};",
    "",
    "export default isolatedConfig;",
    "",
  ].join("\r\n");
  writeFileSync(configPath, isolatedConfig, { mode: 0o600 });
  save({ root, app, port, host, source, prepared: true });
  console.log(`已准备隔离镜像：${app}`);
}
async function start() {
  assertRoot();
  if (root === source || !existsSync(app)) fail("请先执行 prepare");
  if (port === 30141 || port === 31415 || !(await free())) fail("拒绝启动：127.0.0.1:31416 不空闲，或检测到禁止端口");
  const current = state(); if (current.pid && await ownsProcess(current)) fail("拒绝启动：本工具记录的服务仍在运行");
  // 生产模式与持续部署一致：复用 .next-public 产物（缺失则先增量构建）
  if (!existsSync(join(app, ".next-public", "BUILD_ID"))) {
    const nextCli = join(app, "node_modules", "next", "dist", "bin", "next");
    if (!existsSync(nextCli)) fail(`隔离镜像缺少 Next CLI：${nextCli}`);
    const build = spawnSync(process.execPath, [nextCli, "build", "--webpack"], { cwd: app, env: { ...process.env, PIDANCE_DIST_DIR: ".next-public" }, stdio: "inherit", windowsHide: true });
    if (build.status !== 0) fail("隔离 smoke 构建失败（.next-public）");
  }
  const fd = openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, [pidanceBin, "-H", host, "-p", String(port), "--no-open"], { cwd: app, env: { ...process.env, PORT: String(port), PIDANCE_DIST_DIR: ".next-public" }, stdio: ["ignore", fd, fd], detached: false });
  closeSync(fd);
  await new Promise((resolvePromise, reject) => {
    const onError = (error) => { child.off("spawn", onSpawn); reject(error); };
    const onSpawn = () => { child.off("error", onError); resolvePromise(); };
    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
  child.unref();
  const details = processDetails(child.pid);
  if (!details) fail("无法读取隔离服务进程状态");
  save({ ...current, root, app, port, host, source, pid: child.pid, processStartTime: details.startTime, command: "pidance.js 127.0.0.1:31416", logFile });
  process.once("SIGINT", () => { void stop().catch(() => {}).finally(() => process.exit(130)); });
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      save({ ...state(), pid: null });
      fail(`服务提前退出，请查看日志：${logFile}`);
    }
    try {
      const response = await fetch(`http://${host}:${port}/api/home`);
      if (response.ok && await ownsProcess(state())) { console.log("隔离服务已就绪"); return; }
    } catch {}
    await sleep(500);
  }
  if (await ownsProcess(state())) await stop();
  else save({ ...state(), pid: null });
  fail(`服务未就绪，请查看日志：${logFile}`);
}
async function ownsProcess(s) {
  if (!Number.isInteger(s.pid) || typeof s.app !== "string" || typeof s.command !== "string") return false;
  if (resolve(s.app) !== resolve(app) || !s.command.startsWith("pidance.js") || s.port !== port || s.host !== host) return false;
  const details = processDetails(s.pid);
  if (!details) return false;
  if (process.platform === "win32") {
    const actualPath = resolve(String(details.executablePath ?? "")).toLowerCase();
    const expectedPath = resolve(process.execPath).toLowerCase();
    if (!actualPath || actualPath !== expectedPath) return false;
    if (!s.processStartTime || Date.parse(details.startTime) !== Date.parse(s.processStartTime)) return false;
  } else if (details.cwd !== resolve(app)) return false;
  const commandLine = String(details.commandLine ?? "").replaceAll("\\", "/").toLowerCase();
  const expectedBin = pidanceBin.replaceAll("\\", "/").toLowerCase();
  return commandLine.includes(expectedBin);
}
function processDetails(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") {
    const script = [
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
      "if ($null -eq $p) { exit 0 }",
      "$p | Select-Object Id,Path,StartTime | ConvertTo-Json -Compress",
    ].join("; ");
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0 || !result.stdout?.trim()) return null;
    try {
      const value = JSON.parse(result.stdout.trim());
      const item = Array.isArray(value) ? value[0] ?? null : value;
      return item ? { executablePath: item.Path, startTime: item.StartTime, commandLine: "" } : null;
    } catch {
      return null;
    }
  }
  try {
    process.kill(s.pid, 0);
    const cwd = realpathSync(`/proc/${pid}/cwd`);
    const commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return { commandLine, cwd };
  } catch { return false; }
}
async function status(print = true) { const s = state(); const alive = await ownsProcess(s); if (print) console.log(JSON.stringify({ prepared: Boolean(s.prepared), alive, port: s.port ?? port, host: s.host ?? host, logFile: s.logFile }, null, 2)); return alive; }
async function smoke() {
  if (!(await status(false))) fail("隔离服务未运行");
  for (const path of ["/api/home", "/api/models", "/api/sessions"]) {
    const response = await fetch(`http://${host}:${port}${path}`);
    let shape = "非 JSON";
    try {
      const body = await response.json();
      shape = Array.isArray(body) ? `数组(${body.length})` : `对象(${Object.keys(body).slice(0, 8).join(",")})`;
    } catch {}
    console.log(`${path}: HTTP ${response.status}，${shape}`);
    if (!response.ok) fail(`只读冒烟失败：${path} 返回 HTTP ${response.status}`);
  }
}
async function stop() {
  assertRoot();
  const current = state();
  if (!current.pid) return console.log("没有本工具记录的进程");
  if (!(await ownsProcess(current))) fail("拒绝停止：PID 归属校验失败，未发送信号");
  process.kill(current.pid, "SIGTERM");
  for (let i = 0; i < 20 && await ownsProcess(current); i++) await sleep(250);
  if (await ownsProcess(current)) {
    process.kill(current.pid, "SIGKILL");
    for (let i = 0; i < 20 && await ownsProcess(current); i++) await sleep(100);
  }
  if (await ownsProcess(current)) fail("停止超时：进程仍在运行，保留 PID 记录");
  save({ ...current, pid: null });
  console.log("已停止本工具启动的服务");
}
async function clean() { assertRoot(); if (await status(false)) fail("拒绝清理：隔离服务仍在运行，请先 stop"); if (resolve(root) === resolve(tmpdir()) || !namePattern.test(root.split(sep).pop())) fail("拒绝清理：根目录校验失败"); rmSync(root, { recursive: true, force: true }); console.log("已清理隔离目录"); }
function help() {
  console.log([
    "用法：node isolated-test.mjs <prepare|start|status|smoke|stop|clean|run>",
    "默认只读；run 执行 prepare→start→smoke→stop，不自动 clean。写入测试必须另行显式实现并 opt-in。",
    "固定监听 127.0.0.1:31416；永远不操作 30141（上游 pi-web）与 31415（正式版）。",
    "运行前请先停止 local-deploy 持续测试（同端口 31416），完成后 local-deploy restart。",
    "可用 PIDANCE_ISOLATED_ROOT 指定临时根目录。",
    "根目录须符合当前用户临时目录下的 pidance-isolated-<uid>。",
  ].join("\n"));
}
const command = process.argv[2] ?? "help";
try {
  if (command === "prepare") await prepare();
  else if (command === "start") await start();
  else if (command === "status") await status();
  else if (command === "smoke") await smoke();
  else if (command === "stop") await stop();
  else if (command === "clean") await clean();
  else if (command === "run") {
    let preparedByRun = false;
    let runError;
    try {
      await prepare();
      preparedByRun = true;
      await start();
      await smoke();
    } catch (error) {
      runError = error;
    } finally {
      if (preparedByRun && existsSync(stateFile) && await status(false).catch(() => false)) {
        try { await stop(); }
        catch (error) {
          if (!runError) runError = error;
          else console.error(`停止失败：${error instanceof Error ? error.message : "操作失败"}`);
        }
      }
    }
    if (runError) throw runError;
  } else if (command === "help") help();
  else fail(`未知命令：${command}`);
} catch (error) {
  console.error(`错误：${error instanceof Error ? error.message : "操作失败"}`);
  process.exitCode = 1;
}
