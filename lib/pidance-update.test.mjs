import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const m = await jiti.import("./pidance-update.ts");

test("compareSemver 基本序", () => {
  assert.equal(m.compareSemver("0.1.1", "0.1.0"), 1);
  assert.equal(m.compareSemver("0.1.0", "0.1.1"), -1);
  assert.equal(m.compareSemver("0.1.1", "0.1.1"), 0);
  assert.equal(m.compareSemver("1.0.0", "1.0.0-beta"), 1);
});

test("resolveFormalInstallRoot 识别 releases 布局", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-upd-"));
  try {
    const release = join(root, "releases", "0.1.1");
    const pkg = join(release, "node_modules", "@henlii", "pidance");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@henlii/pidance", version: "0.1.1" }));
    assert.equal(m.resolveFormalInstallRoot(pkg, {}), root);
    assert.equal(m.resolveFormalInstallRoot(release, {}), root);
    assert.equal(m.resolveFormalInstallRoot(root, {}), null);
    assert.equal(m.resolveFormalInstallRoot("/tmp", { PIDANCE_INSTALL_ROOT: root }), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInstalledPidanceVersion 优先产品包", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-ver-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@henlii/pidance", version: "0.1.1" }),
    );
    assert.equal(m.readInstalledPidanceVersion(root), "0.1.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkPidanceUpdate：有新版本且正式安装可升级", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-chk-"));
  try {
    const release = join(root, "releases", "0.1.0");
    const pkg = join(release, "node_modules", "@henlii", "pidance");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@henlii/pidance", version: "0.1.0" }));
    const fetchImpl = async () =>
      new Response(JSON.stringify({ version: "0.1.1" }), { status: 200 });
    // 清缓存
    globalThis.__piPidanceLatestCache = undefined;
    const r = await m.checkPidanceUpdate({
      cwd: pkg,
      env: { PIDANCE_NPM_REGISTRY: "https://registry.npmjs.org/" },
      fetchImpl,
      now: Date.now(),
    });
    assert.equal(r.currentVersion, "0.1.0");
    assert.equal(r.latestVersion, "0.1.1");
    assert.equal(r.updateAvailable, true);
    assert.equal(r.upgradeSupported, true);
    assert.equal(r.upgradeMode, "formal-install");
    assert.equal(r.installRoot, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkPidanceUpdate：工作区有新版本但不可一键升级", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-ws-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@henlii/pidance", version: "0.1.0" }),
    );
    globalThis.__piPidanceLatestCache = undefined;
    const fetchImpl = async () =>
      new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 });
    const r = await m.checkPidanceUpdate({
      cwd: root,
      env: {},
      fetchImpl,
      now: Date.now(),
    });
    assert.equal(r.updateAvailable, true);
    assert.equal(r.upgradeSupported, false);
    assert.equal(r.upgradeMode, "workspace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyPidanceUpdate：正式布局安装并切换 current（不重启）", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-apply-"));
  try {
    const oldRel = join(root, "releases", "0.1.0");
    const staleRel = join(root, "releases", "0.0.9");
    const localRel = join(root, "releases", "0.1.0-local-dead");
    const oldPkg = join(oldRel, "node_modules", "@henlii", "pidance");
    mkdirSync(oldPkg, { recursive: true });
    mkdirSync(staleRel, { recursive: true });
    mkdirSync(localRel, { recursive: true });
    writeFileSync(join(oldPkg, "package.json"), JSON.stringify({ name: "@henlii/pidance", version: "0.1.0" }));
    symlinkSync(oldRel, join(root, "current"));

    globalThis.__piPidanceLatestCache = undefined;
    const fetchImpl = async () =>
      new Response(JSON.stringify({ version: "0.1.1" }), { status: 200 });

    const calls = [];
    const execFileImpl = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      if (cmd === "npm") {
        // 模拟 npm install 产物
        const pkgDir = join(opts.cwd, "node_modules", "@henlii", "pidance");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(
          join(pkgDir, "package.json"),
          JSON.stringify({ name: "@henlii/pidance", version: "0.1.1" }),
        );
        return { stdout: "ok", stderr: "" };
      }
      throw new Error(`unexpected ${cmd}`);
    };

    const r = await m.applyPidanceUpdate({
      cwd: oldPkg,
      env: { PIDANCE_SKIP_SERVICE_RESTART: "1" },
      fetchImpl,
      execFileImpl,
      restartService: false,
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, "upgraded");
    assert.equal(r.targetVersion, "0.1.1");
    assert.equal(calls.some((c) => c.cmd === "npm"), true);
    // current 指向新 release
    const fs = await import("node:fs");
    const cur = fs.realpathSync(join(root, "current"));
    assert.ok(cur.replace(/\\/g, "/").endsWith("/releases/0.1.1"));
    assert.equal(existsSync(join(root, "releases", "0.1.1")), true);
    assert.equal(existsSync(join(root, "releases", "0.1.0")), true);
    assert.equal(existsSync(join(root, "releases", "0.0.9")), false);
    assert.equal(existsSync(join(root, "releases", "0.1.0-local-dead")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getCachedLatestVersion：新鲜缓存命中，force 强制重拉", async () => {
  globalThis.__piPidanceLatestCache = undefined;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 });
  };
  const now = Date.now();
  // 首次：无缓存 → 拉取
  const first = await m.getCachedLatestVersion("https://registry.npmjs.org/", now, fetchImpl);
  assert.equal(first, "0.2.0");
  assert.equal(calls, 1);
  // 新鲜缓存 → 命中，不再拉
  const second = await m.getCachedLatestVersion("https://registry.npmjs.org/", now + 1000, fetchImpl);
  assert.equal(second, "0.2.0");
  assert.equal(calls, 1);
  // force=true → 跳过缓存重拉
  const forced = await m.getCachedLatestVersion("https://registry.npmjs.org/", now + 2000, fetchImpl, true);
  assert.equal(forced, "0.2.0");
  assert.equal(calls, 2);
  globalThis.__piPidanceLatestCache = undefined;
});

test("checkPidanceUpdate：forceRefresh 覆盖进程内缓存", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-frc-")); 
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@henlii/pidance", version: "0.1.3" }),
    );
    globalThis.__piPidanceLatestCache = { latest: "0.1.3", ts: Date.now() };
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: "0.2.0" }), { status: 200 });
    };
    // 不带 force：命中缓存 → 显示已最新（旧行为，保留缓存路径）
    const cached = await m.checkPidanceUpdate({ cwd: root, env: {}, fetchImpl, now: Date.now() });
    assert.equal(cached.latestVersion, "0.1.3");
    assert.equal(cached.updateAvailable, false);
    assert.equal(calls, 0);
    // forceRefresh：强制拉 npm → 发现 0.2.0
    const forced = await m.checkPidanceUpdate({
      cwd: root,
      env: {},
      fetchImpl,
      now: Date.now(),
      forceRefresh: true,
    });
    assert.equal(forced.latestVersion, "0.2.0");
    assert.equal(forced.updateAvailable, true);
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    globalThis.__piPidanceLatestCache = undefined;
  }
});

test("pruneOldReleases 只保留 keep 与 current 指向", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-prune-"));
  try {
    for (const ver of ["0.1.0", "0.1.1", "0.2.0", "0.1.0-local-abc"]) {
      mkdirSync(join(root, "releases", ver), { recursive: true });
    }
    symlinkSync(join(root, "releases", "0.1.1"), join(root, "current"));
    const removed = m.pruneOldReleases(root, ["0.1.1", "0.1.0"]);
    assert.equal(removed.includes("0.2.0"), true);
    assert.equal(removed.includes("0.1.0-local-abc"), true);
    assert.equal(existsSync(join(root, "releases", "0.1.0")), true);
    assert.equal(existsSync(join(root, "releases", "0.1.1")), true);
    assert.equal(existsSync(join(root, "releases", "0.2.0")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readInstalledPidanceVersion 不认旧品牌名 Pidance", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-oldname-"));
  try {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "Pidance", version: "9.9.9" }),
    );
    assert.notEqual(m.readInstalledPidanceVersion(root), "9.9.9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
