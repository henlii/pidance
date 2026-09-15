"use strict";

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import updateLogic from "../src/update-logic.js";

const {
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
} = updateLogic;

function release(tag, assets, extra = {}) {
  return { tag_name: tag, draft: false, prerelease: false, assets, ...extra };
}

function installer(name, extra = {}) {
  return { name, browser_download_url: `https://example.invalid/${name}`, ...extra };
}

test("版本解析：接受 v 前缀与预发布，拒绝无法解析的输入", () => {
  assert.equal(parseVersion("0.2.29").version, "0.2.29");
  assert.equal(parseVersion("v0.2.29").version, "0.2.29");
  assert.equal(parseVersion(" 1.2.3-beta.2 ").version, "1.2.3-beta.2");
  assert.deepEqual(parseVersion("v2.0.0-rc.1").prerelease, ["rc", "1"]);
  assert.equal(parseVersion("nightly"), null);
  assert.equal(parseVersion(undefined), null);
});

test("版本比较：数字段优先，正式版高于预发布", () => {
  assert.equal(compareSemver("0.2.30", "0.2.29"), 1);
  assert.equal(compareSemver("v0.2.29", "0.2.29"), 0);
  assert.equal(compareSemver("0.3.0", "0.2.99"), 1);
  assert.equal(compareSemver("0.2.29", "0.2.30"), -1);
  assert.equal(compareSemver("0.3.0-beta.1", "0.3.0"), -1);
  assert.equal(compareSemver("0.3.0", "0.3.0-rc.2"), 1);
  assert.equal(compareSemver("0.3.0-beta.2", "0.3.0-beta.1"), 1);
  assert.equal(compareSemver("bad", "0.3.0"), null);
  assert.equal(isNewerVersion("0.2.30", "0.2.29"), true);
  assert.equal(isNewerVersion("0.2.29", "0.2.29"), false);
  assert.equal(isNewerVersion("bad", "0.2.29"), false);
});

test("挑选更新：忽略 draft、预发布与没有桌面安装包的 release", () => {
  const releases = [
    release("v9.9.9", [installer("Pidance Desktop Setup 9.9.9.exe")], { draft: true }),
    release("v8.8.8", [installer("Pidance Desktop Setup 8.8.8.exe")], { prerelease: true }),
    release("v7.7.7", [installer("pidance-7.7.7.tgz")]),
    release("v0.2.28", [installer("Pidance Desktop Setup 0.2.28.exe"), installer("pidance-0.2.28.tgz")]),
  ];
  const picked = pickUpdateRelease(releases, "0.2.29");
  assert.equal(picked.status, "up-to-date");

  const withNewer = [...releases, release("v0.2.30", [installer("Pidance Desktop Setup 0.2.30.exe")])];
  const updated = pickUpdateRelease(withNewer, "0.2.29");
  assert.equal(updated.status, "update");
  assert.equal(updated.version, "0.2.30");
  assert.equal(updated.asset.name, "Pidance Desktop Setup 0.2.30.exe");
});

test("挑选更新：多版取最高，空列表/无资产给明确状态", () => {
  const releases = [
    release("v0.2.31", [installer("Pidance Desktop Setup 0.2.31.exe")]),
    release("v0.2.35", [installer("Pidance Desktop Setup 0.2.35.exe")]),
    release("v0.2.30", [installer("Pidance Desktop Setup 0.2.30.exe")]),
  ];
  assert.equal(pickUpdateRelease(releases, "0.2.29").version, "0.2.35");
  assert.equal(pickUpdateRelease([], "0.2.29").status, "unknown");
  assert.equal(pickUpdateRelease([release("v0.2.30", [installer("pidance.tgz")])], "0.2.29").status, "no-asset");
  assert.equal(pickUpdateRelease([release("nightly", [installer("Pidance Desktop Setup x.exe")])], "0.2.29").status, "no-asset");
});

test("下载校验：sha256 匹配才放行，未声明摘要单独回报", () => {
  const digest = crypto.createHash("sha256").update("pidance-desktop-setup").digest("hex");
  assert.equal(digestVerdict(digest, digest), "match");
  assert.equal(digestVerdict(digest.toUpperCase(), digest), "match");
  assert.equal(digestVerdict(digest, "0".repeat(64)), "mismatch");
  assert.equal(digestVerdict(digest, null), "unknown");
  assert.equal(digestVerdict(null, digest), "mismatch");
  assert.equal(digestVerdict("", digest), "mismatch");
});

test("资产摘要：只认 GitHub 的 sha256 声明", () => {
  assert.equal(parseAssetDigest({ digest: `sha256:${"a".repeat(64)}` }), "a".repeat(64));
  assert.equal(parseAssetDigest({ digest: "sha256:short" }), null);
  assert.equal(parseAssetDigest({}), null);
  assert.equal(parseAssetDigest(null), null);
});

test("安装参数：NSIS 静默安装", () => {
  assert.deepEqual(buildInstallerArgs(), ["/S"]);
});

test("版本摘要文案：含壳/内置/已连接，复用时标注", () => {
  const owned = describeVersions({
    shell: "0.2.29",
    bundled: "0.2.29",
    connected: "0.2.29",
    source: "owned",
  });
  assert.match(owned, /壳 0\.2\.29/);
  assert.match(owned, /内置服务 0\.2\.29/);
  assert.match(owned, /已连接服务 0\.2\.29/);
  assert.doesNotMatch(owned, /复用/);

  const reused = describeVersions({
    shell: "0.2.29",
    bundled: "0.2.29",
    connected: "0.2.26",
    source: "reused",
  });
  assert.match(reused, /已连接服务 0\.2\.26（复用外部服务）/);

  const unknown = describeVersions({ shell: null, bundled: null, connected: null, source: "reused" });
  assert.match(unknown, /壳 未知/);
  assert.match(unknown, /已连接服务 未知/);
});

test("读版本：package.json 与 /api/about 两种来源，坏输入不抛错", () => {
  assert.equal(readPackageVersion('{"name":"@henlii/pidance","version":"0.2.29"}'), "0.2.29");
  assert.equal(readPackageVersion("not json"), null);
  assert.equal(readPackageVersion('{"version":"1.0.0"}'), "1.0.0");

  const about = readAboutInfo('{"name":"Pidance","version":"0.2.29","piSdkVersion":"0.85.1"}');
  assert.deepEqual(about, { version: "0.2.29", piSdkVersion: "0.85.1" });
  assert.deepEqual(readAboutInfo('{"name":"Pidance"}'), { version: null, piSdkVersion: null });
  assert.deepEqual(readAboutInfo("<html>401</html>"), { version: null, piSdkVersion: null });
});
