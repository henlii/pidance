#!/usr/bin/env node
/**
 * Pidance Desktop（Electron 壳）。
 *
 * 职责：把 pidance 服务进程（bin/pidance.js）当作子进程拉起，等端口就绪后用
 * 内置窗口显示。关闭窗口 → 停服务进程 → 退出。不注入任何 Node 能力到页面
 * （contextIsolation + sandbox，页面仍是原 Web UI 的 OAuth 流程）。
 *
 * 服务端解析：
 * - 开发（app.isPackaged=false）：PIDANCE_SERVER_DIR 优先，其次仓库根
 *   （desktop/ 上一级）。
 * - 打包版：进程内资源根 resourcesPath 下 node_modules/@henlii/pidance。
 *
 * Node 运行时：打包版使用 extraResources 内置的 node-win（Node >=22.19，
 * 与 package.json engines 一致），避免 Electron 自带 Node 版本不达标。
 */

const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PORT = process.env.PIDANCE_PORT || "31415";
const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 45_000;

function resolveServerDir() {
  if (process.env.PIDANCE_SERVER_DIR) return process.env.PIDANCE_SERVER_DIR;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "node_modules", "@henlii", "pidance");
  }
  // 开发：desktop/ 上一级（仓库根）
  return path.resolve(__dirname, "..", "..");
}

function resolveNodeBinary() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "node", "node.exe");
    return fs.existsSync(bundled) ? bundled : process.execPath;
  }
  return process.execPath;
}

function probeReady(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        // 401（认证门禁）等任何 HTTP 响应都表示服务已就绪
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) {
          reject(new Error(`服务在 ${timeoutMs}ms 内未就绪：${url}`));
          return;
        }
        setTimeout(tick, 500);
      });
      req.setTimeout(2_000, () => {
        req.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`服务探测超时：${url}`));
        } else {
          setTimeout(tick, 500);
        }
      });
    };
    tick();
  });
}

let child = null;
let mainWindow = null;
let exiting = false;

function stopServer() {
  if (child && !child.killed) {
    child.kill();
  }
  child = null;
}

function startServer() {
  const serverDir = resolveServerDir();
  const serverBin = path.join(serverDir, "bin", "pidance.js");
  if (!fs.existsSync(serverBin)) {
    dialog.showErrorBox(
      "Pidance 启动失败",
      `未找到 pidance 服务入口：\n${serverBin}\n\n请重新安装或检查安装完整性。`,
    );
    app.quit();
    return;
  }
  const nodeBin = resolveNodeBinary();
  child = spawn(nodeBin, [serverBin, "--hostname", HOST, "--port", PORT, "--no-open"], {
    cwd: serverDir,
    env: { ...process.env, PIDANCE_DIST_DIR: process.env.PIDANCE_DIST_DIR || ".next" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[pidance] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[pidance:err] ${chunk}`));
  child.on("exit", (code) => {
    console.log(`[pidance] 服务进程退出，code=${code}`);
    child = null;
    if (!exiting && mainWindow) {
      mainWindow.close();
    }
  });
  child.on("error", (error) => {
    console.error("[pidance] spawn 失败:", error);
    dialog.showErrorBox("Pidance 启动失败", `无法启动服务进程：${error.message}`);
    app.quit();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Pidance",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (process.platform !== "darwin") {
      exiting = true;
      stopServer();
      app.quit();
    }
  });
  void mainWindow.loadURL(`http://${HOST}:${PORT}`);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const readyUrl = `http://${HOST}:${PORT}/api/home`;
    try {
      // 端口已有实例（如之前启动的正式版 pidance）：直接复用，不重复 spawn。
      await probeReady(readyUrl, 1_500);
      console.log("[pidance] 检测到已运行的服务，直接打开窗口。");
    } catch {
      startServer();
      await probeReady(readyUrl, START_TIMEOUT_MS).catch((error) => {
        console.error("[pidance]", error.message);
        if (mainWindow) mainWindow.close();
        dialog.showErrorBox("Pidance 启动失败", error.message);
        app.quit();
        return;
      });
    }
    createWindow();
  });

  app.on("window-all-closed", () => {
    exiting = true;
    stopServer();
    app.quit();
  });

  app.on("before-quit", () => {
    exiting = true;
    stopServer();
  });
}
