#!/usr/bin/env node
/**
 * Pidance Desktop 自升级（Windows NSIS 静默替换）。
 *
 * 流程：查 GitHub Release 最新版 → 比较版本 → 下载 Pidance.Desktop.Setup.<v>.exe
 * → 校验发布 sha256.txt 中该 Setup 的哈希 → 退出当前 app → 静默运行安装器
 * （/S 覆盖安装到原位置，不弹向导）→ 安装完成（可选 relaunch）。
 *
 * 仅打包版启用（app.isPackaged）；开发模式 no-op。
 * 不做自动检查；由托盘「检查更新…」/设置页触发。
 */

const { app, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const https = require("node:https");
const crypto = require("node:crypto");

const REPO = "henlii/pidance";
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
// 桌面安装器资源名（CI 上传：Pidance.Desktop.Setup.<version>.exe + sha256.txt）
const SETUP_PREFIX = "Pidance.Desktop.Setup.";

function currentDesktopVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** 语义版本比较 a>b → 1, < → -1, == → 0（仅处理 x.y.z）。 */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "pidance-desktop-updater" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("request timeout")));
  });
}

function httpsGetText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "pidance-desktop-updater" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("request timeout")));
  });
}

/** 下载到临时文件，返回 { file, size }。 */
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, { headers: { "User-Agent": "pidance-desktop-updater" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} downloading installer`));
        file.destroy();
        return;
      }
      const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (total > 0 && onProgress) onProgress(received / total);
      });
      res.pipe(file);
    });
    req.on("error", (error) => {
      file.destroy();
      reject(error);
    });
    file.on("finish", () => file.close(() => resolve({ file: destPath, size: received })));
    file.on("error", reject);
  });
}

/** 解析 sha256.txt（每行 "<HASH>  <name>" 或 "<HASH> *name"），取 Setup 行。 */
function shaForSetup(shaText, setupName) {
  for (const line of String(shaText).split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})[ \t]+(?:\*?)(.+)$/.exec(line.trim());
    if (m && m[2].trim() === setupName) return m[1].toLowerCase();
  }
  return null;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * 检查并返回可升级信息（不自动下载）。
 * @returns {{updateAvailable:boolean, currentVersion:string|null, latestVersion:string|null,
 *            setupAsset:string|null, downloadUrl:string|null, size:number|null}|{error:string}}
 */
async function checkForUpdate() {
  const current = currentDesktopVersion();
  if (!app.isPackaged) return { updateAvailable: false, currentVersion: current, latestVersion: current, reason: "dev" };
  try {
    const release = await httpsGetJson(API_LATEST);
    const tag = String(release.tag_name || "").replace(/^v/, "");
    if (!tag) return { updateAvailable: false, currentVersion: current, latestVersion: null, reason: "no-tag" };
    if (compareVersions(tag, current) <= 0) {
      return { updateAvailable: false, currentVersion: current, latestVersion: tag, reason: "latest" };
    }
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const setup = assets.find((asset) => typeof asset.name === "string"
      && asset.name.startsWith(SETUP_PREFIX) && asset.name.toLowerCase().endsWith(".exe"));
    const shaAsset = assets.find((asset) => asset.name === "sha256.txt");
    if (!setup || !shaAsset) {
      return { updateAvailable: false, currentVersion: current, latestVersion: tag, reason: "missing-assets" };
    }
    return {
      updateAvailable: true,
      currentVersion: current,
      latestVersion: tag,
      setupAsset: setup.name,
      downloadUrl: setup.browser_download_url,
      size: typeof setup.size === "number" ? setup.size : null,
      shaUrl: shaAsset.browser_download_url,
    };
  } catch (error) {
    return { updateAvailable: false, currentVersion: current, latestVersion: null, error: String(error?.message || error) };
  }
}

let applyingUpdate = false;

/** 升级主流程：确认 → 下载 → 校验 → 退 app → 静默安装。返回对话框语义。 */
async function applyUpdate(parentWindow) {
  if (applyingUpdate) return { applied: false, message: "updater already running" };
  if (!app.isPackaged) {
    dialog.showMessageBox(parentWindow, {
      type: "info",
      message: "开发模式不提供自动升级",
      detail: "请直接拉取最新代码运行。",
    });
    return { applied: false, message: "dev-mode" };
  }
  applyingUpdate = true;
  try {
    const info = await checkForUpdate();
    if (info.error) throw new Error(info.error);
    if (!info.updateAvailable) {
      dialog.showMessageBox(parentWindow, {
        type: "info",
        message: "已是最新版本",
        detail: `当前版本：v${info.currentVersion}${info.latestVersion ? `（最新 v${info.latestVersion}）` : ""}`,
      });
      return { applied: false, message: "no-update" };
    }

    const choice = await dialog.showMessageBox(parentWindow, {
      type: "question",
      buttons: ["下载并升级", "稍后"],
      defaultId: 0,
      cancelId: 1,
      message: `发现新版本 v${info.latestVersion}`,
      detail: `当前 v${info.currentVersion} → v${info.latestVersion}\n将下载安装包（约 ${info.size ? `${Math.round(info.size / 1e6)} MB` : "较大"}）并自动覆盖安装，期间会退出 Pidance。`,
    });
    if (choice.response !== 0) return { applied: false, message: "declined" };

    const tmpDir = app.getPath("temp");
    const setupPath = path.join(tmpDir, `${info.setupAsset}.dl`);
    const shaPath = path.join(tmpDir, `${info.setupAsset}.sha256.txt`);
    try {
      fs.unlinkSync(setupPath);
      fs.unlinkSync(shaPath);
    } catch { /* not exists */ }

    await dialog.showMessageBox(parentWindow, {
      type: "info",
      message: "开始下载更新…",
      detail: `正在下载 v${info.latestVersion} 安装包，完成后会自动安装并重启。窗口可能短暂无响应属正常。`,
    });

    await downloadFile(info.downloadUrl, setupPath);
    const shaText = await httpsGetText(info.shaUrl);
    fs.writeFileSync(shaPath, shaText, "utf8");

    const expected = shaForSetup(shaText, info.setupAsset);
    if (!expected) throw new Error("sha256.txt 中找不到安装包校验行");
    const actual = await sha256File(setupPath);
    if (actual !== expected) {
      fs.unlinkSync(setupPath);
      throw new Error(`校验失败：期望 ${expected}，实际 ${actual}`);
    }

    // 校验通过：退出当前实例，静默运行安装器覆盖安装。
    const installerArgs = ["/S"];
    dialog.showMessageBox(parentWindow, {
      type: "info",
      message: "校验通过，开始安装",
      detail: "Pidance 即将退出并自动升级，请稍候片刻后重新打开。",
    });
    if (typeof globalThis.__pidanceStopServer === "function") globalThis.__pidanceStopServer();
    app.quit();
    const installer = spawn(info.setupAsset.includes(" ") ? `"${setupPath}"` : setupPath, installerArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: true,
    });
    installer.unref();
    return { applied: true, message: "installer-spawned" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showMessageBox(parentWindow, {
      type: "error",
      message: "升级失败",
      detail: message,
    });
    return { applied: false, message };
  } finally {
    applyingUpdate = false;
  }
}

module.exports = { checkForUpdate, applyUpdate, compareVersions };
