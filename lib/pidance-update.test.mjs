import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, existsSync } from "node:fs";
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
    const oldPkg = join(oldRel, "node_modules", "@henlii", "pidance");
    mkdirSync(oldPkg, { recursive: true });
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
