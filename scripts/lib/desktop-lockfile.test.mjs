import test from "node:test";
import assert from "node:assert/strict";
import { checkDesktopLockfile, versionFromResolved } from "./desktop-lockfile.mjs";

const DEP = "@henlii/pidance";

/** 构造一份 desktop/package-lock.json 形状的对象。 */
function lockOf({ version, depVersion, resolvedVersion, integrity = "sha512-AAAA" }) {
  const tarball = (v) => `https://registry.npmjs.org/@henlii/pidance/-/pidance-${v}.tgz`;
  return {
    version,
    packages: {
      "": { name: "@henlii/pidance-desktop", version, dependencies: { [DEP]: depVersion } },
      [`node_modules/${DEP}`]: {
        version: depVersion,
        resolved: tarball(resolvedVersion),
        integrity,
      },
    },
  };
}

test("versionFromResolved：从 tgz URL 取版本，非法 URL 返回 null", () => {
  assert.equal(versionFromResolved("https://registry.npmjs.org/@henlii/pidance/-/pidance-0.2.37.tgz"), "0.2.37");
  assert.equal(versionFromResolved("https://example.com/other.tgz"), null);
  assert.equal(versionFromResolved(undefined), null);
});

test("发行前正确形态：三处版本跟到新版，resolved 留在上一版 tgz → 通过", () => {
  const result = checkDesktopLockfile({
    pkgVersion: "0.2.38",
    lock: lockOf({ version: "0.2.38", depVersion: "0.2.38", resolvedVersion: "0.2.37" }),
    publishedVersions: ["0.2.36", "0.2.37"],
  });
  assert.equal(result.stage, "pre");
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("发行前把 resolved 指向未发布版本 → 拦住（正是 npm ci 404 的成因）", () => {
  const result = checkDesktopLockfile({
    pkgVersion: "0.2.38",
    lock: lockOf({ version: "0.2.38", depVersion: "0.2.38", resolvedVersion: "0.2.38" }),
    publishedVersions: ["0.2.37"],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /还没上 npm/);
});

test("条目 version 停在旧版 → 拦住（v0.2.35 的 ETARGET 成因）", () => {
  const result = checkDesktopLockfile({
    pkgVersion: "0.2.38",
    lock: lockOf({ version: "0.2.38", depVersion: "0.2.37", resolvedVersion: "0.2.37" }),
    publishedVersions: ["0.2.37"],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /ETARGET/);
});

test("lockfile 顶层/packages[\"\"] 版本没跟上 → 拦住（v0.2.37 漏的那一步）", () => {
  const stale = lockOf({ version: "0.2.37", depVersion: "0.2.37", resolvedVersion: "0.2.36" });
  const result = checkDesktopLockfile({
    pkgVersion: "0.2.38",
    lock: stale,
    publishedVersions: ["0.2.37"],
  });
  assert.equal(result.ok, false);
  const joined = result.errors.join("\n");
  assert.match(joined, /lockfile 顶层 version=0\.2\.37/);
  assert.match(joined, /packages\[""\]\.version=0\.2\.37/);
});

test("发行后仍指向上一版 tgz → 拦住，并要求 stage=post 对齐", () => {
  const result = checkDesktopLockfile({
    pkgVersion: "0.2.38",
    lock: lockOf({ version: "0.2.38", depVersion: "0.2.38", resolvedVersion: "0.2.37" }),
    publishedVersions: ["0.2.37", "0.2.38"],
  });
  assert.equal(result.stage, "post");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /已发布，resolved 仍指向 0\.2\.37/);
});

test("发行后对齐到本版 tgz → 通过", () => {
  const result = checkDesktopLockfile({
    pkgVersion: "0.2.38",
    lock: lockOf({ version: "0.2.38", depVersion: "0.2.38", resolvedVersion: "0.2.38" }),
    publishedVersions: ["0.2.38"],
  });
  assert.equal(result.ok, true, result.errors.join("; "));
});

test("缺 integrity 或结构异常 → 拦住", () => {
  const noIntegrity = checkDesktopLockfile({
    pkgVersion: "0.2.38",
    lock: lockOf({ version: "0.2.38", depVersion: "0.2.38", resolvedVersion: "0.2.38", integrity: "" }),
    publishedVersions: ["0.2.38"],
  });
  assert.equal(noIntegrity.ok, false);
  assert.match(noIntegrity.errors.join("\n"), /integrity/);

  const broken = checkDesktopLockfile({ pkgVersion: "0.2.38", lock: {}, publishedVersions: [] });
  assert.equal(broken.ok, false);
  assert.match(broken.errors.join("\n"), /结构异常/);
});

test("--stage 可强制阶段（离线校验用）", () => {
  const lock = lockOf({ version: "0.2.38", depVersion: "0.2.38", resolvedVersion: "0.2.37" });
  assert.equal(checkDesktopLockfile({ pkgVersion: "0.2.38", lock, stage: "pre" }).ok, true);
  assert.equal(checkDesktopLockfile({ pkgVersion: "0.2.38", lock, stage: "post" }).ok, false);
});
