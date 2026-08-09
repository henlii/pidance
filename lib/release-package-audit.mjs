/**
 * 发布包清单与 tgz 审计（纯函数 + 有界 tgz 解析）。
 * 不写盘、不 build、不 publish；生成前 dry-run 与生成后 tgz 共用规则。
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** 正式发版构建后包内必须存在的 Next 产物路径 */
export const REQUIRED_NEXT_FILES = [
  ".next/BUILD_ID",
  ".next/build-manifest.json",
  ".next/routes-manifest.json",
  ".next/prerender-manifest.json",
  ".next/app-path-routes-manifest.json",
  ".next/required-server-files.json",
  ".next/server/pages-manifest.json",
  ".next/server/app-paths-manifest.json",
  ".next/server/middleware-manifest.json",
  ".next/server/functions-config-manifest.json",
  ".next/server/next-font-manifest.json",
  ".next/server/server-reference-manifest.json",
];

/** 路径前缀或精确路径禁止入包（源码、测试、本地治理、密钥、dev 产物等） */
export const FORBIDDEN_PATH_PATTERNS = [
  { kind: "prefix", value: "app/" },
  { kind: "exact", value: "app" },
  { kind: "prefix", value: "components/" },
  { kind: "exact", value: "components" },
  { kind: "prefix", value: "hooks/" },
  { kind: "exact", value: "hooks" },
  { kind: "prefix", value: "lib/" },
  { kind: "exact", value: "lib" },
  { kind: "prefix", value: "scripts/" },
  { kind: "exact", value: "scripts" },
  { kind: "suffix", value: ".test.mjs" },
  { kind: "suffix", value: ".test.ts" },
  { kind: "suffix", value: ".test.tsx" },
  { kind: "suffix", value: ".test.js" },
  { kind: "prefix", value: ".agents/" },
  { kind: "exact", value: ".agents" },
  { kind: "exact", value: "AGENTS.md" },
  { kind: "prefix", value: ".codegraph/" },
  { kind: "exact", value: ".codegraph" },
  { kind: "prefix", value: "docs/" },
  { kind: "exact", value: "docs" },
  { kind: "prefix", value: "deploy/" },
  { kind: "exact", value: "deploy" },
  { kind: "exact", value: ".env" },
  { kind: "prefix", value: ".env." },
  { kind: "suffix", value: ".pem" },
  { kind: "suffix", value: ".key" },
  { kind: "prefix", value: ".next/cache/" },
  { kind: "exact", value: ".next/cache" },
  { kind: "prefix", value: ".next/dev/" },
  { kind: "exact", value: ".next/dev" },
  { kind: "prefix", value: ".next/diagnostics/" },
  { kind: "exact", value: ".next/diagnostics" },
  { kind: "prefix", value: ".next/types/" },
  { kind: "exact", value: ".next/types" },
  { kind: "exact", value: ".next/trace" },
  { kind: "exact", value: ".next/trace-build" },
  { kind: "prefix", value: ".next/_events_" },
  { kind: "suffix", value: ".js.map" },
  { kind: "suffix", value: ".nft.json" },
  { kind: "exact", value: ".next/required-server-files.js" },
  { kind: "exact", value: ".next/images-manifest.json" },
  { kind: "exact", value: ".next/export-marker.json" },
  { kind: "exact", value: ".next/react-loadable-manifest.json" },
  { kind: "exact", value: ".next/server/next-font-manifest.js" },
  { kind: "exact", value: "next.config.ts" },
  { kind: "exact", value: "next.config.js" },
  { kind: "exact", value: "next.config.mjs" },
  { kind: "exact", value: "next.config.cjs" },
  { kind: "exact", value: "next.config.mts" },
  { kind: "exact", value: "next.config.cts" },
  { kind: "prefix", value: "node_modules/" },
  { kind: "exact", value: "node_modules" },
  { kind: "exact", value: ".npmrc" },
  { kind: "exact", value: ".envrc" },
  // public/ 为 Next 静态资源目录（品牌 logo、图标等），必须随包分发；
  // 其文本内容仍受完整内容扫描约束（密钥/绝对路径/内网 IP 等仍 fail closed）。
  // public/ 为 Next 静态资源目录（品牌 logo、图标等），必须随包分发；
  // 其文本内容仍受完整内容扫描约束（密钥/绝对路径/内网 IP 等仍 fail closed）。
];

/**
 * 文本内容扫描预算（足以覆盖约 15.3MB 解压包，并设固定上限）。
 * 单文件与总量均 fail-closed：超限不得截断后通过。
 */
export const DEFAULT_CONTENT_SCAN_SINGLE_FILE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_CONTENT_SCAN_TOTAL_BYTES = 48 * 1024 * 1024;

/** @deprecated 使用 DEFAULT_CONTENT_SCAN_SINGLE_FILE_BYTES；保留别名避免外部误用旧 256KiB 语义 */
export const DEFAULT_CONTENT_SCAN_MAX_BYTES = DEFAULT_CONTENT_SCAN_SINGLE_FILE_BYTES;

/** tgz 有界解析上限 */
export const DEFAULT_TGZ_MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TGZ_MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
export const DEFAULT_TGZ_MAX_ENTRIES = 20_000;
export const DEFAULT_TGZ_MAX_ENTRY_BYTES = 32 * 1024 * 1024;

const TEXT_SCAN_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".html",
  ".css",
  ".txt",
  ".md",
  ".map",
  ".ts",
  ".tsx",
  ".jsx",
  ".yml",
  ".yaml",
  ".toml",
  ".env",
]);

/**
 * @param {string} path
 * @returns {string}
 */
export function normalizePackPath(path) {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

/**
 * @param {string} path
 * @param {{ kind: string, value: string }} rule
 */
function matchesForbidden(path, rule) {
  if (rule.kind === "exact") return path === rule.value;
  if (rule.kind === "prefix") return path === rule.value.slice(0, -1) || path.startsWith(rule.value);
  // 后缀（.pem / .js.map / .nft.json 等）ASCII 大小写不敏感，防绕过
  if (rule.kind === "suffix") {
    return path.toLowerCase().endsWith(String(rule.value).toLowerCase());
  }
  return false;
}

/**
 * @param {string} path
 * @param {typeof FORBIDDEN_PATH_PATTERNS} [patterns]
 * @returns {string | null}
 */
export function findForbiddenPathReason(path, patterns = FORBIDDEN_PATH_PATTERNS) {
  const p = normalizePackPath(path);
  for (const rule of patterns) {
    if (matchesForbidden(p, rule)) {
      return `禁入路径: ${rule.kind}=${rule.value}`;
    }
  }
  return null;
}

/**
 * @param {string} path
 */
export function isProbablyTextPath(path) {
  const p = normalizePackPath(path);
  const base = p.split("/").pop() ?? p;
  if (base === "BUILD_ID") return true;
  if (base.startsWith(".") && !base.includes(".", 1)) return true;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_SCAN_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

/**
 * 固定中性发版构建根（精确路径；仅此路径可免于作为敏感扫描根）。
 * 不得扩展为任意 allowlist / 前缀匹配。
 */
export const FIXED_NEUTRAL_RELEASE_BUILD_ROOT = "/tmp/pidance-release-build";

/** 中性模式下必填：原始 source checkout 绝对路径 */
export const PIDANCE_RELEASE_SOURCE_ROOT_ENV = "PIDANCE_RELEASE_SOURCE_ROOT";

/**
 * 规范化敏感根路径：反斜杠→正斜杠、去尾斜杠；保留前导 /（绝对路径）。
 * 不得复用 normalizePackPath（其会剥掉前导 /，仅适用于包内相对路径）。
 * @param {string} root
 * @returns {string}
 */
export function normalizeSensitiveRoot(root) {
  let s = String(root ?? "").replace(/\\/g, "/");
  // 折叠重复斜杠，但保留开头的单一 /
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/**
 * 收集敏感扫描根：repoRoot（兼容）与 sensitiveRoots 合并去重。
 * 空数组 sensitiveRoots 不得清掉已提供的 repoRoot（不削弱默认行为）。
 *
 * @param {{ repoRoot?: string | null, sensitiveRoots?: string[] | null }} [opts]
 * @returns {string[]}
 */
export function collectSensitiveRoots(opts = {}) {
  /** @type {string[]} */
  const raw = [];
  if (opts.repoRoot != null && String(opts.repoRoot) !== "") {
    raw.push(String(opts.repoRoot));
  }
  if (Array.isArray(opts.sensitiveRoots)) {
    for (const r of opts.sensitiveRoots) {
      if (r != null && String(r) !== "") raw.push(String(r));
    }
  }
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const r of raw) {
    const n = normalizeSensitiveRoot(r);
    if (!n) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * 判断 packageRoot 是否为固定中性构建根（精确 resolve 路径，且存在且为目录）。
 * 不接受任意路径、模糊前缀或 symlink 旁路到其它目录名。
 *
 * @param {string} packageRoot
 * @param {{
 *   resolve?: typeof path.resolve,
 *   statSync?: typeof fs.statSync,
 *   realpathSync?: typeof fs.realpathSync,
 * }} [deps]
 * @returns {boolean}
 */
export function isFixedNeutralReleaseBuildRoot(packageRoot, deps = {}) {
  const resolvePath = deps.resolve ?? path.resolve;
  const statSync = deps.statSync ?? fs.statSync;
  const realpathSync = deps.realpathSync ?? fs.realpathSync;
  const resolved = resolvePath(packageRoot);
  const fixed = resolvePath(FIXED_NEUTRAL_RELEASE_BUILD_ROOT);
  if (resolved !== fixed) return false;
  try {
    return realpathSync(resolved) === fixed && statSync(resolved).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析审计用的 package/workspace 根与敏感扫描根集合。
 * - 普通 checkout：sensitiveRoots = [packageRoot]（行为与历史一致）
 * - 仅当 packageRoot 精确为固定中性根时进入中性模式：要求 PIDANCE_RELEASE_SOURCE_ROOT，
 *   中性根本身不作为敏感根，source realpath 加入敏感扫描
 *
 * @param {{
 *   packageRoot: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   resolve?: typeof path.resolve,
 *   statSync?: typeof fs.statSync,
 *   realpathSync?: typeof fs.realpathSync,
 *   isAbsolute?: typeof path.isAbsolute,
 * }} input
 * @returns {{
 *   ok: true,
 *   packageRoot: string,
 *   sensitiveRoots: string[],
 *   isNeutralBuildRoot: boolean,
 *   sourceRoot: string | null,
 * } | {
 *   ok: false,
 *   error: string,
 * }}
 */
export function resolveReleaseAuditRoots(input) {
  const resolvePath = input.resolve ?? path.resolve;
  const statSync = input.statSync ?? fs.statSync;
  const realpathSync = input.realpathSync ?? fs.realpathSync;
  const isAbsolute = input.isAbsolute ?? path.isAbsolute;
  const env = input.env ?? {};

  const packageRoot = resolvePath(input.packageRoot);
  const fixed = resolvePath(FIXED_NEUTRAL_RELEASE_BUILD_ROOT);
  const isNeutral = isFixedNeutralReleaseBuildRoot(packageRoot, {
    resolve: resolvePath,
    statSync,
    realpathSync,
  });

  if (!isNeutral) {
    let sensitive = packageRoot;
    try {
      sensitive = realpathSync(packageRoot);
    } catch {
      // 保持 resolve 路径
    }
    return {
      ok: true,
      packageRoot,
      sensitiveRoots: [normalizeSensitiveRoot(sensitive)],
      isNeutralBuildRoot: false,
      sourceRoot: null,
    };
  }

  const rawEnv = env[PIDANCE_RELEASE_SOURCE_ROOT_ENV];
  if (rawEnv == null || String(rawEnv).trim() === "") {
    return {
      ok: false,
      error:
        `中性构建根 ${fixed} 要求设置环境变量 ${PIDANCE_RELEASE_SOURCE_ROOT_ENV} ` +
        `为原始 source checkout 的绝对路径（缺失则 fail closed）`,
    };
  }
  const sourceRaw = String(rawEnv).trim();
  if (!isAbsolute(sourceRaw)) {
    return {
      ok: false,
      error: `${PIDANCE_RELEASE_SOURCE_ROOT_ENV} 必须是绝对路径，收到: ${sourceRaw}`,
    };
  }

  let sourceReal;
  try {
    const st = statSync(sourceRaw);
    if (!st.isDirectory()) {
      return {
        ok: false,
        error: `${PIDANCE_RELEASE_SOURCE_ROOT_ENV} 不是目录: ${sourceRaw}`,
      };
    }
    sourceReal = realpathSync(sourceRaw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `${PIDANCE_RELEASE_SOURCE_ROOT_ENV} 无效或不存在: ${sourceRaw} (${msg})`,
    };
  }

  let neutralReal;
  try {
    neutralReal = realpathSync(packageRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `无法 realpath 中性构建根 ${packageRoot}: ${msg}`,
    };
  }

  if (normalizeSensitiveRoot(sourceReal) === normalizeSensitiveRoot(neutralReal)) {
    return {
      ok: false,
      error:
        `${PIDANCE_RELEASE_SOURCE_ROOT_ENV} 经 realpath 后不得与中性构建根相同 ` +
        `(${neutralReal})`,
    };
  }

  return {
    ok: true,
    packageRoot,
    // 中性根本身不作为敏感根；仅扫描显式 source +（调用方另传）homeDir
    sensitiveRoots: [normalizeSensitiveRoot(sourceReal)],
    isNeutralBuildRoot: true,
    sourceRoot: normalizeSensitiveRoot(sourceReal),
  };
}

/**
 * 扫描文本中的敏感内容。
 * pidance.namixinxi.cn 等公开域名不在此扫描；不笼统拒绝 /tmp。
 * 路径匹配前将文本与根均规范为正斜杠，从而同时覆盖 Windows 反斜杠变体。
 *
 * @param {string} text
 * @param {{
 *   repoRoot?: string | null,
 *   sensitiveRoots?: string[] | null,
 *   homeDir?: string | null,
 * }} [opts]
 * @returns {string[]}
 */
export function scanSensitiveContent(text, opts = {}) {
  const reasons = [];
  if (typeof text !== "string" || text.length === 0) return reasons;

  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text)) {
    reasons.push("敏感内容: 私钥 PEM 标记");
  }

  if (
    // 排除纯 snake_case 字段名映射（如 accessToken:"access_token"，OAuth schema
    // 序列化映射，非真实凭据）；真实密钥通常含大写/数字/符号。
    /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*['"`](?![a-z_]+['"`]\s*[,}])[^'"`\s]{8,}/i.test(
      text,
    )
  ) {
    reasons.push("敏感内容: 疑似 credential 赋值");
  }

  if (/\b100\.99\.31\.21\b/.test(text)) {
    reasons.push("敏感内容: 硬编码主机 100.99.31.21");
  }

  if (/\b192\.168\.\d{1,3}\.\d{1,3}\b/.test(text)) {
    reasons.push("敏感内容: 硬编码 192.168.*.* 地址");
  }

  const roots = collectSensitiveRoots(opts);
  // 正反斜杠统一为正斜杠，再折叠重复斜杠，使 Windows 风格与 // 变体均可命中
  const textNorm = text.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  for (const root of roots) {
    if (root.length < 4) continue;
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(escaped, "i").test(textNorm)) {
      reasons.push(`敏感内容: 仓库绝对路径 ${root}`);
    }
  }

  const homeDir = opts.homeDir ? normalizeSensitiveRoot(opts.homeDir) : null;
  if (homeDir && homeDir.length >= 2 && homeDir !== "/") {
    const homeIsRoot = roots.some((r) => r === homeDir);
    if (!homeIsRoot) {
      const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`${escaped}/`, "i").test(textNorm)) {
        reasons.push(`敏感内容: 用户 HOME 绝对路径 ${homeDir}`);
      }
    }
  }

  return reasons;
}

/**
 * @param {unknown} packJson
 */
export function normalizePackDryRun(packJson) {
  const root = Array.isArray(packJson) ? packJson[0] : packJson;
  if (!root || typeof root !== "object") {
    throw new Error("npm pack --json 输出无效：期望对象或单元素数组");
  }
  const filesRaw = Array.isArray(root.files) ? root.files : [];
  const files = filesRaw.map((f) => {
    if (typeof f === "string") return { path: normalizePackPath(f) };
    const path = normalizePackPath(f?.path ?? f?.name ?? "");
    return {
      path,
      size: typeof f?.size === "number" ? f.size : undefined,
      content: typeof f?.content === "string" ? f.content : undefined,
    };
  });
  return {
    name: String(root.name ?? ""),
    version: String(root.version ?? ""),
    filename: root.filename ? String(root.filename) : undefined,
    files,
    entryCount: files.length,
    size: typeof root.size === "number" ? root.size : undefined,
    unpackedSize: typeof root.unpackedSize === "number" ? root.unpackedSize : undefined,
  };
}

/**
 * 解析内容条目为 utf8 文本与字节长度；不截断。
 * @param {string | Buffer | { text?: string, bytes?: number, error?: string }} raw
 * @returns {{ text: string | null, bytes: number, error: string | null }}
 */
function resolveContentEntry(raw) {
  if (raw == null) {
    return { text: null, bytes: 0, error: "文本内容缺失，无法完整扫描" };
  }
  if (typeof raw === "object" && !Buffer.isBuffer(raw) && ("error" in raw || "text" in raw || "bytes" in raw)) {
    if (raw.error) return { text: null, bytes: Number(raw.bytes) || 0, error: String(raw.error) };
    if (typeof raw.text === "string") {
      return {
        text: raw.text,
        bytes: typeof raw.bytes === "number" ? raw.bytes : Buffer.byteLength(raw.text, "utf8"),
        error: null,
      };
    }
    return { text: null, bytes: Number(raw.bytes) || 0, error: "文本内容缺失，无法完整扫描" };
  }
  if (Buffer.isBuffer(raw)) {
    return { text: raw.toString("utf8"), bytes: raw.length, error: null };
  }
  if (typeof raw === "string") {
    return { text: raw, bytes: Buffer.byteLength(raw, "utf8"), error: null };
  }
  return { text: null, bytes: 0, error: "文本内容类型无效，无法完整扫描" };
}

/**
 * @param {{
 *   pack: ReturnType<typeof normalizePackDryRun>,
 *   bin?: Record<string, string> | null,
 *   repoRoot?: string | null,
 *   sensitiveRoots?: string[] | null,
 *   homeDir?: string | null,
 *   fileContents?: Record<string, string | Buffer | { text?: string, bytes?: number, error?: string }>,
 *   contentScanSingleFileBytes?: number,
 *   contentScanTotalBytes?: number,
 *   requireTextContents?: boolean,
 *   contentScanMaxBytes?: number,
 * }} input
 */
export function auditReleasePackage(input) {
  const pack = input.pack;
  const violations = [];
  const pathSet = new Set(pack.files.map((f) => f.path).filter(Boolean));
  const singleLimit =
    input.contentScanSingleFileBytes ??
    input.contentScanMaxBytes ??
    DEFAULT_CONTENT_SCAN_SINGLE_FILE_BYTES;
  const totalLimit = input.contentScanTotalBytes ?? DEFAULT_CONTENT_SCAN_TOTAL_BYTES;
  const requireTextContents = input.requireTextContents !== false;
  const fileContents = input.fileContents ?? {};

  for (const req of REQUIRED_NEXT_FILES) {
    if (!pathSet.has(req)) {
      violations.push({ path: req, reason: "缺少必要构建产物" });
    }
  }

  const hasServerFile = [...pathSet].some((p) => p.startsWith(".next/server/") && p !== ".next/server/");
  const hasStaticFile = [...pathSet].some((p) => p.startsWith(".next/static/") && p !== ".next/static/");
  if (!hasServerFile) {
    violations.push({ path: ".next/server/**", reason: "缺少 .next/server 下任意文件" });
  }
  if (!hasStaticFile) {
    violations.push({ path: ".next/static/**", reason: "缺少 .next/static 下任意文件" });
  }

  const bin = input.bin ?? null;
  if (bin && typeof bin === "object") {
    if (!Object.prototype.hasOwnProperty.call(bin, "pidance")) {
      violations.push({ path: "package.json#bin", reason: "缺少 bin.pidance" });
    }
    if (Object.prototype.hasOwnProperty.call(bin, "pi-web")) {
      violations.push({
        path: "package.json#bin.pi-web",
        reason: "禁止注册 bin.pi-web（该命令归上游 pi-web）",
      });
    }
  }

  const hasPidanceBin =
    pathSet.has("bin/pidance.js") ||
    (bin && typeof bin["pidance"] === "string" && pathSet.has(normalizePackPath(bin["pidance"])));
  if (!hasPidanceBin) {
    violations.push({ path: "bin/pidance.js", reason: "包内缺少 pidance CLI 入口" });
  }
  if (pathSet.has("bin/pi-web.js") || pathSet.has("bin/pi-web-options.js")) {
    const hit = pathSet.has("bin/pi-web.js") ? "bin/pi-web.js" : "bin/pi-web-options.js";
    violations.push({ path: hit, reason: "禁止入包上游命名 CLI（pi-web）" });
  }

  for (const file of pack.files) {
    const reason = findForbiddenPathReason(file.path);
    if (reason) {
      violations.push({ path: file.path, reason });
    }
  }

  // —— 有界完整内容扫描（禁止截断后通过）——
  let scannedTotal = 0;
  for (const file of pack.files) {
    if (!file.path || !isProbablyTextPath(file.path)) continue;

    const declaredSize = typeof file.size === "number" ? file.size : null;
    if (declaredSize != null && declaredSize > singleLimit) {
      violations.push({
        path: file.path,
        reason: `单文件扫描预算超限: ${declaredSize} > ${singleLimit} bytes`,
      });
      continue;
    }

    const inline = file.content != null ? file.content : fileContents[file.path];
    if (inline == null && !requireTextContents) continue;

    const resolved = resolveContentEntry(inline);
    if (resolved.error) {
      violations.push({ path: file.path, reason: resolved.error });
      continue;
    }

    const bytes = resolved.bytes;
    if (bytes > singleLimit) {
      violations.push({
        path: file.path,
        reason: `单文件扫描预算超限: ${bytes} > ${singleLimit} bytes`,
      });
      continue;
    }
    if (scannedTotal + bytes > totalLimit) {
      violations.push({
        path: file.path,
        reason: `总扫描预算超限: 已扫 ${scannedTotal} + 本文件 ${bytes} > ${totalLimit} bytes`,
      });
      continue;
    }
    scannedTotal += bytes;

    for (const reason of scanSensitiveContent(resolved.text, {
      repoRoot: input.repoRoot,
      sensitiveRoots: input.sensitiveRoots,
      homeDir: input.homeDir,
    })) {
      violations.push({ path: file.path, reason });
    }
  }

  const groups = {
    nextRequired: 0,
    nextServer: 0,
    nextStatic: 0,
    bin: 0,
    public: 0,
    other: 0,
  };
  for (const p of pathSet) {
    if (REQUIRED_NEXT_FILES.includes(p)) groups.nextRequired += 1;
    else if (p.startsWith(".next/server/")) groups.nextServer += 1;
    else if (p.startsWith(".next/static/")) groups.nextStatic += 1;
    else if (p === "bin" || p.startsWith("bin/")) groups.bin += 1;
    else if (p === "public" || p.startsWith("public/")) groups.public += 1;
    else groups.other += 1;
  }

  return {
    ok: violations.length === 0,
    name: pack.name,
    version: pack.version,
    filename: pack.filename,
    entryCount: pack.entryCount,
    size: pack.size,
    unpackedSize: pack.unpackedSize,
    groups,
    violations,
    scannedContentBytes: scannedTotal,
  };
}

/**
 * @param {ReturnType<typeof auditReleasePackage>} result
 */
export function formatAuditReport(result) {
  const lines = [];
  lines.push(`包: ${result.name}@${result.version}`);
  if (result.filename) lines.push(`文件名: ${result.filename}`);
  lines.push(`条目数: ${result.entryCount}`);
  if (typeof result.size === "number") lines.push(`packed: ${result.size} bytes`);
  if (typeof result.unpackedSize === "number") lines.push(`unpacked: ${result.unpackedSize} bytes`);
  if (typeof result.scannedContentBytes === "number") {
    lines.push(`已扫描文本: ${result.scannedContentBytes} bytes`);
  }
  lines.push(
    `分组: nextRequired=${result.groups.nextRequired} server=${result.groups.nextServer} static=${result.groups.nextStatic} bin=${result.groups.bin} public=${result.groups.public} other=${result.groups.other}`,
  );
  if (result.ok) {
    lines.push("结果: 通过");
  } else {
    lines.push(`结果: 失败（${result.violations.length} 项违规）`);
    for (const v of result.violations) {
      lines.push(`  - ${v.path}: ${v.reason}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 有界 tar.gz 解析（仅 Node 标准库；支持 ustar / PAX / GNU 长名）
// ---------------------------------------------------------------------------

/**
 * 校验并规范化包内相对路径（已去掉 package/ 前缀后）。
 * 拒绝 ASCII 控制字符、路径歧义段（空段、. / ..、段首尾空白）；允许中间空格与合法 UTF-8。
 * @param {string} raw
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function validatePackageRelativePath(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "空路径" };
  }
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return { ok: false, reason: `路径含控制字符 U+${code.toString(16).padStart(4, "0")}` };
    }
  }
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    return { ok: false, reason: "绝对路径" };
  }
  if (normalized.includes("//")) {
    return { ok: false, reason: "空路径段" };
  }
  const parts = normalized.split("/");
  for (const part of parts) {
    if (part === "") {
      return { ok: false, reason: "空路径段" };
    }
    if (part === ".") {
      return { ok: false, reason: "路径段为 ." };
    }
    if (part === "..") {
      return { ok: false, reason: "路径穿越 (..)" };
    }
    if (part !== part.trim()) {
      return { ok: false, reason: "路径段首尾空白" };
    }
  }
  return { ok: true, path: parts.join("/") };
}

/**
 * 解析 tar 数值字段：仅标准八进制；GNU base-256（最高位）fail closed。
 * @param {Buffer} buf
 * @param {number} start
 * @param {number} end
 * @returns {{ ok: true, value: number } | { ok: false, reason: string }}
 */
export function parseTarNumericField(buf, start, end) {
  const field = buf.subarray(start, end);
  if (field.length === 0) {
    return { ok: false, reason: "空数值字段" };
  }
  if (field[0] & 0x80) {
    return { ok: false, reason: "不支持 GNU/base-256 数值编码" };
  }
  const s = field.toString("utf8").replace(/\0/g, "").trim();
  if (!s) {
    return { ok: true, value: 0 };
  }
  if (!/^[0-7]+$/.test(s)) {
    return { ok: false, reason: `非法八进制数值: ${JSON.stringify(s)}` };
  }
  const n = Number.parseInt(s, 8);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(n)) {
    return { ok: false, reason: `数值非有限安全整数: ${s}` };
  }
  return { ok: true, value: n };
}

/**
 * 校验 tar header checksum（148..155 计算时视为空格）。
 * @param {Buffer} header 512 字节
 * @returns {{ ok: true, sum: number } | { ok: false, reason: string }}
 */
export function verifyTarHeaderChecksum(header) {
  if (!Buffer.isBuffer(header) || header.length < 512) {
    return { ok: false, reason: "header 长度不足 512" };
  }
  let sum = 0;
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) sum += 0x20;
    else sum += header[i];
  }
  const chkField = header.subarray(148, 156).toString("utf8").replace(/\0/g, "").trim();
  if (!chkField || !/^[0-7]+$/.test(chkField)) {
    return { ok: false, reason: `checksum 字段非法: ${JSON.stringify(chkField)}` };
  }
  const claimed = Number.parseInt(chkField, 8);
  if (!Number.isFinite(claimed) || !Number.isSafeInteger(claimed)) {
    return { ok: false, reason: "checksum 非安全整数" };
  }
  if (claimed !== sum) {
    return { ok: false, reason: `checksum 不匹配: claimed=${claimed} actual=${sum}` };
  }
  return { ok: true, sum };
}

/**
 * @param {Buffer} header
 */
function isZeroBlock(header) {
  for (let i = 0; i < header.length; i++) {
    if (header[i] !== 0) return false;
  }
  return true;
}

/**
 * 严格解析 PAX 记录；失败返回 error。
 * @param {string} paxText
 * @returns {{ ok: true, records: Record<string, string> } | { ok: false, reason: string }}
 */
export function parsePaxRecords(paxText) {
  if (typeof paxText !== "string") {
    return { ok: false, reason: "PAX 内容非字符串" };
  }
  /** @type {Record<string, string>} */
  const out = {};
  let i = 0;
  while (i < paxText.length) {
    // 允许末尾多余 NUL 填充
    if (paxText.charCodeAt(i) === 0) {
      i += 1;
      continue;
    }
    const sp = paxText.indexOf(" ", i);
    if (sp < 0) {
      return { ok: false, reason: "PAX 记录缺少长度分隔空格" };
    }
    const lenStr = paxText.slice(i, sp);
    if (!/^[1-9][0-9]*$/.test(lenStr)) {
      return { ok: false, reason: `PAX 长度非法: ${JSON.stringify(lenStr)}` };
    }
    const len = Number.parseInt(lenStr, 10);
    if (!Number.isSafeInteger(len) || len <= 0) {
      return { ok: false, reason: "PAX 长度非安全正整数" };
    }
    if (i + len > paxText.length) {
      return { ok: false, reason: "PAX 记录长度越界" };
    }
    const record = paxText.slice(i, i + len);
    if (!record.endsWith("\n")) {
      return { ok: false, reason: "PAX 记录未以换行结束" };
    }
    const body = record.slice(sp - i + 1, record.length - 1);
    const eq = body.indexOf("=");
    if (eq <= 0) {
      return { ok: false, reason: "PAX 记录缺少 key=" };
    }
    const key = body.slice(0, eq);
    const value = body.slice(eq + 1);
    if (!key) {
      return { ok: false, reason: "PAX 空键" };
    }
    out[key] = value;
    i += len;
  }
  return { ok: true, records: out };
}

/**
 * 解析安全的十进制 size 字符串（PAX size）。
 * @param {string} s
 * @returns {{ ok: true, value: number } | { ok: false, reason: string }}
 */
function parseSafeDecimalSize(s) {
  if (typeof s !== "string" || !/^[0-9]+$/.test(s)) {
    return { ok: false, reason: `PAX size 非法: ${JSON.stringify(s)}` };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || !Number.isSafeInteger(n)) {
    return { ok: false, reason: `PAX size 非安全整数: ${s}` };
  }
  return { ok: true, value: n };
}

/**
 * 从已解压的 tar 字节流解析条目（有界）。
 * 支持 ustar / GNU L 长名 / PAX x+g（g 为全局并与后续 x 合并）；checksum 与数值字段 fail closed。
 * @param {Buffer} tarBuf
 * @param {{
 *   maxEntries?: number,
 *   maxEntryBytes?: number,
 *   maxUnpackedBytes?: number,
 * }} [limits]
 */
export function parseTarBuffer(tarBuf, limits = {}) {
  const maxEntries = limits.maxEntries ?? DEFAULT_TGZ_MAX_ENTRIES;
  const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_TGZ_MAX_ENTRY_BYTES;
  const maxUnpackedBytes = limits.maxUnpackedBytes ?? DEFAULT_TGZ_MAX_UNPACKED_BYTES;

  /** @type {Array<{ path: string, size: number, content: Buffer, type: string }>} */
  const entries = [];
  /** @type {Array<{ path: string, reason: string }>} */
  const violations = [];
  let offset = 0;
  let entryCount = 0;
  let unpackedTotal = 0;
  /** @type {string | null} */
  let pendingLongName = null;
  /** @type {Record<string, string>} */
  let pendingPax = {};
  /** @type {Record<string, string>} */
  let globalPax = {};
  const seenPaths = new Set();
  let stopped = false;

  const failStop = (pathLabel, reason) => {
    violations.push({ path: pathLabel, reason });
    stopped = true;
  };

  const chargeBudget = (size, label) => {
    if (size > maxEntryBytes) {
      failStop(label, `单条目大小超限: ${size} > ${maxEntryBytes}`);
      return false;
    }
    unpackedTotal += size;
    if (unpackedTotal > maxUnpackedBytes) {
      failStop(label, `解压总量超限: ${unpackedTotal} > ${maxUnpackedBytes}`);
      return false;
    }
    return true;
  };

  const readBlock = () => {
    if (offset + 512 > tarBuf.length) return null;
    const block = tarBuf.subarray(offset, offset + 512);
    offset += 512;
    return block;
  };

  while (!stopped && offset < tarBuf.length) {
    const header = readBlock();
    if (!header) break;

    if (isZeroBlock(header)) {
      // 结束：需要第二个零块（或 EOF）；其后只允许全零 padding
      const next = readBlock();
      if (next && !isZeroBlock(next)) {
        failStop("<tar>", "终止零块后出现非零数据");
        break;
      }
      // 剩余必须全零
      while (offset < tarBuf.length) {
        if (tarBuf[offset] !== 0) {
          failStop("<tar>", "双零结束后存在非零 trailing data");
          break;
        }
        offset += 1;
      }
      break;
    }

    entryCount += 1;
    if (entryCount > maxEntries) {
      failStop("<tar>", `条目数超限: > ${maxEntries}`);
      break;
    }

    const chk = verifyTarHeaderChecksum(header);
    if (!chk.ok) {
      failStop("<tar>", `header checksum 失败: ${chk.reason}`);
      break;
    }

    const sizeParsed = parseTarNumericField(header, 124, 136);
    if (!sizeParsed.ok) {
      failStop("<tar>", `size 字段: ${sizeParsed.reason}`);
      break;
    }
    let size = sizeParsed.value;

    let name = header.subarray(0, 100).toString("utf8").replace(/\0/g, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0/g, "");
    if (prefix) name = `${prefix}/${name}`;

    // 合并：global PAX <- local pending <- GNU longname（后写优先）
    /** @type {Record<string, string>} */
    const appliedPax = { ...globalPax, ...pendingPax };
    pendingPax = {};
    if (pendingLongName) {
      name = pendingLongName;
      pendingLongName = null;
    }
    if (appliedPax.path) {
      name = appliedPax.path;
    }
    if (appliedPax.size) {
      const paxSize = parseSafeDecimalSize(appliedPax.size);
      if (!paxSize.ok) {
        failStop(name || "<tar>", paxSize.reason);
        break;
      }
      size = paxSize.value;
    }

    if (!Number.isSafeInteger(size) || size < 0) {
      failStop(name || "<tar>", `size 非安全非负整数: ${size}`);
      break;
    }

    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > tarBuf.length) {
      failStop(name || "<tar>", "tar 条目数据截断");
      break;
    }
    if (!chargeBudget(size, name || "<entry>")) break;

    const data = tarBuf.subarray(offset, offset + size);
    offset += padded;

    const typeflag = String.fromCharCode(header[156] || 0);

    // GNU 长名
    if (typeflag === "L") {
      pendingLongName = data.toString("utf8").replace(/\0/g, "");
      continue;
    }
    if (typeflag === "K") {
      // 长链接名：后续硬/软链会被拒绝
      continue;
    }
    // PAX：x 局部；g 全局（保留并与后续 x 合并）
    if (typeflag === "x" || typeflag === "g") {
      const rec = parsePaxRecords(data.toString("utf8"));
      if (!rec.ok) {
        failStop(name || "<pax>", rec.reason);
        break;
      }
      if (typeflag === "g") {
        globalPax = { ...globalPax, ...rec.records };
      } else {
        pendingPax = rec.records;
      }
      continue;
    }

    if (typeflag === "1" || typeflag === "2") {
      violations.push({
        path: name || "<link>",
        reason: typeflag === "2" ? "拒绝符号链接" : "拒绝硬链接",
      });
      continue;
    }
    if (typeflag === "3" || typeflag === "4" || typeflag === "6") {
      violations.push({ path: name || "<special>", reason: `拒绝特殊类型 typeflag=${typeflag}` });
      continue;
    }
    if (typeflag === "5") {
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\0") {
      violations.push({
        path: name || "<unknown>",
        reason: `不支持的 tar 类型 typeflag=${JSON.stringify(typeflag)}`,
      });
      continue;
    }

    let rel = name.replace(/\\/g, "/");
    if (rel.startsWith("./")) rel = rel.slice(2);
    if (rel === "package" || rel.startsWith("package/")) {
      rel = rel === "package" ? "" : rel.slice("package/".length);
    }
    if (!rel || rel.endsWith("/")) continue;

    const validated = validatePackageRelativePath(rel);
    if (!validated.ok) {
      violations.push({ path: name, reason: `非法路径: ${validated.reason}` });
      continue;
    }
    if (seenPaths.has(validated.path)) {
      violations.push({ path: validated.path, reason: "重复路径" });
      continue;
    }
    seenPaths.add(validated.path);
    entries.push({
      path: validated.path,
      size,
      content: Buffer.from(data),
      type: "file",
    });
  }

  if (!stopped && pendingLongName) {
    violations.push({ path: "<tar>", reason: "GNU 长名未消费（档案结束）" });
  }
  if (!stopped && Object.keys(pendingPax).length > 0) {
    violations.push({ path: "<tar>", reason: "局部 PAX 扩展未消费（档案结束）" });
  }

  return { entries, violations, unpackedBytes: unpackedTotal, entryCount };
}

/**
 * 有界读取并解析 npm pack 产生的 .tgz。
 * @param {string | Buffer} tgzPathOrBuffer
 * @param {{
 *   maxCompressedBytes?: number,
 *   maxUnpackedBytes?: number,
 *   maxEntries?: number,
 *   maxEntryBytes?: number,
 * }} [limits]
 */
export function readNpmPackTgz(tgzPathOrBuffer, limits = {}) {
  const maxCompressed = limits.maxCompressedBytes ?? DEFAULT_TGZ_MAX_COMPRESSED_BYTES;
  const maxUnpacked = limits.maxUnpackedBytes ?? DEFAULT_TGZ_MAX_UNPACKED_BYTES;
  const maxEntries = limits.maxEntries ?? DEFAULT_TGZ_MAX_ENTRIES;
  const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_TGZ_MAX_ENTRY_BYTES;

  /** @type {Array<{ path: string, reason: string }>} */
  const violations = [];
  let compressed;
  if (Buffer.isBuffer(tgzPathOrBuffer)) {
    compressed = tgzPathOrBuffer;
  } else {
    const st = fs.statSync(tgzPathOrBuffer);
    if (!st.isFile()) {
      return {
        ok: false,
        compressedBytes: 0,
        unpackedBytes: 0,
        files: [],
        packageJson: null,
        violations: [{ path: String(tgzPathOrBuffer), reason: "tgz 路径不是普通文件" }],
      };
    }
    if (st.size > maxCompressed) {
      return {
        ok: false,
        compressedBytes: st.size,
        unpackedBytes: 0,
        files: [],
        packageJson: null,
        violations: [
          {
            path: String(tgzPathOrBuffer),
            reason: `压缩体超限: ${st.size} > ${maxCompressed}`,
          },
        ],
      };
    }
    compressed = fs.readFileSync(tgzPathOrBuffer);
  }

  if (compressed.length > maxCompressed) {
    violations.push({
      path: "<tgz>",
      reason: `压缩体超限: ${compressed.length} > ${maxCompressed}`,
    });
    return {
      ok: false,
      compressedBytes: compressed.length,
      unpackedBytes: 0,
      files: [],
      packageJson: null,
      violations,
    };
  }

  let tarBuf;
  try {
    tarBuf = zlib.gunzipSync(compressed, { maxOutputLength: maxUnpacked });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    violations.push({
      path: "<tgz>",
      reason: /longer than|maxOutputLength|memory|larger than|ENOMEM|allocation/i.test(msg)
        ? `解压总量超限: ${msg}`
        : `gzip 解压失败: ${msg}`,
    });
    return {
      ok: false,
      compressedBytes: compressed.length,
      unpackedBytes: 0,
      files: [],
      packageJson: null,
      violations,
    };
  }

  const parsed = parseTarBuffer(tarBuf, {
    maxEntries,
    maxEntryBytes,
    maxUnpackedBytes: maxUnpacked,
  });
  violations.push(...parsed.violations);

  /** @type {Record<string, unknown> | null} */
  let packageJson = null;
  const pkgEntry = parsed.entries.find((e) => e.path === "package.json");
  if (pkgEntry) {
    try {
      packageJson = JSON.parse(pkgEntry.content.toString("utf8"));
    } catch (err) {
      violations.push({
        path: "package.json",
        reason: `tgz 内 package.json 解析失败: ${err instanceof Error ? err.message : err}`,
      });
    }
  } else {
    violations.push({ path: "package.json", reason: "tgz 内缺少 package.json" });
  }

  return {
    ok: violations.length === 0,
    compressedBytes: compressed.length,
    unpackedBytes: parsed.unpackedBytes,
    files: parsed.entries.map((e) => ({
      path: e.path,
      size: e.size,
      content: e.content,
    })),
    packageJson,
    violations,
  };
}

/**
 * 对真实 tgz 执行与 dry-run 相同规则的审计；bin 只信 tgz 内 package.json。
 * expectedName/expectedVersion 仅用于身份比对（来自干净 tag 的 package.json），不替代包内 bin/内容。
 * @param {{
 *   tgzPathOrBuffer: string | Buffer,
 *   filename?: string,
 *   repoRoot?: string | null,
 *   sensitiveRoots?: string[] | null,
 *   homeDir?: string | null,
 *   expectedName?: string | null,
 *   expectedVersion?: string | null,
 *   contentScanSingleFileBytes?: number,
 *   contentScanTotalBytes?: number,
 *   tgzLimits?: Parameters<typeof readNpmPackTgz>[1],
 * }} input
 */
export function auditReleaseTgz(input) {
  const read = readNpmPackTgz(input.tgzPathOrBuffer, input.tgzLimits);
  if (!read.ok && read.files.length === 0) {
    return {
      ok: false,
      name: "",
      version: "",
      filename: input.filename,
      entryCount: 0,
      size: read.compressedBytes,
      unpackedSize: read.unpackedBytes,
      groups: { nextRequired: 0, nextServer: 0, nextStatic: 0, bin: 0, public: 0, other: 0 },
      violations: read.violations,
      scannedContentBytes: 0,
    };
  }

  const pkg = read.packageJson && typeof read.packageJson === "object" ? read.packageJson : {};
  const name = typeof pkg.name === "string" ? pkg.name : "";
  const version = typeof pkg.version === "string" ? pkg.version : "";
  /** @type {Record<string, string> | null} */
  let bin = null;
  if (pkg.bin && typeof pkg.bin === "object" && !Array.isArray(pkg.bin)) {
    bin = /** @type {Record<string, string>} */ (pkg.bin);
  } else if (typeof pkg.bin === "string") {
    bin = { [name.includes("/") ? name.split("/").pop() : name || "pidance"]: pkg.bin };
  }

  /** @type {Record<string, Buffer>} */
  const fileContents = {};
  for (const f of read.files) {
    if (isProbablyTextPath(f.path)) {
      fileContents[f.path] = f.content;
    }
  }

  const pack = {
    name,
    version,
    filename: input.filename,
    files: read.files.map((f) => ({ path: f.path, size: f.size })),
    entryCount: read.files.length,
    size: read.compressedBytes,
    unpackedSize: read.unpackedBytes,
  };

  const result = auditReleasePackage({
    pack,
    bin,
    repoRoot: input.repoRoot,
    sensitiveRoots: input.sensitiveRoots,
    homeDir: input.homeDir,
    fileContents,
    contentScanSingleFileBytes: input.contentScanSingleFileBytes,
    contentScanTotalBytes: input.contentScanTotalBytes,
    requireTextContents: true,
  });

  // 合并 tgz 解析期违规
  if (read.violations.length > 0) {
    result.violations = [...read.violations, ...result.violations];
    result.ok = false;
  }

  if (input.expectedName != null && input.expectedName !== "") {
    if (name !== input.expectedName) {
      result.violations.push({
        path: "package.json#name",
        reason: `包名与期望不一致: tgz=${JSON.stringify(name)} expected=${JSON.stringify(input.expectedName)}`,
      });
      result.ok = false;
    }
  }
  if (input.expectedVersion != null && input.expectedVersion !== "") {
    if (version !== input.expectedVersion) {
      result.violations.push({
        path: "package.json#version",
        reason: `版本与期望不一致: tgz=${JSON.stringify(version)} expected=${JSON.stringify(input.expectedVersion)}`,
      });
      result.ok = false;
    }
  }

  return result;
}

/**
 * 从工作区为 dry-run 清单加载可扫描文本（完整读入；超限/缺失/越界 fail closed）。
 * 路径经 validatePackageRelativePath + path.resolve 约束在 repoRoot 内；拒绝 symlink。
 * @param {string} repoRoot
 * @param {string[]} packPaths
 * @param {{
 *   singleFileBytes?: number,
 * }} [opts]
 * @returns {Record<string, { text?: string, bytes?: number, error?: string }>}
 */
export function loadWorkspaceTextContents(repoRoot, packPaths, opts = {}) {
  const singleLimit = opts.singleFileBytes ?? DEFAULT_CONTENT_SCAN_SINGLE_FILE_BYTES;
  const rootResolved = path.resolve(repoRoot);
  /** @type {Record<string, { text?: string, bytes?: number, error?: string }>} */
  const contents = {};
  for (const rel of packPaths) {
    const raw = String(rel ?? "");
    if (!isProbablyTextPath(normalizePackPath(raw))) continue;

    const validated = validatePackageRelativePath(raw.replace(/\\/g, "/").replace(/^\.\//, ""));
    if (!validated.ok) {
      contents[normalizePackPath(raw)] = {
        error: `非法路径: ${validated.reason}`,
        bytes: 0,
      };
      continue;
    }
    const p = validated.path;
    const abs = path.resolve(rootResolved, p);
    const relToRoot = path.relative(rootResolved, abs);
    if (
      relToRoot === "" ||
      relToRoot.startsWith("..") ||
      path.isAbsolute(relToRoot)
    ) {
      contents[p] = { error: "路径越出仓库根目录", bytes: 0 };
      continue;
    }

    try {
      const lst = fs.lstatSync(abs);
      if (lst.isSymbolicLink()) {
        contents[p] = { error: "拒绝符号链接", bytes: 0 };
        continue;
      }
      if (!lst.isFile()) {
        contents[p] = { error: "不是普通文件，无法完整扫描", bytes: 0 };
        continue;
      }
      if (lst.size > singleLimit) {
        contents[p] = {
          error: `单文件扫描预算超限: ${lst.size} > ${singleLimit} bytes`,
          bytes: lst.size,
        };
        continue;
      }
      const buf = fs.readFileSync(abs);
      contents[p] = { text: buf.toString("utf8"), bytes: buf.length };
    } catch (err) {
      contents[p] = {
        error: `读取失败: ${err instanceof Error ? err.message : err}`,
        bytes: 0,
      };
    }
  }
  return contents;
}

// ---------------------------------------------------------------------------
// 测试用最小 tar.gz 构造（ustar + 可选 PAX 长名）
// ---------------------------------------------------------------------------

/**
 * @param {string} s
 * @param {number} len
 */
function tarStringField(s, len) {
  const buf = Buffer.alloc(len, 0);
  Buffer.from(s, "utf8").copy(buf, 0, 0, Math.min(len - 1, Buffer.byteLength(s)));
  return buf;
}

/**
 * @param {number} n
 * @param {number} len
 */
function tarOctalField(n, len) {
  const body = n.toString(8).padStart(len - 1, "0");
  const buf = Buffer.alloc(len, 0);
  buf.write(body + "\0", 0, "utf8");
  return buf;
}

/**
 * @param {{
 *   name: string,
 *   content?: Buffer | string,
 *   typeflag?: string,
 *   linkname?: string,
 *   mode?: number,
 * }} entry
 */
function buildUstarHeader(entry) {
  const content = entry.content == null ? Buffer.alloc(0) : Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
  const typeflag = entry.typeflag ?? "0";
  const size = typeflag === "5" ? 0 : content.length;
  const name = entry.name;
  let prefix = "";
  let nameField = name;
  if (name.length > 100) {
    // 简单拆分：尽量把目录放 prefix
    const cut = name.length - 100;
    const idx = name.lastIndexOf("/", cut + 1);
    if (idx > 0 && name.length - idx - 1 <= 100 && idx <= 155) {
      prefix = name.slice(0, idx);
      nameField = name.slice(idx + 1);
    } else {
      nameField = name.slice(0, 100);
    }
  }

  const header = Buffer.alloc(512, 0);
  tarStringField(nameField, 100).copy(header, 0);
  tarOctalField(entry.mode ?? 0o644, 8).copy(header, 100);
  tarOctalField(0, 8).copy(header, 108);
  tarOctalField(0, 8).copy(header, 116);
  tarOctalField(size, 12).copy(header, 124);
  tarOctalField(Math.floor(Date.now() / 1000), 12).copy(header, 136);
  // checksum 占位空格
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  if (entry.linkname) {
    tarStringField(entry.linkname, 100).copy(header, 157);
  }
  Buffer.from("ustar\0", "utf8").copy(header, 257);
  Buffer.from("00", "utf8").copy(header, 263);
  if (prefix) tarStringField(prefix, 155).copy(header, 345);

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const chk = sum.toString(8).padStart(6, "0") + "\0 ";
  header.write(chk, 148, "utf8");
  return { header, content, size };
}

/**
 * 构造最小 npm-pack 风格 tar 条目块（未 gzip）。
 * @param {Array<{
 *   path: string,
 *   content?: string | Buffer,
 *   typeflag?: string,
 *   linkname?: string,
 *   rawName?: string,
 *   sizeOverride?: number,
 *   corruptChecksum?: boolean,
 *   base256Size?: boolean,
 * }>} files
 * @returns {Buffer}
 */
export function buildTarEntriesBuffer(files) {
  const chunks = [];
  for (const f of files) {
    let name = f.rawName ?? f.path;
    if (!f.rawName) {
      name = name.startsWith("package/") ? name : `package/${name.replace(/^\//, "")}`;
    }
    const content =
      f.content == null
        ? Buffer.alloc(0)
        : Buffer.isBuffer(f.content)
          ? f.content
          : Buffer.from(f.content, "utf8");
    const size = f.sizeOverride != null ? f.sizeOverride : content.length;
    const { header } = buildUstarHeader({
      name,
      content: f.base256Size ? Buffer.alloc(0) : content,
      typeflag: f.typeflag,
      linkname: f.linkname,
    });
    // 覆盖 size 字段（含 base-256 测试）
    if (f.base256Size) {
      header.fill(0, 124, 136);
      header[124] = 0x80;
      header.writeUInt32BE(size >>> 0, 132);
      // 重算 checksum
      header.fill(0x20, 148, 156);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += header[i];
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
    } else if (f.sizeOverride != null) {
      tarOctalField(size, 12).copy(header, 124);
      header.fill(0x20, 148, 156);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += header[i];
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
    }
    if (f.corruptChecksum) {
      header.write("000000\0 ", 148, "utf8");
      // 故意错误
      if (header[148] === 0x30) header[148] = 0x31;
    }
    chunks.push(header);
    const dataSize = f.base256Size ? 0 : content.length;
    if (dataSize > 0) {
      chunks.push(content);
      const pad = (512 - (dataSize % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    } else if (f.base256Size && size > 0) {
      // 不写出数据，仅测编码拒绝
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

/**
 * 构造最小 npm-pack 风格 tgz（条目路径自动加 package/ 前缀，除非已有）。
 * @param {Array<{
 *   path: string,
 *   content?: string | Buffer,
 *   typeflag?: string,
 *   linkname?: string,
 *   rawName?: string,
 * }>} files
 * @returns {Buffer}
 */
export function buildNpmPackTgzFixture(files) {
  return zlib.gzipSync(buildTarEntriesBuffer(files));
}

/**
 * 构造 PAX `x`/`g` 扩展头 + 后续文件条目的 tar 缓冲（用于测试）。
 * @param {{
 *   paxType: "x" | "g",
 *   records: Record<string, string>,
 *   follow: { path: string, content: string | Buffer, rawName?: string },
 * }} opts
 */
export function buildPaxFollowedByFileTar(opts) {
  const lines = [];
  for (const [k, v] of Object.entries(opts.records)) {
    const body = `${k}=${v}\n`;
    // 长度字段包含自身；迭代收敛
    let record = `${body.length} ${body}`;
    for (let i = 0; i < 5; i++) {
      const n = Buffer.byteLength(record, "utf8");
      record = `${n} ${body}`;
      if (Buffer.byteLength(record, "utf8") === n) break;
    }
    lines.push(record);
  }
  const paxBody = lines.join("");
  const paxName = opts.paxType === "g" ? "package/PaxHeader" : "./PaxHeader";
  return buildTarEntriesBuffer([
    { path: "pax", rawName: paxName, content: paxBody, typeflag: opts.paxType },
    {
      path: opts.follow.path,
      content: opts.follow.content,
      rawName: opts.follow.rawName,
    },
  ]);
}
