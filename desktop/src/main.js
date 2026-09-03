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

const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

const PORT = process.env.PIDANCE_PORT || "31415";
const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 45_000;
const START_HIDDEN = process.platform === "win32" && process.argv.includes("--hidden");

function resolveServerDir() {
  // 仅开发模式允许切换服务目录；安装版必须使用随应用打包的服务。
  if (!app.isPackaged && process.env.PIDANCE_SERVER_DIR) return process.env.PIDANCE_SERVER_DIR;
  if (app.isPackaged) {
    // asar:false 布局：electron-builder 把 app（含 node_modules/@henlii/**）
    // 放在 resources/app/ 下；与 extraResources 的 resources/node 同级。
    return path.join(process.resourcesPath, "app", "node_modules", "@henlii", "pidance");
  }
  // 开发：desktop/ 上一级（仓库根）
  return path.resolve(__dirname, "..", "..");
}

function resolveNodeBinary() {
  if (!app.isPackaged) return process.execPath;
  const bundled = path.join(process.resourcesPath, "node", "node.exe");
  return fs.existsSync(bundled) ? bundled : null;
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
  if (child && !child.killed) {
    child.kill();
  }
  child = null;
}

function startServer() {
  const serverDir = resolveServerDir();
  const serverBin = path.join(serverDir, "bin", "pidance.js");
  const nodeBin = resolveNodeBinary();
  if (!fs.existsSync(serverBin) || !nodeBin) {
    const missing = nodeBin ? `未找到 pidance 服务入口：\n${serverBin}` : "安装包缺少内置 Node 运行时";
    dialog.showErrorBox(
      "Pidance 启动失败",
      `${missing}\n\n请重新安装或检查安装完整性。`,
    );
    app.quit();
    return false;
  }
  const distDir = app.isPackaged ? ".next" : (process.env.PIDANCE_DIST_DIR || ".next");
  child = spawn(nodeBin, [serverBin, "--hostname", HOST, "--port", PORT, "--no-open"], {
    cwd: serverDir,
    env: { ...process.env, PIDANCE_DIST_DIR: distDir },
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
    const readyUrl = `http://${HOST}:${PORT}/api/home`;
    try {
      // 端口已有实例（如之前启动的正式版 pidance）：直接复用，不重复 spawn。
      await probeReady(readyUrl, 1_500);
      console.log("[pidance] 检测到已运行的服务，直接打开窗口。");
    } catch {
      if (!startServer()) return;
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
    if (process.platform === "win32" && desktopSettings.minimizeToTray && !exiting) return;
    exiting = true;
    stopServer();
    app.quit();
  });

  app.on("before-quit", () => {
    exiting = true;
    tray?.destroy();
    tray = null;
    stopServer();
  });
}
