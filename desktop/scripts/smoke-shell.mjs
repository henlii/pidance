#!/usr/bin/env node
"use strict";

/**
 * 真实 Electron 壳冒烟（CI 用）：用 `PIDANCE_DESKTOP_SMOKE=1` 启动壳，断言
 *   1. 窗口真的把页面加载完（壳写出 __PIDANCE_SMOKE__ 结果，title 含 Pidance）；
 *   2. 壳自己拉起了内置服务（source=owned）并报告了已连接服务版本；
 *   3. 退出码 0，退出后没有残留壳进程、端口已释放、临时状态目录可删除。
 *
 * 状态隔离：`PI_CODING_AGENT_DIR` 指向临时目录，不碰真实 ~/.pi/agent。
 *
 * 用法：node scripts/smoke-shell.mjs --app-dir <解包或安装目录> [--port 31421] [--timeout 180]
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = { appDir: null, port: 31421, timeout: 180 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--app-dir") args.appDir = argv[i += 1];
    else if (arg === "--port") args.port = Number.parseInt(argv[i += 1] ?? "31421", 10);
    else if (arg === "--timeout") args.timeout = Number.parseInt(argv[i += 1] ?? "180", 10);
    else throw new Error(`未知参数：${arg}`);
  }
  if (!args.appDir) throw new Error("缺少 --app-dir");
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPortBusy(port) {
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

function execPathFor(appDir) {
  const name = process.platform === "win32" ? "Pidance Desktop.exe" : "pidance-desktop";
  return path.join(appDir, name);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appDir = path.resolve(args.appDir);
  const exe = execPathFor(appDir);
  if (!fs.existsSync(exe)) throw new Error(`找不到壳可执行文件：${exe}`);
  console.log(`[shell-smoke] 启动 ${exe}`);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-shell-smoke-"));
  const resultFile = path.join(temp, "result.json");
  const env = {
    ...process.env,
    PIDANCE_DESKTOP_SMOKE: "1",
    PIDANCE_DESKTOP_SMOKE_FILE: resultFile,
    PIDANCE_PORT: String(args.port),
    PI_CODING_AGENT_DIR: path.join(temp, "agent"),
  };
  delete env.PIDANCE_PASSWORD;
  delete env.PI_WEB_PASSWORD;

  let stdout = "";
  let stderr = "";
  const child = spawn(exe, ["--disable-gpu"], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  const failures = [];
  try {
    const deadline = Date.now() + args.timeout * 1_000;
    while (Date.now() < deadline && child.exitCode === null && !fs.existsSync(resultFile)) {
      await sleep(500);
    }
    if (!fs.existsSync(resultFile)) {
      failures.push(
        `壳没有写出冒烟结果（exit=${child.exitCode ?? "running"}）：stdout 末尾 ${stdout.split("\n").slice(-4).join(" | ")}；stderr 末尾 ${stderr.split("\n").slice(-4).join(" | ")}`,
      );
      return;
    }

    const payload = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    if (payload.ok !== true) failures.push(`页面没有正常加载：${JSON.stringify(payload)}`);
    else console.log(`[shell-smoke] 页面加载完成：title=${payload.title} url=${payload.url}`);
    if (payload.source !== "owned") failures.push(`预期壳自己拉起服务（source=owned），实际 ${payload.source}`);
    if (!payload.connectedServiceVersion) failures.push("壳没有报告已连接服务版本");
    if (payload.bundledServiceVersion && payload.connectedServiceVersion !== payload.bundledServiceVersion) {
      failures.push(`内置服务 ${payload.bundledServiceVersion} 与已连接服务 ${payload.connectedServiceVersion} 不一致`);
    }
    console.log(
      `[shell-smoke] 版本：壳 ${payload.shellVersion} · 内置服务 ${payload.bundledServiceVersion} · 已连接服务 ${payload.connectedServiceVersion}`,
    );

    if (!(await waitExit(child, 60_000))) failures.push("壳在写结果后 60s 内没有退出");
    else if (child.exitCode !== 0) failures.push(`壳退出码 ${child.exitCode}（预期 0）`);
    else console.log("[shell-smoke] 退出码 0");

    if (await isPortBusy(args.port)) failures.push(`端口 ${args.port} 退出后仍被占用`);

    if (process.platform === "win32") {
      const listed = spawnSync("tasklist", ["/FI", "IMAGENAME eq Pidance Desktop.exe", "/NH"], { encoding: "utf8" });
      if ((listed.stdout ?? "").includes("Pidance Desktop.exe")) {
        failures.push(`退出后仍有壳进程：${listed.stdout.trim()}`);
      }
    }

    try {
      fs.rmSync(temp, { recursive: true, force: true });
      console.log(`[shell-smoke] 临时状态目录可删除`);
    } catch (error) {
      failures.push(`临时状态目录无法删除（可能有文件锁）：${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    if (child.exitCode === null) {
      child.kill();
      spawnSync(process.platform === "win32" ? "taskkill" : "kill", process.platform === "win32" ? ["/pid", String(child.pid), "/T", "/F"] : [String(child.pid)], { stdio: "ignore" });
    }
  }

  if (failures.length > 0) {
    console.error(`[shell-smoke] 失败：`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log("[shell-smoke] 通过");
}

main().catch((error) => {
  console.error(`[shell-smoke] 未捕获错误：${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
