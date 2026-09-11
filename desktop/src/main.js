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
 * - 打包版：asar:false 下位于 resourcesPath/app/node_modules/@henlii/pidance。
 *
 * Node 运行时：打包版使用 extraResources 内置的 node-win（Node >=22.19，
 * 与 package.json engines 一致），避免 Electron 自带 Node 版本不达标。
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, dialog, ipcMain, shell } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const lifecycle = require("./server-lifecycle.js");

const PORT = process.env.PIDANCE_PORT || "31415";
const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 45_000;
const START_HIDDEN = process.platform === "win32" && process.argv.includes("--hidden");

function resolveServerDir() {
  // 仅开发模式允许切换服务目录；安装版必须使用随应用打包的服务。
  return lifecycle.resolveServerDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    serverDirEnv: process.env.PIDANCE_SERVER_DIR,
    srcDir: __dirname,
  });
}

function resolveNodeBinary() {
  return lifecycle.resolveNodeBinary({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    existsSync: fs.existsSync,
  });
}

/** 单次探测：读回环根路径，按响应体品牌判定是不是 Pidance。 */
function requestServiceVerdict(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      const settle = () => resolve(lifecycle.looksLikePidance(body) ? "pidance" : "other");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          res.destroy();
          settle();
        }
      });
      res.on("end", settle);
      res.on("close", settle);
      res.on("error", settle);
    });
    req.on("error", () => resolve("none"));
    req.setTimeout(2_000, () => {
      req.destroy();
      resolve("none");
    });
  });
}

/** 等待服务就绪（可复用的 Pidance 才算就绪）。 */
function waitForPidance(url, timeoutMs) {
  return lifecycle.probeService({
    url,
    timeoutMs,
    request: requestServiceVerdict,
  });
}

const DEFAULT_DESKTOP_SETTINGS = {
  openAtLogin: false,
  minimizeToTray: false,
  notificationsEnabled: true,
};
const DESKTOP_SETTINGS_FILE = "desktop-settings.json";

let desktopSettings = { ...DEFAULT_DESKTOP_SETTINGS };
let child = null;
let mainWindow = null;
let tray = null;
let exiting = false;

function desktopSettingsPath() {
  return path.join(app.getPath("userData"), DESKTOP_SETTINGS_FILE);
}

function loadDesktopSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(desktopSettingsPath(), "utf8"));
    return {
      openAtLogin: raw?.openAtLogin === true,
      minimizeToTray: raw?.minimizeToTray === true,
      notificationsEnabled: raw?.notificationsEnabled !== false,
    };
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

function saveDesktopSettings() {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(desktopSettingsPath(), `${JSON.stringify(desktopSettings, null, 2)}\n`, { mode: 0o600 });
}

function applyLoginItemSettings() {
  if (process.platform !== "win32") return;
  app.setLoginItemSettings({
    openAtLogin: desktopSettings.openAtLogin,
    args: desktopSettings.minimizeToTray ? ["--hidden"] : [],
  });
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示 Pidance", click: showMainWindow },
    { type: "separator" },
    {
      label: "开机启动",
      type: "checkbox",
      checked: desktopSettings.openAtLogin,
      click: (item) => updateDesktopSetting("openAtLogin", item.checked),
    },
    {
      label: "关闭窗口时最小化到托盘",
      type: "checkbox",
      checked: desktopSettings.minimizeToTray,
      click: (item) => updateDesktopSetting("minimizeToTray", item.checked),
    },
    {
      label: "桌面通知",
      type: "checkbox",
      checked: desktopSettings.notificationsEnabled,
      click: (item) => updateDesktopSetting("notificationsEnabled", item.checked),
    },
    { label: "桌面版设置…", click: openDesktopSettings },
    { type: "separator" },
    { label: "退出", click: quitApplication },
  ]));
}

function updateDesktopSetting(key, value) {
  if (key !== "openAtLogin" && key !== "minimizeToTray" && key !== "notificationsEnabled") {
    throw new Error("Unsupported desktop setting");
  }
  if (typeof value !== "boolean") throw new Error("Desktop setting must be boolean");
  const previous = desktopSettings;
  desktopSettings = { ...desktopSettings, [key]: value };
  try {
    saveDesktopSettings();
    applyLoginItemSettings();
    updateTrayMenu();
    return desktopSettings;
  } catch (error) {
    desktopSettings = previous;
    updateTrayMenu();
    throw error;
  }
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function openDesktopSettings() {
  showMainWindow();
  mainWindow?.webContents.send("desktop-settings:open");
}

function createTray() {
  if (process.platform !== "win32") return;
  const iconPath = path.join(__dirname, "pidance-mark.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("Pidance Desktop");
  tray.on("double-click", showMainWindow);
  updateTrayMenu();
}

function quitApplication() {
  exiting = true;
  app.quit();
}

ipcMain.handle("desktop-settings:get", () => ({ ...desktopSettings }));
ipcMain.handle("desktop-settings:set", (_event, key, value) => updateDesktopSetting(key, value));
ipcMain.handle("desktop-notification:show", (_event, title, body) => {
  if (!desktopSettings.notificationsEnabled || !Notification.isSupported()) return false;
  if (typeof title !== "string" || typeof body !== "string") return false;
  const notification = new Notification({
    title: title.slice(0, 120),
    body: body.slice(0, 500),
  });
  notification.on("click", showMainWindow);
  notification.show();
  return true;
});
function stopServer() {
  // 只停本进程拉起的服务；复用外部服务时 child 为 null，绝不误杀。
  lifecycle.stopServerProcess({ child, spawnSync });
  child = null;
}

function startServer() {
  const serverDir = resolveServerDir();
  const serverBin = path.join(serverDir, "bin", "pidance.js");
  const nodeBin = resolveNodeBinary();
  const missing = lifecycle.checkServerInputs({ serverBin, nodeBin, existsSync: fs.existsSync });
  if (missing) {
    dialog.showErrorBox(
      "Pidance 启动失败",
      `${missing}\n\n请重新安装或检查安装完整性。`,
    );
    app.quit();
    return false;
  }
  const distDir = app.isPackaged ? ".next" : (process.env.PIDANCE_DIST_DIR || ".next");
  // 31415 由 Windows 安装版占用；监听地址交给 pidance-server.json 的
  // remoteEnabled 决定，不能显式传 127.0.0.1 覆盖桌面版远程访问设置。
  // 开发模式：nodeBin 就是 Electron 自身，必须以 Node 方式运行子进程，否则会再开一个
  // Electron 应用而不是 pidance 服务。打包版用内置 node.exe，不受影响。
  const runAsNode = !app.isPackaged && nodeBin === process.execPath ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  child = spawn(nodeBin, lifecycle.buildServerArgs(serverBin, PORT, HOST), {
    cwd: serverDir,
    env: { ...process.env, ...runAsNode, PIDANCE_DIST_DIR: distDir },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[pidance] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[pidance:err] ${chunk}`));
  child.on("exit", (code) => {
    console.log(`[pidance] 服务进程退出，code=${code}`);
    child = null;
    if (!exiting && mainWindow) {
      exiting = true;
      mainWindow.close();
    }
  });
  child.on("error", (error) => {
    console.error("[pidance] spawn 失败:", error);
    dialog.showErrorBox("Pidance 启动失败", `无法启动服务进程：${error.message}`);
    app.quit();
  });
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Pidance",
    icon: path.join(__dirname, "..", "assets", "pidance-logo.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on("close", (event) => {
    if (!exiting && process.platform === "win32" && desktopSettings.minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    if (process.platform !== "darwin") {
      exiting = true;
      stopServer();
      app.quit();
    }
  });
  // 导航边界：窗口只加载本机 Pidance 的 origin（URL 解析比对，不用前缀匹配——
  // "http://127.0.0.1:31415@evil.example" 前缀相同但 origin 不同）。
  // 站外链接交给系统浏览器，且只放行 http/https。
  const trustedOrigin = `http://${HOST}:${PORT}`;
  const openExternally = (target) => {
    const external = lifecycle.externalUrlFor(target);
    if (external) void shell.openExternal(external);
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (lifecycle.isTrustedOrigin(url, trustedOrigin)) return { action: "allow" };
    openExternally(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (lifecycle.isTrustedOrigin(url, trustedOrigin)) return;
    event.preventDefault();
    openExternally(url);
  });
  void mainWindow.loadURL(`http://${HOST}:${PORT}`);
  if (START_HIDDEN && desktopSettings.minimizeToTray) mainWindow.hide();
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
    desktopSettings = loadDesktopSettings();
    applyLoginItemSettings();
    createTray();
    const readyUrl = lifecycle.buildReadyUrl(HOST, PORT);
    const outcome = await lifecycle.coordinateStartup({
      probe: () => waitForPidance(readyUrl, 1_500),
      isPortBusy: () => lifecycle.isPortOpen({ host: HOST, port: Number(PORT), connect: net.connect }),
      startServer,
      waitReady: () => waitForPidance(readyUrl, START_TIMEOUT_MS),
    });
    switch (outcome) {
      case "reused":
        // 端口上确实是 Pidance（如之前启动的正式版）：复用，不重复 spawn，也不停它。
        console.log("[pidance] 检测到已运行的 Pidance 服务，直接打开窗口。");
        break;
      case "foreign-port":
        dialog.showErrorBox(
          "Pidance 启动失败",
          `端口 ${PORT} 上运行的不是 Pidance 服务。\n\n请先关闭占用该端口的程序，或改用其他端口。`,
        );
        app.quit();
        return;
      case "port-busy":
        dialog.showErrorBox(
          "Pidance 启动失败",
          `端口 ${PORT} 已被占用且未响应 HTTP。\n\n请先关闭占用该端口的程序，或改用其他端口。`,
        );
        app.quit();
        return;
      case "start-failed":
        return;
      case "not-ready":
        console.error("[pidance]", `服务在 ${START_TIMEOUT_MS}ms 内未就绪：${readyUrl}`);
        if (mainWindow) mainWindow.close();
        dialog.showErrorBox("Pidance 启动失败", `服务在 ${START_TIMEOUT_MS}ms 内未就绪：${readyUrl}`);
        app.quit();
        return;
      default:
        break;
    }
    createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform === "win32" && desktopSettings.minimizeToTray && !exiting) return;
    exiting = true;
    stopServer();
    app.quit();
  });

  // updater 升级退出时供其先停服务再 quit
  globalThis.__pidanceStopServer = () => {
    exiting = true;
    stopServer();
  };

  app.on("before-quit", () => {
    exiting = true;
    tray?.destroy();
    tray = null;
    stopServer();
  });
}
