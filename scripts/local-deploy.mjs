#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";

// Windows 不提供 systemd / procfs；转发到等价的 Node 子进程实现。
// 保留本文件作为统一入口，避免不同平台改变开发者和 skill 中的命令。
if (process.platform === "win32") {
  const windowsScript = fileURLToPath(new URL("../../../../scripts/local-deploy-win.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [windowsScript, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) console.error(`Windows 持续部署入口启动失败：${result.error.message}`);
  process.exit(result.error ? 1 : (result.status ?? 1));
}

// 这是 Linux 本地开发工具；使用 systemd transient unit + /proc 做归属校验，避免 PID 重用误杀。
// 持续测试端口规范：31416。30141 上游 pi-web / 31415 正式版永不操作。
const repository = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../"));
const host = "0.0.0.0";
const port = 31416;
const url = "http://127.0.0.1:31416/api/home";
const uid = process.getuid?.() ?? "user";
const unitName = `pidance-local-31416-${uid}.service`;
const memoryHigh = "3G";
const memoryMax = "4G";
const stateRoot = join(tmpdir(), `pidance-local-31416-${uid}`);
const stateFile = join(stateRoot, "state.json");
const logFile = join(stateRoot, "next.log");
const persistentLogFile = `/var/log/${unitName}.log`;
const nextCliPreferred = join(repository, "node_modules", "next", "dist", "bin", "next");
const nextCliFallback = join(repository, "node_modules", ".bin", "next");
const envPassThrough = [
  "HOME",
  "PATH",
  "NODE_OPTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  // 外部 Pi RPC 运行时（阶段 1+）：inprocess|rpc
  "PIDANCE_AGENT_RUNTIME",
  "PIDANCE_PI_RUNTIME",
  "PIDANCE_PI_RUNTIME_FALLBACK_BUNDLED",
  "PI_SUBAGENT_PI_BINARY",
];
const currentUnitPattern = /^pidance-local-31416-(?:\d+|user)\.service$/;
const currentStateDirPattern = /^pidance-local-31416-(?:\d+|user)$/;

function fail(message) { throw new Error(message); }
function assertUnitName() {
  if (!currentUnitPattern.test(unitName)) {
    fail("拒绝操作：systemd unit 名不符合固定安全命名规则");
  }
}
function readState() { return existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {}; }
function saveState(state) {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\r\n`, { mode: 0o600 });
  chmodSync(stateFile, 0o600);
}
function assertStateRoot() {
  const normalized = resolve(stateRoot);
  if (!normalized.startsWith(resolve(tmpdir()) + sep) || !currentStateDirPattern.test(normalized.split(sep).pop())) {
    fail("拒绝操作：状态目录不符合本地部署安全命名规则");
  }
}
function resolveNextCli() {
  if (existsSync(nextCliPreferred)) return nextCliPreferred;
  if (existsSync(nextCliFallback)) return nextCliFallback;
  fail("找不到 Next CLI：请先在仓库根目录安装依赖（node_modules/next）");
}
/**
 * 比较 vX.Y.Z 形式的 node 版本目录名（nvm 的命名）。
 */
function compareNodeVersions(left, right) {
  const a = left.replace(/^v/, "").split(".").map(Number);
  const b = right.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
/**
 * 构建与服务进程所用的 node 绝对路径。
 *
 * PATH 上的 `node` 可能落到系统包管理器装的旧版本（本机 /usr/bin/node v18），
 * 而 next build 要求 >=20.9。因为 restart 先停后建，一旦拖到构建阶段才失败，
 * 31416 会被留在停止状态。所以这里固定取 nvm 下最新的版本；找不到 nvm 目录时
 * 回退当前进程的 node（保持原有行为）。
 */
function resolveNodeBin() {
  const root = join(homedir(), ".nvm", "versions", "node");
  if (existsSync(root)) {
    const newest = readdirSync(root)
      .filter((name) => existsSync(join(root, name, "bin", "node")))
      .sort(compareNodeVersions)
      .pop();
    if (newest) return { bin: join(root, newest, "bin", "node"), version: newest.replace(/^v/, "") };
  }
  return { bin: process.execPath, version: process.versions.node };
}
const nodeRuntime = resolveNodeBin();
// 与 node_modules/next 的 engines 保持一致。
const minNodeMajor = 20;
const minNodeMinor = 9;
function assertNodeBin() {
  const [major, minor] = nodeRuntime.version.split(".").map(Number);
  if (major < minNodeMajor || (major === minNodeMajor && minor < minNodeMinor)) {
    fail(`node 版本过低：${nodeRuntime.bin} 解析为 v${nodeRuntime.version}，next build 要求 >=${minNodeMajor}.${minNodeMinor}。请安装满足要求的 node（nvm 下最新版本会被自动选用）。`);
  }
}
/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * 第三参 env 必须合并进 spawn，否则 PIDANCE_DIST_DIR 等不会生效（曾导致
 * 测试构建写到默认 .next、ignoreBuildErrors 不生效、unit 读到陈旧 .next-public）。
 */
function runTool(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    cwd: options.cwd ?? repository,
    env: options.env ?? process.env,
    shell: false,
  });
}
// 持久 unit 属于 systemd 系统服务，普通开发用户读取状态无需提权，
// 但 stop/start/kill/reset 必须通过非交互 sudo，避免 polkit 等待导致部署卡死。
function runSystemctl(args) {
  return process.getuid?.() === 0
    ? runTool("systemctl", args)
    : runTool("sudo", ["-n", "systemctl", ...args]);
}
function runPrivileged(command, args) {
  return process.getuid?.() === 0
    ? runTool(command, args)
    : runTool("sudo", ["-n", command, ...args]);
}
function parseSystemctlShow(text) {
  const props = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    props[line.slice(0, index)] = line.slice(index + 1);
  }
  return props;
}
function unitShow(name = unitName) {
  if (name !== unitName) fail("拒绝查询：仅允许当前 unit 名");
  assertUnitName();
  const result = runTool("systemctl", [
    "show",
    name,
    "--property=ActiveState,SubState,MainPID,WorkingDirectory,FragmentPath,MemoryHigh,MemoryMax,ExecMainStart,Id,Names,LoadState",
    "--no-pager",
  ]);
  if (result.error) fail(`无法执行 systemctl：${result.error.message}`);
  const props = parseSystemctlShow(result.stdout || "");
  if (!props.LoadState || props.LoadState === "not-found") return null;
  if (props.Id && props.Id !== name && !(props.Names || "").split(" ").includes(name)) return null;
  return props;
}
async function processDetails(pid) {
  try {
    process.kill(pid, 0);
    const cwd = realpathSync(`/proc/${pid}/cwd`);
    const commandLine = (await readFile(`/proc/${pid}/cmdline`)).toString("utf8").replaceAll("\0", " ");
    return { cwd, commandLine };
  } catch {
    return null;
  }
}
function fingerprintFromProps(props, expectedUnit = unitName) {
  if (!props) return false;
  if (props.Id && props.Id !== expectedUnit) return false;
  const workingDirectory = props.WorkingDirectory || "";
  if (workingDirectory && workingDirectory !== repository) return false;
  return true;
}
async function fingerprintMainPid(pid, expectedPort = port) {
  if (!pid || pid <= 0) return false;
  const details = await processDetails(pid);
  if (!details) return false;
  if (details.cwd !== repository) return false;
  // 31416：自管 HTTP（bin/pidance.js）或过渡期 next start / next-server。
  // cwd===repository 已保证是本仓；端口由 unit -p 31416 保证。
  const cmd = details.commandLine;
  return /pidance\.js/.test(cmd) || /pidance-http-server\.js/.test(cmd)
    || (/next/.test(cmd) && (/start/.test(cmd) || /next-server/.test(cmd)));
}
async function deployAlive() {
  const props = unitShow();
  if (!props) return { alive: false, props: null, pid: null };
  if (!fingerprintFromProps(props)) return { alive: false, props, pid: null, fingerprintFailed: true };
  const pid = Number(props.MainPID || 0);
  const active = props.ActiveState === "active";
  if (!active || pid <= 0) return { alive: false, props, pid: pid > 0 ? pid : null };
  if (!(await fingerprintMainPid(pid))) return { alive: false, props, pid, fingerprintFailed: true };
  return { alive: true, props, pid };
}
async function portFree() {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen(port, host, () => server.close(() => done(true)));
  });
}
async function waitForHealth() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      // 启用 PI_WEB_PASSWORD 时，中间件会在应用路由前返回 401；这同样证明
      // 本仓 Next 服务已监听。进程归属仍由后续 unit/PID/cwd 指纹校验确认。
      if ((response.status >= 200 && response.status < 300) || response.status === 401) return true;
    } catch {
      // 服务尚未监听，继续等待。
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  return false;
}
/**
 * 31416 开发测试部署：生产模式 next build → .next-public（隔离，不污染 dev 的 .next）。
 * 整条链路只在这里 build 一次；持久 unit 不再 ExecStartPre build，避免双 build。
 * 崩溃自启复用已有产物；代码变更必须走 local-deploy restart（或显式 build）。
 *
 * 构建器：Turbopack（--turbopack），非 webpack。
 * - 温构建目标：几十秒级（依赖 .next-public/cache 保留 + 跳过 typecheck）。
 * - 发布/正式安装仍用 `npm run build`（--webpack），与本路径分离。
 * - 本机实测见 .local-ops/deploy/local-31416-build.md
 */
function buildForProduction(nextCli) {
  console.log("构建 31416 测试产物（Turbopack → .next-public；本链路唯一一次 build）……");
  const started = Date.now();
  const build = runTool(nodeRuntime.bin, [nextCli, "build", "--turbopack"], {
    cwd: repository,
    env: { ...process.env, PIDANCE_DIST_DIR: ".next-public" },
  });
  if (build.status !== 0) {
    fail(`生产构建失败：${(build.stderr || build.stdout || "").trim() || "非零退出"}`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`构建完成（${seconds}s）。`);
}

function buildSystemdRunArgs(nextCli) {
  const args = [
    "--unit", unitName,
    "--collect",
    "--no-block",
    "--working-directory", repository,
    "--property", `MemoryHigh=${memoryHigh}`,
    "--property", `MemoryMax=${memoryMax}`,
    "--property", "KillMode=control-group",
    "--property", "Restart=no",
    "--property", "TimeoutStopSec=30",
    "--property", `StandardOutput=append:${logFile}`,
    "--property", `StandardError=append:${logFile}`,
    "--property", "StandardInput=null",
    "--setenv", `PORT=${String(port)}`,
  ];
  for (const name of envPassThrough) {
    if (process.env[name] !== undefined) args.push("--setenv", name);
  }
  // 运行时自管 HTTP 的 V8 堆头寸（与 bundler 无关）。
  // 历史上 Turbopack *dev* 长跑 HMR 曾耗尽堆；31416 现为生产模式 pidance.js，不再跑 HMR。
  // 3072 is intentional headroom under MemoryMax=4G (cgroup still hard-caps the unit).
  const nodeOptions = [process.env.NODE_OPTIONS, "--max-old-space-size=3072"].filter(Boolean).join(" ").trim();
  args.push("--setenv", `NODE_OPTIONS=${nodeOptions}`);
  // 生产模式：固定 PIDANCE_DIST_DIR 隔离 .next-public，避免污染 dev 的 .next
  args.push("--setenv", "PIDANCE_DIST_DIR=.next-public");
  const pidanceBin = join(repository, "bin", "pidance.js");
  // 无 -H：默认绑定跟随 ~/.pi/agent/pidance-server.json 远程开关（0.0.0.0 / 127.0.0.1）；端口固定。
  args.push("--", nodeRuntime.bin, pidanceBin, "-p", String(port), "--no-open");
  return args;
}
// 持久 unit（/etc/systemd/system/ 下的 unit 文件）由 install-31416-daemon.mjs 安装，
// Restart=always + enable 自启；local-deploy 对持久 unit 走 systemctl 分支，
// 对 transient unit 保持 systemd-run 行为。
function isPersistentUnit() {
  const props = unitShow();
  if (props?.FragmentPath?.startsWith("/etc/systemd/system/")) return true;
  return existsSync(`/etc/systemd/system/${unitName}`);
}
function resetFailedUnit() {
  assertUnitName();
  runSystemctl(["reset-failed", unitName]);
}
async function stopUnitSafe({ requireAlive = false } = {}) {
  assertUnitName();
  const props = unitShow();
  if (!props) {
    if (requireAlive) fail("拒绝停止：目标 transient unit 不存在");
    return;
  }
  if (!fingerprintFromProps(props)) {
    fail("拒绝停止：WorkingDirectory/unit 指纹校验失败，未操作未知 unit");
  }
  const pid = Number(props.MainPID || 0);
  if (props.ActiveState === "active" && pid > 0) {
    if (!(await fingerprintMainPid(pid))) {
      fail("拒绝停止：MainPID cmdline 指纹校验失败，未发送停止信号");
    }
  } else if (requireAlive && props.ActiveState !== "failed" && props.ActiveState !== "activating" && props.ActiveState !== "deactivating") {
    return;
  }
  // 不等待 systemd 的优雅关闭；SSE/长连接可能让 server.close 等到超时，
  // 由下面的指纹轮询和兜底 SIGKILL 负责收敛，避免部署命令卡满 TimeoutStopSec。
  const stop = runSystemctl(["stop", "--no-block", unitName]);
  // 即使 systemctl 的 D-Bus 调用报告超时，也继续根据 unit/PID 指纹轮询；
  // 该调用可能已经成功提交 stop job，不能因客户端超时直接留下旧服务。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const current = unitShow();
    if (!current || current.ActiveState === "inactive" || current.ActiveState === "failed" || current.LoadState === "not-found") break;
    await new Promise((done) => setTimeout(done, 250));
  }
  const after = unitShow();
  if (after?.ActiveState === "failed" || after?.ActiveState === "inactive") resetFailedUnit();
  else if (after && after.ActiveState !== "inactive" && after.ActiveState !== "failed" && after.LoadState !== "not-found") {
    const pid = Number(after.MainPID || 0);
    if (pid <= 0 || !(await fingerprintMainPid(pid))) {
      fail("拒绝停止：停止超时后 MainPID cmdline 指纹校验失败，未发送 SIGKILL");
    }
    const kill = runSystemctl(["kill", "--kill-who=main", "-s", "SIGKILL", unitName]);
    if (kill.status !== 0) fail("unit 在 SIGTERM 后仍存活，SIGKILL 也失败");
    await new Promise((done) => setTimeout(done, 500));
    // 持久 unit（Restart=always）被 SIGKILL 后会自动拉起：补一次 stop 使其保持停止。
    if (isPersistentUnit()) {
      runSystemctl(["stop", "--no-block", unitName]);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const current = unitShow();
        if (!current || current.ActiveState === "inactive" || current.ActiveState === "failed" || current.LoadState === "not-found") break;
        await new Promise((done) => setTimeout(done, 250));
      }
    }
    resetFailedUnit();
  }
}

async function persistentStart() {
  const current = await deployAlive();
  if (current.alive) {
    console.log("持续测试部署已在运行（持久守护），未重复启动。访问：http://<本机地址>:31416");
    saveState({
      prepared: true,
      pid: current.pid,
      unit: unitName,
      host,
      port,
      url,
      source: repository,
      cwd: repository,
      logFile: persistentLogFile,
      memoryHigh,
      memoryMax,
    });
    return;
  }
  if (current.fingerprintFailed && current.props?.ActiveState === "active") {
    fail("拒绝启动：同名持久 unit 处于 active 但指纹不匹配，不会操作未知 unit");
  }
  const leftover = unitShow();
  if (leftover && !fingerprintFromProps(leftover)) {
    fail("拒绝启动：持久 unit 指纹不匹配，不会 reset/stop 未知 unit");
  }
  if (!(await portFree())) fail("拒绝启动：31416 已被未知进程占用；不会操作 30141 或 31415");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  // 持久 unit 日志由 unit 文件接管（/var/log）；状态目录仅保存 state.json
  const nextCli = resolveNextCli();
  buildForProduction(nextCli);
  // 停止路径已确保旧进程退出，这里用 start 避免 systemd restart 再次等待旧
  // SSE 长连接的关闭事务；健康检查随后确认新进程已接管端口。
  const start = runSystemctl(["start", "--no-block", unitName]);
  if (start.status !== 0) fail(`持久 unit 启动失败：${(start.stderr || start.stdout || "").trim() || "systemctl start 非零退出"}`);
  const state = {
    prepared: true,
    pid: null,
    unit: unitName,
    host,
    port,
    url,
    source: repository,
    cwd: repository,
    logFile: persistentLogFile,
    memoryHigh,
    memoryMax,
  };
  saveState(state);
  if (!(await waitForHealth())) {
    await stopUnitSafe();
    saveState({ ...state, pid: null });
    fail(`持续测试部署未通过健康检查；日志保留于：${persistentLogFile}`);
  }
  const after = await deployAlive();
  if (!after.alive) {
    await stopUnitSafe();
    saveState({ ...state, pid: null });
    fail(`健康检查通过但 unit 指纹校验失败；已停止自身 unit。日志：${persistentLogFile}`);
  }
  saveState({ ...state, pid: after.pid });
  console.log("持续测试部署已启动（持久守护）：http://<本机地址>:31416");
}
async function start() {
  assertNodeBin();
  assertStateRoot();
  assertUnitName();
  if (await isPersistentUnit()) return await persistentStart();
  const current = await deployAlive();
  if (current.alive) {
    console.log("持续测试部署已在运行，未重复启动。访问：http://<本机地址>:31416");
    saveState({
      prepared: true,
      pid: current.pid,
      unit: unitName,
      host,
      port,
      url,
      source: repository,
      cwd: repository,
      logFile,
      memoryHigh,
      memoryMax,
    });
    return;
  }
  if (current.fingerprintFailed && current.props?.ActiveState === "active") {
    fail("拒绝启动：同名 unit 处于 active 但指纹不匹配，不会操作未知 unit");
  }
  const leftover = unitShow();
  if (leftover) {
    if (!fingerprintFromProps(leftover)) {
      fail("拒绝启动：残留 unit 指纹不匹配，不会 reset/stop 未知 unit");
    }
    if (leftover.ActiveState === "active" || leftover.ActiveState === "activating" || leftover.ActiveState === "failed" || leftover.ActiveState === "deactivating") {
      await stopUnitSafe();
    } else {
      resetFailedUnit();
    }
  }
  if (!(await portFree())) fail("拒绝启动：31416 已被未知进程占用；不会操作 30141 或 31415");
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  if (!existsSync(logFile)) {
    writeFileSync(logFile, "", { mode: 0o600 });
  }
  chmodSync(logFile, 0o600);
  const nextCli = resolveNextCli();
  // 31416 是长时间运行的持续测试服务；生产模式（next start）避免 dev 按需
  // 编译抖动与 V8 堆膨胀，内存/响应稳定。
  buildForProduction(nextCli);
  const run = runPrivileged("systemd-run", buildSystemdRunArgs(nextCli));
  if (run.status !== 0) {
    fail(`systemd-run 启动失败：${(run.stderr || run.stdout || "").trim() || "非零退出"}`);
  }
  const state = {
    prepared: true,
    pid: null,
    unit: unitName,
    host,
    port,
    url,
    source: repository,
    cwd: repository,
    logFile,
    memoryHigh,
    memoryMax,
  };
  saveState(state);
  if (!(await waitForHealth())) {
    await stopUnitSafe();
    saveState({ ...state, pid: null });
    fail(`持续测试部署未通过健康检查；日志保留于：${logFile}`);
  }
  const after = await deployAlive();
  if (!after.alive) {
    await stopUnitSafe();
    saveState({ ...state, pid: null });
    fail(`健康检查通过但 unit 指纹校验失败；已停止自身 unit。日志：${logFile}`);
  }
  saveState({ ...state, pid: after.pid });
  console.log("持续测试部署已启动：http://<本机地址>:31416");
}
async function stop() {
  assertStateRoot();
  assertUnitName();
  const props = unitShow();
  const state = readState();
  if (!props && !state.pid) return console.log("持续测试部署未运行。");
  if (!props) {
    saveState({ ...state, pid: null, unit: unitName });
    return console.log("持续测试部署未运行。");
  }
  await stopUnitSafe();
  saveState({ ...readState(), prepared: true, pid: null, unit: unitName, host, port, url, source: repository, cwd: repository, logFile, memoryHigh, memoryMax });
  console.log("持续测试部署已停止；31416 应已释放。30141 与 31415 未被操作。");
}
async function restart() { assertNodeBin(); await stopIfOwned(); await start(); }
async function stopIfOwned() {
  assertStateRoot();
  assertUnitName();
  const props = unitShow();
  if (!props) {
    const state = readState();
    if (state.pid) saveState({ ...state, pid: null });
    return;
  }
  if (!fingerprintFromProps(props)) {
    if (!(await portFree())) fail("拒绝重启：31416 被未知进程占用；不会发送停止信号");
    saveState({ ...readState(), pid: null, unit: unitName });
    return;
  }
  if (props.ActiveState === "active") {
    const pid = Number(props.MainPID || 0);
    if (pid > 0 && !(await fingerprintMainPid(pid))) {
      if (!(await portFree())) fail("拒绝重启：31416 被未知进程占用；不会发送停止信号");
      saveState({ ...readState(), pid: null, unit: unitName });
      return;
    }
  }
  await stopUnitSafe();
  saveState({ ...readState(), prepared: true, pid: null, unit: unitName, host, port, url, source: repository, cwd: repository, logFile, memoryHigh, memoryMax });
}
async function status() {
  assertUnitName();
  const state = readState();
  const live = await deployAlive();
  console.log(JSON.stringify({
    prepared: Boolean(state.prepared),
    alive: live.alive,
    host,
    port,
    url,
    pid: live.pid ?? state.pid ?? null,
    unit: unitName,
    memoryHigh,
    memoryMax,
    logFile: isPersistentUnit() ? persistentLogFile : logFile,
  }, null, 2));
}
function help() {
  console.log([
    "用法：node local-deploy.mjs <start|restart|status|stop|help>",
    "这是持续本地测试部署，固定端口 31416，默认绑定跟随设置（remoteEnabled 开 → 0.0.0.0，关 → 127.0.0.1）；永远不操作 30141（上游 pi-web）与 31415（正式版）。",
    "start/restart 优先使用持久守护 unit（install-31416-daemon.mjs 安装，Restart=always + enable 自启），",
    "无持久 unit 时回退 systemd-run 创建独立 system transient unit（不继承 OpenChamber/OpenCode cgroup），",
    `unit 名固定为 pidance-local-31416-<uid>.service，MemoryHigh=${memoryHigh}、MemoryMax=${memoryMax}，NODE_OPTIONS max-old-space-size=3072，KillMode=control-group。`,
    "启动前单次执行 next build --turbopack 到 .next-public，再以绝对 node + bin/pidance.js（自管 HTTP）监听 31416。",
    "持久 unit 日志在 /var/log/pidance-local-31416-<uid>.log，transient 在状态目录 next.log；status 根据 unit 状态 + MainPID + 指纹判断 alive。",
    "隔离只读 smoke 使用 isolated-test.mjs；它监听 127.0.0.1:31416，运行前请先停止本部署，完成后再 restart。",
    "脚本仅安全传递已存在的 HOME/PATH/代理/NODE_OPTIONS 等环境变量名，不读取或复制 Pi 配置。",
  ].join("\n"));
}
const command = process.argv[2] ?? "help";
try {
  if (command === "start") await start();
  else if (command === "restart") await restart();
  else if (command === "status") await status();
  else if (command === "stop") await stop();
  else if (command === "help") help();
  else fail(`未知命令：${command}`);
} catch (error) {
  console.error(`错误：${error instanceof Error ? error.message : "操作失败"}`);
  process.exitCode = 1;
}
