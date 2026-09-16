"use strict";

/**
 * 桌面壳更新流程的纯逻辑（不依赖 electron，node:test 可直接测）。
 *
 * 更新源固定为 GitHub Release 的桌面产物（与主包发布同一个 tag）：
 * - 只认 `Pidance Desktop Setup <ver>.exe`（Windows 桌面只提供安装版，没有便携形态）。
 * - 下载后按 Release 资产声明的 sha256 校验，校验失败绝不执行安装包。
 * - 安装前必须先停掉本进程拉起的服务（外部复用的服务不动）。
 */

const lifecycle = require("./server-lifecycle.js");

/** 桌面产物名（electron-builder NSIS 默认命名）。 */
const INSTALLER_NAME_PATTERN = /^Pidance Desktop Setup .+\.exe$/i;

function parseVersion(text) {
  if (typeof text !== "string") return null;
  const match = text.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    version: `${match[1]}.${match[2]}.${match[3]}${match[4] ? `-${match[4]}` : ""}`,
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

/** 语义化比较：返回 -1 / 0 / 1；无法解析时返回 null（调用方按「不更新」处理）。 */
function compareSemver(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  const numeric = lifecycle.compareVersions(left.version.replace(/-.*$/, ""), right.version.replace(/-.*$/, ""));
  if (numeric !== 0) return numeric > 0 ? 1 : -1;
  if (left.prerelease && !right.prerelease) return -1;
  if (!left.prerelease && right.prerelease) return 1;
  if (!left.prerelease && !right.prerelease) return 0;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const ln = Number.parseInt(l, 10);
    const rn = Number.parseInt(r, 10);
    if (Number.isInteger(ln) && Number.isInteger(rn)) return ln > rn ? 1 : -1;
    return l > r ? 1 : -1;
  }
  return 0;
}

function isNewerVersion(candidate, current) {
  const compared = compareSemver(candidate, current);
  return compared === null ? false : compared > 0;
}

/**
 * 从 Release 列表里挑出「比当前版本新、且带桌面安装包」的那一版。
 * @returns {{status: "update"|"up-to-date"|"no-asset"|"unknown", release?: object, asset?: object, version?: string}}
 */
function pickUpdateRelease(releases, currentVersion) {
  if (!Array.isArray(releases) || releases.length === 0) return { status: "unknown" };
  const candidates = [];
  for (const release of releases) {
    if (!release || release.draft || release.prerelease) continue;
    const version = typeof release.tag_name === "string" ? release.tag_name.replace(/^v/i, "") : null;
    if (!version || !parseVersion(version)) continue;
    const asset = (Array.isArray(release.assets) ? release.assets : []).find(
      (item) => item && typeof item.name === "string" && INSTALLER_NAME_PATTERN.test(item.name),
    );
    if (!asset) continue;
    candidates.push({ release, asset, version });
  }
  if (candidates.length === 0) return { status: "no-asset" };
  const newer = candidates.filter((item) => isNewerVersion(item.version, currentVersion));
  if (newer.length === 0) return { status: "up-to-date" };
  newer.sort((a, b) => (compareSemver(b.version, a.version) ?? 0));
  return { status: "update", release: newer[0].release, asset: newer[0].asset, version: newer[0].version };
}

/** Release 资产上的 sha256 声明（GitHub 对较新上传的资产会带 digest 字段）。 */
function parseAssetDigest(asset) {
  if (!asset || typeof asset !== "object") return null;
  const raw = typeof asset.digest === "string" ? asset.digest : null;
  if (raw && /^sha256:[0-9a-f]{64}$/i.test(raw)) return raw.slice(7).toLowerCase();
  return null;
}

/** 摘要比对：没声明摘要 → "unknown"（由调用方决定是否继续），不一致 → "mismatch"。 */
function digestVerdict(actualSha256, expectedSha256) {
  if (!expectedSha256) return "unknown";
  if (typeof actualSha256 !== "string" || !actualSha256) return "mismatch";
  return actualSha256.toLowerCase() === String(expectedSha256).toLowerCase() ? "match" : "mismatch";
}

/** NSIS 静默安装参数（electron-builder 生成的安装包支持 /S）。 */
function buildInstallerArgs() {
  return ["/S"];
}

/** 从 package.json 文本里取版本号（读不出则 null）。 */
function readPackageVersion(text) {
  try {
    const pkg = JSON.parse(text);
    return parseVersion(typeof pkg?.version === "string" ? pkg.version : "")?.version ?? null;
  } catch {
    return null;
  }
}

/** 从 `/api/about` 响应体里取产品版本与内置 SDK 版本。 */
function readAboutInfo(text) {
  try {
    const info = JSON.parse(text);
    const raw = typeof info?.version === "string" ? info.version : "";
    const piSdkVersion = typeof info?.piSdkVersion === "string" && info.piSdkVersion ? info.piSdkVersion : null;
    return { version: parseVersion(raw)?.version ?? null, piSdkVersion };
  } catch {
    return { version: null, piSdkVersion: null };
  }
}

/** 更新提示文案用的摘要（纯字符串，便于测试与托盘复用）。 */
function describeVersions({ shell, bundled, connected, source }) {
  return `壳 ${shell ?? "未知"} · 内置服务 ${bundled ?? "未知"} · 已连接服务 ${
    connected ?? "未知"
  }${source === "reused" ? "（复用外部服务）" : ""}`;
}

module.exports = {
  INSTALLER_NAME_PATTERN,
  parseVersion,
  compareSemver,
  isNewerVersion,
  pickUpdateRelease,
  parseAssetDigest,
  digestVerdict,
  buildInstallerArgs,
  describeVersions,
  readPackageVersion,
  readAboutInfo,
};
