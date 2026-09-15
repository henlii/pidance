#!/usr/bin/env node
"use strict";

/**
 * 桌面壳打包输入瘦身（把 CI 里的内联 pwsh 收成可测的脚本）。
 *
 * 只删「运行时不会引用」的资产，并且每一类都必须能被 desktop/scripts/verify-packaged.mjs
 * 在真实产物上验证。分类与理由：
 *
 * - cross-platform-binary：同包多平台的预编译二进制（@esbuild / @next/swc / @img / node-pty
 *   prebuilds / conpty）。目标平台之外的平台永远不可能被加载。
 * - debug-symbols：*.pdb / *.dSYM，调试符号，运行时零引用。
 * - source-maps：*.map，sourcemap 只在调试器里用。
 * - docs / examples：包内文档与示例。
 * - tests：包内测试目录与用例文件。
 * - dev-assets：next 的 dev 诊断产物、node_modules/.cache、*.tsbuildinfo。
 * - build-time-only：只有构建期被 Next 打包进 .next 的包（lucide-react 的图标已编译进产物）。
 *   这一类用 --keep-build-time 可以关掉；删掉后必须靠 verify-packaged 的页面 + _next 资源
 *   断言兜底，所以 CI 每次构建都会重新验证。
 *
 * 用法：
 *   node scripts/prune-app-tree.mjs [--root <dir>] [--platform win32] [--arch x64]
 *                                   [--dry-run] [--json] [--keep-build-time] [--top 10]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 多平台预编译二进制的包族：basename 命中 family 时，只有 keep 命中的保留。
 * keep 按目标平台生成（默认 win32-x64，与 electron-builder 的目标一致）。
 */
const TARGET_PLATFORM = "win32";
const TARGET_ARCH = "x64";

/** Next 的 SWC 原生包按平台带后缀（win32-x64-msvc / linux-x64-gnu）。 */
function swcSuffix(platform) {
  if (platform === "win32") return "-msvc";
  if (platform === "linux") return "-gnu";
  return "";
}

function platformFamilies(platform, arch) {
  const suffix = swcSuffix(platform);
  return [
    { id: "@esbuild", dir: "@esbuild", keep: new RegExp(`^${platform}-${arch}$`), filter: () => true },
    {
      id: "@next/swc",
      dir: "@next",
      keep: new RegExp(`^swc-${platform}-${arch}${suffix}$`),
      filter: (name) => name.startsWith("swc-"),
    },
    {
      id: "@img",
      dir: "@img",
      keep: new RegExp(`^(colour|sharp-${platform}-${arch}|sharp-libvips-${platform}-${arch})$`),
      filter: () => true,
    },
    {
      id: "@mariozechner/clipboard",
      dir: "@mariozechner",
      keep: new RegExp(`^clipboard(-${platform}-${arch}(-msvc|-gnu|-musl)?)?$`),
      filter: () => true,
    },
  ];
}

/** 目录内以「平台-架构」命名的子目录（node-pty 的 prebuilds 与 conpty 资产）。 */
function platformDirRules(platform, arch) {
  return [
    { id: "node-pty/prebuilds", parent: /(^|\/)node-pty\/prebuilds$/, keep: new RegExp(`^${platform}-${arch}$`) },
    {
      id: "node-pty/conpty",
      parent: /(^|\/)node-pty\/third_party\/conpty\/[^/]+$/,
      keep: platform === "win32" ? /^win10-x64$/ : /^$/,
    },
  ];
}

/** 按目录名整块删掉的类别。 */
const DIRECTORY_CATEGORIES = [
  { category: "docs", names: new Set(["docs"]) },
  { category: "examples", names: new Set(["examples", "example", "benchmarks", "benchmark"]) },
  { category: "tests", names: new Set(["test", "tests", "__tests__"]) },
  {
    category: "dev-assets",
    paths: [
      /(^|\/)next\/dist\/diagnostics$/,
      /(^|\/)next\/dist\/compiled\/next-devtools$/,
      /(^|\/)\.cache$/,
      /(^|\/)\.next\/cache$/,
      /(^|\/)\.next\/dev$/,
      /(^|\/)\.next\/types$/,
    ],
  },
];

/** 按文件名删掉的类别。 */
const FILE_CATEGORIES = [
  { category: "debug-symbols", test: (name) => name.endsWith(".pdb") || name.endsWith(".dSYM") },
  { category: "source-maps", test: (name) => name.endsWith(".map") },
  { category: "dev-assets", test: (name) => name.endsWith(".tsbuildinfo") },
  { category: "tests", test: (name) => /\.(test|spec)\.(m|c)?js$/.test(name) },
];

/** 只有构建期被引用的包（相对 node_modules 的路径前缀）。 */
const BUILD_TIME_ONLY_PACKAGES = ["lucide-react"];

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function dirSizeBytes(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 竞态或权限：忽略单个文件 */
        }
      }
    }
  }
  return total;
}

function listChildren(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * 收集 node_modules 下的多平台二进制目录（需要先看到全部兄弟目录，才能判断是否保留了目标平台）。
 * @returns {{plan: Array<{fullPath: string, category: string, reason: string}>, missingKeep: string[]}}
 */
function planPlatformPrune(nodeModulesDir, platform, arch) {
  const plan = [];
  const missingKeep = [];
  for (const family of platformFamilies(platform, arch)) {
    for (const nm of findNodeModulesDirs(nodeModulesDir)) {
      const familyDir = path.join(nm, family.dir);
      const owned = listChildren(familyDir).filter((e) => e.isDirectory() && family.filter(e.name));
      if (owned.length === 0) continue;
      const keepers = owned.filter((e) => family.keep.test(e.name));
      if (keepers.length === 0) missingKeep.push(`${familyDir}（未找到 ${family.id} 的目标平台包）`);
      for (const entry of owned) {
        if (family.keep.test(entry.name)) continue;
        plan.push({
          fullPath: path.join(familyDir, entry.name),
          category: "cross-platform-binary",
          reason: `${family.id} 非目标平台（保留 ${keepers.map((k) => k.name).join(", ") || "无"}）`,
        });
      }
    }
  }
  for (const rule of platformDirRules(platform, arch)) {
    const parentDirs = [];
    walk(nodeModulesDir, (dir) => {
      if (rule.parent.test(toPosix(dir))) parentDirs.push(dir);
    });
    for (const parent of parentDirs) {
      const entries = listChildren(parent).filter((e) => e.isDirectory());
      const keepers = entries.filter((e) => rule.keep.test(e.name));
      if (keepers.length === 0 && entries.length > 0) {
        missingKeep.push(`${parent}（未找到 ${rule.id} 的目标平台目录）`);
      }
      for (const entry of entries) {
        if (rule.keep.test(entry.name)) continue;
        plan.push({
          fullPath: path.join(parent, entry.name),
          category: "cross-platform-binary",
          reason: `${rule.id} 非目标平台`,
        });
      }
    }
  }
  return { plan, missingKeep };
}

function walk(root, visitDir) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    visitDir(current);
    for (const entry of listChildren(current)) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
}

/** node_modules 自身以及嵌套的 node_modules（npm 会把冲突版本嵌套在包内）。 */
function findNodeModulesDirs(root) {
  const found = [];
  walk(root, (dir) => {
    if (path.basename(dir) === "node_modules") found.push(dir);
  });
  return found;
}

/**
 * 生成完整瘦身计划。纯函数：只读文件系统，不修改任何东西。
 * @returns {{entries: Array<{relPath: string, category: string, reason: string, bytes: number, kind: "dir"|"file"}>, missingKeep: string[]}}
 */
function planPrune({ root, platform = TARGET_PLATFORM, arch = TARGET_ARCH }) {
  const entries = [];
  const seen = new Set();
  const push = (fullPath, kind, category, reason) => {
    const rel = toPosix(path.relative(root, fullPath));
    if (seen.has(rel)) return;
    seen.add(rel);
    entries.push({
      relPath: rel,
      category,
      reason,
      kind,
      bytes: kind === "dir" ? dirSizeBytes(fullPath) : fileSize(fullPath),
    });
  };

  const nodeModulesDir = path.join(root, "node_modules");
  const { plan: platformPlan, missingKeep } = planPlatformPrune(nodeModulesDir, platform, arch);
  for (const item of platformPlan) push(item.fullPath, "dir", item.category, item.reason);

  for (const pkg of BUILD_TIME_ONLY_PACKAGES) {
    const full = path.join(nodeModulesDir, pkg);
    if (fs.existsSync(full)) push(full, "dir", "build-time-only", `${pkg} 只在构建期被 Next 打包`);
  }

  walk(nodeModulesDir, (dir) => {
    const rel = toPosix(path.relative(nodeModulesDir, dir));
    const base = path.basename(dir);
    for (const rule of DIRECTORY_CATEGORIES) {
      const byName = rule.names?.has(base);
      const byPath = rule.paths?.some((re) => re.test(rel));
      if (byName || byPath) {
        push(dir, "dir", rule.category, `目录 ${base}（${rule.category}）`);
        return;
      }
    }
    for (const entry of listChildren(dir)) {
      if (!entry.isFile()) continue;
      for (const rule of FILE_CATEGORIES) {
        if (rule.test(entry.name)) {
          push(path.join(dir, entry.name), "file", rule.category, `文件 ${entry.name}（${rule.category}）`);
          break;
        }
      }
    }
  });

  // 同一个包被多个父目录命中时只保留最外层（避免重复统计）。
  const pruned = entries.filter((entry) => !entries.some((other) => other !== entry && entry.relPath.startsWith(`${other.relPath}/`)));
  return { entries: pruned, missingKeep };
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function applyPlan({ root, entries }) {
  let removedBytes = 0;
  let removed = 0;
  for (const entry of entries) {
    const full = path.join(root, entry.relPath);
    try {
      fs.rmSync(full, { recursive: entry.kind === "dir", force: true });
      removedBytes += entry.bytes;
      removed += 1;
    } catch {
      /* 删除失败（占用等）不致命：体积报告会体现 */
    }
  }
  return { removed, removedBytes };
}

function summarize(entries) {
  const byCategory = new Map();
  for (const entry of entries) {
    const bucket = byCategory.get(entry.category) ?? { category: entry.category, count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += entry.bytes;
    byCategory.set(entry.category, bucket);
  }
  return [...byCategory.values()].sort((a, b) => b.bytes - a.bytes);
}

/** 精简后必须仍然存在的输入（缺一个就是打包输入坏了，宁可失败也不要出半成品）。 */
function verifyRequiredInputs(root, { platform = "win32" } = {}) {
  const required = [
    "node_modules/@henlii/pidance/bin/pidance.js",
    "node_modules/@henlii/pidance/bin/pidance-http-server.js",
    "node_modules/@henlii/pidance/.next/BUILD_ID",
    "node_modules/@henlii/pidance/package.json",
    "node_modules/next/dist/server/next-server.js",
    "node_modules/@earendil-works/pi-coding-agent/package.json",
    "node_modules/node-pty/package.json",
    "node_modules/react/package.json",
    "src/main.js",
    "src/server-lifecycle.js",
    "assets/pidance-logo.ico",
  ];
  if (platform === "win32") required.push("node_modules/electron/dist/electron.exe");
  const missing = required.filter((rel) => !fs.existsSync(path.join(root, rel)));
  return missing;
}

function topDirs(root, limit) {
  const targets = [path.join(root, "node_modules")].filter((dir) => fs.existsSync(dir));
  const result = [];
  for (const target of targets) {
    for (const entry of listChildren(target)) {
      if (!entry.isDirectory()) continue;
      const full = path.join(target, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of listChildren(full)) {
          if (scoped.isDirectory()) {
            const scopedFull = path.join(full, scoped.name);
            result.push({ rel: toPosix(path.relative(root, scopedFull)), mb: dirSizeBytes(scopedFull) / 1048576 });
          }
        }
      } else {
        result.push({ rel: toPosix(path.relative(root, full)), mb: dirSizeBytes(full) / 1048576 });
      }
    }
  }
  return result.sort((a, b) => b.mb - a.mb).slice(0, limit);
}

function parseArgs(argv) {
  const args = {
    root: path.resolve(__dirname, ".."),
    dryRun: false,
    json: false,
    keepBuildTime: false,
    top: 10,
    platform: TARGET_PLATFORM,
    arch: TARGET_ARCH,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = path.resolve(argv[i += 1] ?? "");
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--keep-build-time") args.keepBuildTime = true;
    else if (arg === "--platform") args.platform = String(argv[i += 1] ?? TARGET_PLATFORM);
    else if (arg === "--arch") args.arch = String(argv[i += 1] ?? TARGET_ARCH);
    else if (arg === "--top") args.top = Number.parseInt(argv[i += 1] ?? "10", 10) || 10;
    else throw new Error(`未知参数：${arg}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const nodeModulesDir = path.join(args.root, "node_modules");
  if (!fs.existsSync(nodeModulesDir)) {
    console.error(`[prune] 找不到 ${nodeModulesDir}（先在 desktop/ 跑 npm ci）`);
    process.exit(1);
  }
  // 先验输入再动手：缺必需输入时直接失败，不留下一个删了一半的树。
  const missingBefore = verifyRequiredInputs(args.root, { platform: args.platform });
  if (missingBefore.length > 0) {
    console.error(`[prune] 打包输入缺失（尚未改动任何文件）：\n  - ${missingBefore.join("\n  - ")}`);
    process.exit(1);
  }
  const beforeBytes = dirSizeBytes(nodeModulesDir);
  const { entries: plannedEntries, missingKeep } = planPrune({ root: args.root, platform: args.platform, arch: args.arch });
  let entries = plannedEntries;
  if (args.keepBuildTime) entries = entries.filter((entry) => entry.category !== "build-time-only");

  const categories = summarize(entries);
  const report = {
    root: args.root,
    platform: `${args.platform}-${args.arch}`,
    beforeMB: Number((beforeBytes / 1048576).toFixed(1)),
    deleteMB: Number((categories.reduce((sum, item) => sum + item.bytes, 0) / 1048576).toFixed(1)),
    missingKeep,
    categories: categories.map((item) => ({ ...item, mb: Number((item.bytes / 1048576).toFixed(1)) })),
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[prune] 目标平台 ${report.platform}；输入 ${report.beforeMB} MB → 计划删除 ${report.deleteMB} MB（${entries.length} 项）`);
    for (const item of report.categories) console.log(`  - ${item.category}: ${item.mb} MB / ${item.count} 项`);
  }

  if (missingKeep.length > 0) {
    console.warn(
      `[prune] 目标平台 ${report.platform} 的包不完整（分不清哪些是「别平台的」）：\n  - ${missingKeep.join(
        "\n  - ",
      )}\n  提示：平台专属可选依赖只按宿主平台安装；跨平台打包要在目标平台（或 CI windows runner）上 npm ci。`,
    );
  }

  if (args.dryRun) {
    const big = entries.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 10);
    if (!args.json) {
      console.log("[prune] 最大的 10 项：");
      for (const entry of big) console.log(`  - ${(entry.bytes / 1048576).toFixed(1)} MB  ${entry.relPath}（${entry.reason}）`);
    }
    return;
  }

  const { removed, removedBytes } = applyPlan({ root: args.root, entries });
  const afterBytes = dirSizeBytes(nodeModulesDir);
  console.log(`[prune] 删除 ${removed} 项 / ${(removedBytes / 1048576).toFixed(1)} MB；node_modules ${(beforeBytes / 1048576).toFixed(1)} → ${(afterBytes / 1048576).toFixed(1)} MB`);
  if (!args.json) {
    console.log("[prune] 剩余最大的目录（下一轮瘦身的候选）：");
    for (const item of topDirs(args.root, args.top)) console.log(`  - ${item.mb.toFixed(1)} MB  ${item.rel}`);
  }

  const missing = verifyRequiredInputs(args.root, { platform: args.platform });
  if (missing.length > 0) {
    console.error(`[prune] 必需输入在瘦身后丢失（删除规则出错了）：\n  - ${missing.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("[prune] 必需输入校验通过");
}

export {
  TARGET_PLATFORM,
  TARGET_ARCH,
  platformFamilies,
  platformDirRules,
  planPrune,
  applyPlan,
  summarize,
  verifyRequiredInputs,
  dirSizeBytes,
  parseArgs,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
