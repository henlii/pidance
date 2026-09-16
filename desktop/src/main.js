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
 * Node 运行时：打包版与开发版都用 Electron 自带的 Node（ELECTRON_RUN_AS_NODE=1，
 * Electron 37.10.3 自带 Node 22.21.1，满足主包 engines >=22.19）。
 *
 * 版本可见性：壳版本（app.getVersion）、内置服务版本（内置 @henlii/pidance 的
 * package.json）、已连接服务版本（`/api/about`）都会打印并在托盘/关于框里可见；
 * 复用外部服务且版本不一致时只提示，绝不停别人的进程。
 *
 * 更新：只做「托盘里手动检查 + 用户确认后下载安装」，不后台自动检查、不静默安装；
 * 安装包来自主包同名 tag 的 GitHub Release，sha256 摘要对不上或没声明就绝不执行；
 * 安装前先停掉本进程拉起的服务（外部复用不动）。
 *
 * CI 冒烟：`PIDANCE_DESKTOP_SMOKE=1` 时窗口加载完成后打印 `__PIDANCE_SMOKE__`
 * JSON 并停服务退出（非零退出码表示失败）；仅供 CI 断言真实壳能加载页面。
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, dialog, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const lifecycle = require("./server-lifecycle.js");
const updateLogic = require("./update-logic.js");

const PORT = process.env.PIDANCE_PORT || "31415";
const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 45_000;
/** 主包 engines 要求；用 Electron 自带 Node 运行时必须满足。 */
const REQUIRED_NODE_VERSION = "22.19.0";
const START_HIDDEN = process.platform === "win32" && process.argv.includes("--hidden");
/** 桌面产物（NSIS 安装包）release 仓库；与主包共用同一个 tag。 */
const UPDATE_REPO = "henlii/pidance";
/** CI 冒烟模式：加载完页面就报告并退出，不做用户可见交互。 */
const SMOKE = process.env.PIDANCE_DESKTOP_SMOKE === "1";
const SMOKE_FILE = process.env.PIDANCE_DESKTOP_SMOKE_FILE || null;

/** 冒烟结果：stdout 标记 + （可选）写入文件，便于 CI 断言。 */
function reportSmoke(payload) {
  const text = JSON.stringify(payload);
  console.log(`__PIDANCE_SMOKE__${text}`);
  if (SMOKE_FILE) {
    try {
      fs.writeFileSync(SMOKE_FILE, `${text}\n`);
    } catch (error) {
      console.error("[pidance] 写透冒烟结果失败:", error);
    }
  }
}

function resolveServerDir() {
  // 仅开发模式允许切换服务目录；安装版必须使用随应用打包的服务。
  return lifecycle.resolveServerDir({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    serverDirEnv: process.env.PIDANCE_SERVER_DIR,
    srcDir: __dirname,
  });
}

/**
 * 服务用哪个 Node 运行：始终用包内 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE=1`）。
 * Electron 37.10 自带 Node 22.21.1，满足主包 engines >=22.19，不需要另带 node.exe；
 * 原生模块（node-pty / sharp）是 NAPI 构建，两种运行时都能加载。
 * 低于 engines 的运行时由 checkServerInputs 明确报错（CI 里 verify-packaged 也会断言）。
 */
function resolveNodeBinary() {
  return { bin: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
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

/**
 * 读 `/api/about`（回环无密码时匿名可读；外部服务设了密码则 401 → 版本未知）。
 * @returns {Promise<{version: string|null, piSdkVersion: string|null}>}
 */
function fetchAbout(baseUrl) {
  const unknown = { version: null, piSdkVersion: null };
  return new Promise((resolve) => {
    const req = http.get(`${baseUrl}/api/about`, { headers: { accept: "application/json" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) req.destroy();
      });
      res.on("end", () => resolve(updateLogic.readAboutInfo(body)));
      res.on("error", () => resolve(unknown));
    });
    req.on("error", () => resolve(unknown));
    req.setTimeout(3_000, () => {
      req.destroy();
      resolve(unknown);
    });
  });
}

/** 内置服务版本：读随包 @henlii/pidance 的 package.json，失败则为空。 */
function readBundledServiceVersion() {
  try {
    const file = path.join(resolveServerDir(), "package.json");
    return updateLogic.readPackageVersion(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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
/** 本进程是否拉起了服务（false = 复用外部服务，退出时绝不停它）。 */
let spawnedService = false;
/** 壳 / 内置服务 / 已连接服务的版本快照。 */
let serviceInfo = { shell: null, bundled: null, connected: null, sdk: null, source: "unknown" };
let updateState = { status: "idle", version: null, asset: null, releaseUrl: null, error: null };
/** 同一时间只允许一个下载/安装流程。 */
let updateInProgress = false;
let versionMismatchNotified = false;

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
  const updateItem = updateState.status === "update"
    ? { label: `下载并安装 v${updateState.version}`, click: () => void installUpdate() }
    : { label: updateState.status === "checking" ? "正在检查更新…" : "检查更新…", enabled: updateState.status !== "checking", click: () => void checkForUpdates({ interactive: true }) };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示 Pidance", click: showMainWindow },
    { type: "separator" },
    { label: "关于 / 版本…", click: showAboutDialog },
    updateItem,
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

function showDialog(options) {
  return mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}

function notify(title, body) {
  if (!desktopSettings.notificationsEnabled || !Notification.isSupported()) return;
  const notification = new Notification({ title: title.slice(0, 120), body: body.slice(0, 500) });
  notification.on("click", showMainWindow);
  notification.show();
}

/** 启动失败：冒烟模式直接以非零码退出，正常模式弹框后退出。 */
function bail(message, code = 1) {
  console.error(`[pidance] ${message}`);
  if (SMOKE) {
    reportSmoke({ ok: false, stage: "startup", message });
    app.exit(code);
    return;
  }
  dialog.showErrorBox("Pidance 启动失败", message);
  app.quit();
}

/** 采集壳 / 内置服务 / 已连接服务版本，并同步托盘提示与版本不一致提醒。 */
async function refreshServiceInfo() {
  const about = await fetchAbout(`http://${HOST}:${PORT}`);
  serviceInfo = {
    shell: app.getVersion(),
    bundled: readBundledServiceVersion(),
    connected: about.version,
    sdk: about.piSdkVersion,
    source: spawnedService ? "owned" : "reused",
  };
  console.log(`[pidance] ${updateLogic.describeVersions(serviceInfo)}`);
  const mismatch =
    serviceInfo.source === "reused" &&
    Boolean(serviceInfo.bundled) &&
    Boolean(serviceInfo.connected) &&
    serviceInfo.connected !== serviceInfo.bundled;
  if (mismatch) {
    console.warn(
      `[pidance] 已连接外部服务 ${serviceInfo.connected}，与内置服务 ${serviceInfo.bundled} 不一致：当前页面由外部服务提供。`,
    );
    if (!versionMismatchNotified) {
      versionMismatchNotified = true;
      notify("Pidance Desktop", `已连接外部服务 ${serviceInfo.connected}（内置 ${serviceInfo.bundled}）`);
    }
  }
  if (tray) {
    tray.setToolTip(
      `Pidance Desktop ${serviceInfo.shell ?? ""} · 服务 ${serviceInfo.connected ?? "未知"}`.trim(),
    );
  }
  updateTrayMenu();
}

function showAboutDialog() {
  const lines = [
    `Pidance Desktop（壳）：${serviceInfo.shell ?? "未知"}`,
    `内置服务：${serviceInfo.bundled ?? "未知"}`,
    `已连接服务：${serviceInfo.connected ?? "未知"}${serviceInfo.source === "reused" ? "（外部服务）" : ""}`,
    serviceInfo.sdk ? `Pi SDK：${serviceInfo.sdk}` : null,
  ].filter(Boolean);
  if (serviceInfo.source === "reused" && serviceInfo.bundled && serviceInfo.connected !== serviceInfo.bundled) {
    lines.push(
      "",
      "提示：当前页面由外部已运行的 Pidance 服务提供；升级或卸载桌面版不会停掉该服务。",
    );
  }
  void showDialog({
    type: "info",
    title: "关于 Pidance Desktop",
    message: "Pidance Desktop",
    detail: lines.join("\n"),
    buttons: ["好"],
  });
}

/**
 * 检查更新：只读 GitHub Release 列表，只认桌面 NSIS 安装包资产。
 * 非打包（开发）模式不检查。
 */
async function checkForUpdates({ interactive = false } = {}) {
  if (!app.isPackaged || SMOKE) {
    if (interactive) {
      void showDialog({
        type: "info",
        title: "检查更新",
        message: "开发模式不检查更新",
        detail: "打包版才会连接 GitHub Release 检查桌面产物。",
        buttons: ["好"],
      });
    }
    return;
  }
  updateState = { ...updateState, status: "checking", error: null };
  updateTrayMenu();
  try {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=20`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "pidance-desktop" },
    });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
    const releases = await response.json();
    const picked = updateLogic.pickUpdateRelease(releases, app.getVersion());
    if (picked.status === "update") {
      updateState = {
        status: "update",
        version: picked.version,
        asset: picked.asset,
        releaseUrl: typeof picked.release?.html_url === "string" ? picked.release.html_url : null,
        error: null,
      };
    } else {
      updateState = { status: picked.status, version: null, asset: null, releaseUrl: null, error: null };
    }
  } catch (error) {
    updateState = {
      status: "error",
      version: null,
      asset: null,
      releaseUrl: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  updateTrayMenu();
  if (!interactive) return;
  if (updateState.status === "update") {
    const answer = await showDialog({
      type: "question",
      title: "检查更新",
      message: `发现新版本 v${updateState.version}`,
      detail: `当前版本 v${app.getVersion()}。是否现在下载并安装？\n\n安装包未做代码签名，下载后会按 Release 声明的 sha256 校验，校验不通过不会执行。`,
      buttons: ["下载并安装", "稍后"],
      defaultId: 1,
      cancelId: 1,
    });
    if (answer.response === 0) await installUpdate();
    return;
  }
  const messages = {
    "up-to-date": { message: "已是最新版本", detail: `当前版本 v${app.getVersion()}。` },
    "no-asset": { message: "未找到桌面安装包", detail: "最新 Release 里没有桌面安装包。" },
    unknown: { message: "无法判断更新", detail: "Release 列表为空或版本号无法解析。" },
    error: { message: "检查更新失败", detail: updateState.error ?? "未知错误" },
  };
  const info = messages[updateState.status] ?? { message: "未发现更新", detail: "" };
  void showDialog({ type: "info", title: "检查更新", message: info.message, detail: info.detail, buttons: ["好"] });
}

/** 打不开摘要校验时的人工退路：直接给 Release 页面。 */
function openReleasePage() {
  const url = updateState.releaseUrl ?? `https://github.com/${UPDATE_REPO}/releases`;
  void shell.openExternal(url);
}

/**
 * 流式下载安装包并顺手算 sha256：安装包 ~200MB，不整块读进内存。
 * 写到独立临时目录的 `.part`，校验通过后才改名执行（不跑固定公共路径里的可替换文件）。
 * @returns {Promise<{dir: string, part: string, digest: string, bytes: number}>}
 */
async function downloadInstaller(asset) {
  const response = await fetch(asset.browser_download_url, {
    headers: { "user-agent": "pidance-desktop" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  if (!response.body) throw new Error("下载失败：响应没有内容");
  const dir = fs.mkdtempSync(path.join(app.getPath("temp"), "pidance-update-"));
  const part = path.join(dir, `${asset.name}.part`);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), tap, fs.createWriteStream(part));
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { dir, part, digest: hash.digest("hex"), bytes };
}

/**
 * 下载并安装更新：校验 sha256 → 停掉自己拉起的服务 → 静默安装 → 退出。
 * 停服务只针对本进程拉起的服务；复用外部服务时不动它（安装包会覆盖程序文件，
 * 外部服务属于别的安装，不在本次操作范围）。
 */
async function installUpdate() {
  const { asset, version } = updateState;
  if (!asset || !asset.browser_download_url) return;
  if (updateInProgress) return;
  updateInProgress = true;
  try {
    const expected = updateLogic.parseAssetDigest(asset);
    const { dir, part, digest, bytes } = await downloadInstaller(asset);
    const verdict = updateLogic.digestVerdict(digest, expected);
    if (verdict !== "match") {
      fs.rmSync(dir, { recursive: true, force: true });
      if (verdict === "mismatch") {
        throw new Error("安装包 sha256 与 Release 声明不一致，已中止安装。");
      }
      // 没声明摘要就不执行：同一 Release 里的 sha256 不是独立签名，拿不到就宁可让用户手动装。
      const answer = await showDialog({
        type: "warning",
        title: "检查更新",
        message: "该 Release 没有可用的 sha256 摘要",
        detail: "无法确认下载是否完整，已中止自动安装。可以打开下载页面手动安装。",
        buttons: ["打开下载页面", "关闭"],
        defaultId: 0,
        cancelId: 1,
      });
      if (answer.response === 0) openReleasePage();
      return;
    }
    const target = path.join(dir, asset.name);
    fs.renameSync(part, target);
    console.log(`[pidance] 开始安装更新 v${version}：${target}（${Math.round(bytes / 1048576)} MB）`);
    exiting = true;
    stopServer();
    const installer = spawn(target, updateLogic.buildInstallerArgs(), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    installer.on("error", (error) => console.error("[pidance] 安装包启动失败:", error));
    installer.unref();
    app.quit();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[pidance] 更新失败:", message);
    updateState = { ...updateState, status: "error", error: message };
    updateTrayMenu();
    void showDialog({ type: "error", title: "检查更新", message: "更新失败", detail: message, buttons: ["好"] });
  } finally {
    updateInProgress = false;
  }
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

/**
 * IPC 调用方必须是受信任主窗口的顶层 frame，且 URL 属于本机 Pidance origin：
 * 子 frame / 被导航到站外的窗口 / 其他 webContents 一律拒绝。
 */
function assertTrustedSender(event) {
  const frame = event?.senderFrame;
  const trusted = lifecycle.isTrustedIpcSender({
    frameParent: frame ? frame.parent : "missing",
    frameUrl: frame?.url,
    senderIsMainWindow: Boolean(mainWindow) && event?.sender === mainWindow.webContents,
    trustedOrigin: `http://${HOST}:${PORT}`,
  });
  if (!trusted) throw new Error("Untrusted IPC sender");
}

ipcMain.handle("desktop-settings:get", (event) => {
  assertTrustedSender(event);
  return { ...desktopSettings };
});
ipcMain.handle("desktop-settings:set", (event, key, value) => {
  assertTrustedSender(event);
  return updateDesktopSetting(key, value);
});
ipcMain.handle("desktop-notification:show", (event, title, body) => {
  assertTrustedSender(event);
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
  spawnedService = false;
}

function startServer() {
  const serverDir = resolveServerDir();
  const serverBin = path.join(serverDir, "bin", "pidance.js");
  const { bin: nodeBin, env: nodeEnv } = resolveNodeBinary();
  const missing = lifecycle.checkServerInputs({
    serverBin,
    nodeBin,
    existsSync: fs.existsSync,
    nodeVersion: process.versions.node,
    requiredNodeVersion: REQUIRED_NODE_VERSION,
  });
  if (missing) {
    bail(`${missing}\n\n请重新安装或检查安装完整性。`);
    return false;
  }
  const distDir = app.isPackaged ? ".next" : (process.env.PIDANCE_DIST_DIR || ".next");
  // 桌面壳只服务本机：显式传 --hostname 127.0.0.1，不跟随 pidance-server.json 的远程访问开关。
  // 需要远程访问请用安装版 pidance 服务，不要靠桌面壳。
  child = spawn(nodeBin, lifecycle.buildServerArgs(serverBin, PORT, HOST), {
    cwd: serverDir,
    env: { ...process.env, ...nodeEnv, PIDANCE_DIST_DIR: distDir },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[pidance] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[pidance:err] ${chunk}`));
  child.on("exit", (code) => {
    console.log(`[pidance] 服务进程退出，code=${code}`);
    child = null;
    spawnedService = false;
    // 自己退出（关窗/升级）时正常结束；否则属于意外挂掉，必须让用户看到原因。
    if (exiting) return;
    bail(`Pidance 服务进程意外退出（code=${code}）。\n\n请看日志确认原因后重试；若反复出现，请重新安装。`);
  });
  child.on("error", (error) => {
    console.error("[pidance] spawn 失败:", error);
    bail(`无法启动服务进程：${error.message}`);
  });
  spawnedService = true;
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
  // 新窗口一律拒绝（应用只用 window.open 打开站外链接）；站外链接交给系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  const guardNavigation = (event, url) => {
    if (lifecycle.isTrustedOrigin(url, trustedOrigin)) return;
    event.preventDefault();
    openExternally(url);
  };
  mainWindow.webContents.on("will-navigate", guardNavigation);
  // 服务端 302 等重定向不触发 will-navigate，必须单独拦。
  mainWindow.webContents.on("will-redirect", guardNavigation);
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame === false) return;
      if (errorCode === -3) return; // ERR_ABORTED：重定向/重载会报，不算失败
      console.error(`[pidance] 页面加载失败 code=${errorCode} ${errorDescription} ${validatedURL}`);
      if (SMOKE) {
        reportSmoke({ ok: false, stage: "load", errorCode, errorDescription, validatedURL });
        exiting = true;
        stopServer();
        app.exit(3);
        return;
      }
      void showDialog({
        type: "error",
        title: "Pidance 加载失败",
        message: "窗口没能加载本机服务页面",
        detail: `${errorDescription}（code=${errorCode}）\n${validatedURL}`,
        buttons: ["好"],
      });
    },
  );
  // CI 冒烟：页面真的加载完成（含 _next 资源）后报告版本与标题，然后退出。
  mainWindow.webContents.on("did-finish-load", () => {
    if (!SMOKE) return;
    const title = mainWindow?.getTitle() ?? "";
    reportSmoke({
      ok: title.includes("Pidance"),
      title,
      url: mainWindow?.webContents.getURL() ?? "",
      shellVersion: serviceInfo.shell,
      bundledServiceVersion: serviceInfo.bundled,
      connectedServiceVersion: serviceInfo.connected,
      piSdkVersion: serviceInfo.sdk,
      source: serviceInfo.source,
    });
    setTimeout(() => {
      exiting = true;
      stopServer();
      app.exit(title.includes("Pidance") ? 0 : 4);
    }, 500);
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
        bail(`端口 ${PORT} 上运行的不是 Pidance 服务。\n\n请先关闭占用该端口的程序，或改用其他端口。`);
        return;
      case "port-busy":
        bail(`端口 ${PORT} 已被占用且未响应 HTTP。\n\n请先关闭占用该端口的程序，或改用其他端口。`);
        return;
      case "start-failed":
        return;
      case "not-ready":
        bail(`服务在 ${START_TIMEOUT_MS}ms 内未就绪：${readyUrl}`);
        return;
      default:
        break;
    }
    await refreshServiceInfo();
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
