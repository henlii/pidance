#!/usr/bin/env node
/**
 * 本地候选包：把当前工作区（含未提交改动）打包成本地 tgz。
 *
 * 流程与正式发布同构：镜像工作区到中性构建根 → 增量安装依赖（package-lock.json
 * 未变则复用 node_modules）→ 隔离 webpack 构建（unset TURBOPACK / PIDANCE_DIST_DIR）
 * → 生成前审计 → npm pack → 生成后审计 → sha256。
 *
 * 不做 version / tag / push / publish；制品只作本地候选（31415 交叉测试等）。
 *
 * 用法:
 *   node scripts/make-candidate-package.mjs
 *   node scripts/make-candidate-package.mjs --build-root /tmp/pidance-release-build
 *   node scripts/make-candidate-package.mjs --help
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "..");
const DEFAULT_BUILD_ROOT = path.join(os.tmpdir(), "pidance-release-build");

/** 不镜像进构建根的目录/文件（node_modules / 构建产物 / 本地治理 / 缓存 / 旧制品）。 */
const EXCLUDED_NAMES = new Set([
  "node_modules",
  ".next",
  ".next-public",
  ".git",
  ".local-ops",
  ".codegraph",
  ".slim",
  ".pi-subagents",
]);
const EXCLUDED_FILES = new Set(["tsconfig.tsbuildinfo"]);

function isExcluded(name) {
  return EXCLUDED_NAMES.has(name) || EXCLUDED_FILES.has(name) || name.endsWith(".tgz") || name.endsWith(".sha256");
}

/** 镜像目录：源 → 目标，删除目标里源已不存在的条目（排除项保留，便于增量复用）。 */
function mirrorDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (isExcluded(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      mirrorDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
    // 符号链接不复制：避免把工作区链接结构带进中性构建根。
  }
  for (const entry of fs.readdirSync(dst, { withFileTypes: true })) {
    if (isExcluded(entry.name)) continue;
    const s = path.join(src, entry.name);
    if (!fs.existsSync(s)) {
      fs.rmSync(path.join(dst, entry.name), { recursive: true, force: true });
    }
  }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(cmd, args, opts = {}) {
  const env = opts.env || process.env;
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: opts.cwd, env });
  if (result.error) {
    console.error(`[candidate] 执行失败: ${cmd} ${args.join(" ")} → ${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`[candidate] 退出码 ${result.status}: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

/** 构建/审计环境：去掉 dev/测试产物分流变量，审计需要原始工作区路径。 */
function makeAuditEnv() {
  const env = { ...process.env };
  delete env.TURBOPACK;
  delete env.PIDANCE_DIST_DIR;
  env.PIDANCE_RELEASE_SOURCE_ROOT = workspaceRoot;
  return env;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`用法:
  node scripts/make-candidate-package.mjs [--build-root <dir>]

  --build-root <dir>   隔离构建根（默认 ${DEFAULT_BUILD_ROOT}）
                       该目录会保留 node_modules 实现增量安装`);
    process.exit(0);
  }
  const idx = argv.indexOf("--build-root");
  if (idx >= 0) {
    const value = argv[idx + 1];
    if (!value || value.startsWith("-")) {
      console.error("[candidate] --build-root 需要目录参数");
      process.exit(2);
    }
    return { buildRoot: path.resolve(value) };
  }
  return { buildRoot: DEFAULT_BUILD_ROOT };
}

const { buildRoot } = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(fs.readFileSync(path.join(workspaceRoot, "package.json"), "utf8"));
const tgzName = `${pkg.name.replace(/^@/, "").replace(/\//g, "-")}-${pkg.version}.tgz`;
const tgzPath = path.join(buildRoot, tgzName);

console.log(`[candidate] 工作区: ${workspaceRoot}`);
console.log(`[candidate] 构建根: ${buildRoot}`);
console.log(`[candidate] 目标包: ${tgzName}`);

// 1. 镜像工作区（保留构建根的 node_modules / .next-public 等排除项）
console.log("[candidate] ① 镜像工作区 → 构建根 …");
mirrorDir(workspaceRoot, buildRoot);

// 2. 增量依赖：package-lock.json 未变且已有 node_modules 则跳过 npm ci
const srcLockHash = fs.existsSync(path.join(workspaceRoot, "package-lock.json"))
  ? sha256File(path.join(workspaceRoot, "package-lock.json"))
  : null;
const dstLockHash = fs.existsSync(path.join(buildRoot, "package-lock.json"))
  ? sha256File(path.join(buildRoot, "package-lock.json"))
  : null;
const hasModules = fs.existsSync(path.join(buildRoot, "node_modules"));
if (srcLockHash !== null && srcLockHash === dstLockHash && hasModules) {
  console.log("[candidate] ② 依赖: package-lock.json 未变，复用 node_modules（跳过 npm ci）");
} else {
  console.log("[candidate] ② 依赖: package-lock.json 变更或首次，npm ci …");
  run("npm", ["ci", "--no-audit", "--no-fund", "--include=dev"], { cwd: buildRoot });
}

// 3. 隔离 webpack 构建（正式产物到构建根 .next）
console.log("[candidate] ③ next build --webpack …");
// .next 由 next build 自行管理：保留产物缓存，重复打包可增量复用。
const nextBin = path.join(
  buildRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "next.cmd" : "next",
);
run(nextBin, ["build", "--webpack"], { cwd: buildRoot, env: makeAuditEnv() });

// 4. 生成前审计
console.log("[candidate] ④ 生成前审计 …");
run("node", ["scripts/audit-release-package.mjs", "--pre"], { cwd: buildRoot, env: makeAuditEnv() });

// 5. npm pack
console.log("[candidate] ⑤ npm pack …");
run("npm", ["pack", "--ignore-scripts"], { cwd: buildRoot, env: makeAuditEnv() });
if (!fs.existsSync(tgzPath)) {
  console.error(`[candidate] 未找到预期制品: ${tgzPath}`);
  process.exit(2);
}

// 6. 生成后审计（真实 tgz）
console.log("[candidate] ⑥ 生成后审计 …");
run("node", ["scripts/audit-release-package.mjs", "--tgz", tgzName], { cwd: buildRoot, env: makeAuditEnv() });

// 7. sha256
const hash = sha256File(tgzPath);
fs.writeFileSync(`${tgzPath}.sha256`, `${hash}  ${tgzName}\n`);
console.log("");
console.log(`[candidate] 完成: ${tgzPath}`);
console.log(`[candidate] SHA256: ${hash}  ${tgzName}`);
console.log("");
console.log("下一步（可选）：独立目录安装冒烟：npm install <tgz> --omit=dev");
