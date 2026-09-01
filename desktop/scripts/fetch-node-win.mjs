/**
 * 下载 Windows x64 Node 运行时到 desktop/node/，供 electron-builder
 * extraResources 打入产物（打包版 pidance 服务需要 Node >=22.19）。
 *
 * 用法：
 *   node scripts/fetch-node-win.mjs
 *   node scripts/fetch-node-win.mjs --version v22.19.0
 */
import { createWriteStream, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const targetVersion = (() => {
  const idx = process.argv.indexOf("--version");
  return idx >= 0 ? process.argv[idx + 1] : "v24.18.0";
})();

const DEST = join(__dirname, "..", "node", "node.exe");
const url = `https://nodejs.org/dist/${targetVersion}/node-${targetVersion}-win-x64.zip`;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    httpsGet(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        res.resume();
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

async function main() {
  const zipPath = join(DEST, "..", `node-${targetVersion}-win-x64.zip`);
  mkdirSync(dirname(zipPath), { recursive: true });
  if (!existsSync(DEST)) {
    console.log(`[fetch-node-win] 下载 ${url}`);
    await download(url, zipPath);
    // Windows 无 unzip 命令；用内置 cpio 不支持 zip。引导用户用 tar（Win10+ 自带 bsdtar）。
    console.log(`[fetch-node-win] 解压（powershell Expand-Archive）：`);
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Force '${zipPath}' '${join(dirname(zipPath), "x")}'`,
    ], { stdio: "inherit" });
    if (r.status !== 0) {
      console.error("[fetch-node-win] 解压失败，请手动解压后把 node.exe 放到 desktop/node/");
      process.exit(1);
    }
    const extracted = join(dirname(zipPath), "x", `node-${targetVersion}-win-x64`, "node.exe");
    if (existsSync(extracted)) {
      const fs = await import("node:fs");
      fs.copyFileSync(extracted, DEST);
      console.log(`[fetch-node-win] node.exe 已就位：${DEST}`);
      rmSync(zipPath, { force: true });
      rmSync(join(dirname(zipPath), "x"), { recursive: true, force: true });
    }
  } else {
    console.log("[fetch-node-win] node.exe 已存在，跳过");
  }
}

void main();
