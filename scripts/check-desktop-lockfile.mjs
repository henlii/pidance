#!/usr/bin/env node
/**
 * 桌面壳 lockfile 口径校验：`desktop/package.json` 与 `desktop/package-lock.json`
 * 必须同版本、且 `resolved` 指向与「目标版本是否已发布」相符的那份 tgz。
 *
 * 发布流程里两处必跑（见 docs/release.md 2.5 与
 * .agents/skills/pidance-development/references/release.md）：
 *   1. 版本准备、提交 chore(release) 之前：`npm run release:desktop-check`
 *   2. 发行完成、npm 传播结束后的对齐提交之前：
 *      `npm run release:desktop-check -- --stage=post`
 *
 * 退出码 0 = 通过；1 = 有必须修的不一致；2 = 连不上 registry 且没给 --stage/--offline。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkDesktopLockfile } from "./lib/desktop-lockfile.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const stageArg = (() => {
  const raw = args.find((a) => a.startsWith("--stage="))?.slice("--stage=".length);
  if (raw === undefined) return null;
  if (raw !== "pre" && raw !== "post") {
    console.error(`--stage 只接受 pre 或 post，收到：${raw}`);
    process.exit(2);
  }
  return raw;
})();
const offline = args.includes("--offline");

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8"));
}

async function publishedVersions() {
  const res = await fetch("https://registry.npmjs.org/@henlii%2Fpidance", {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  const data = await res.json();
  return Object.keys(data.versions ?? {});
}

const pkg = readJson("desktop/package.json");
const lock = readJson("desktop/package-lock.json");

let versions = [];
if (!offline) {
  try {
    versions = await publishedVersions();
  } catch (error) {
    if (stageArg === null) {
      console.error(`无法查询 npm registry（${error instanceof Error ? error.message : error}）。`);
      console.error("离线时请显式给出阶段：--stage=pre（目标版本还没发布）或 --stage=post（已发布）。");
      process.exit(2);
    }
    console.error(`（registry 查询失败，按 --stage=${stageArg} 离线校验）`);
  }
}

const result = checkDesktopLockfile({
  pkgVersion: pkg.version,
  lock,
  publishedVersions: versions,
  stage: stageArg,
});

const stageLabel = result.stage === "pre" ? "发行前（目标版本尚未上 npm）" : "发行后（目标版本已发布）";
if (result.ok) {
  console.log(`✓ desktop lockfile 口径正确（${stageLabel}）`);
  console.log(`  desktop/package.json version = ${pkg.version}`);
  console.log(`  依赖条目 resolved = ${lock.packages["node_modules/@henlii/pidance"].resolved}`);
  process.exit(0);
}

console.error(`✗ desktop lockfile 口径不一致（${stageLabel}）`);
for (const error of result.errors) console.error(`  - ${error}`);
for (const hint of result.hints) console.error(`  → ${hint}`);
console.error("");
console.error("口径说明见 docs/release.md 2.5：条目 version 跟到新版本，resolved/integrity 在发行前");
console.error("留在上一版正式 tgz，发行后再对齐到本版。");
process.exit(1);
