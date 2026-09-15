import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const prune = await import("../scripts/prune-app-tree.mjs");
const { planPrune, applyPlan, summarize, verifyRequiredInputs, platformFamilies, platformDirRules } = prune;
const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "prune-app-tree.mjs");

function write(root, rel, content = "x") {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** 夹具：跨平台二进制、文档/示例/测试、调试符号、构建期包、必需输入各来一份。 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-prune-"));
  const files = [
    "src/main.js",
    "src/server-lifecycle.js",
    "assets/pidance-logo.ico",
    "node_modules/electron/dist/electron.exe",
    "node_modules/next/dist/server/next-server.js",
    "node_modules/react/package.json",
    "node_modules/node-pty/package.json",
    "node_modules/node-pty/prebuilds/win32-x64/pty.node",
    "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
    "node_modules/node-pty/prebuilds/linux-x64/pty.node",
    "node_modules/node-pty/third_party/conpty/1.0/win10-x64/conpty.dll",
    "node_modules/node-pty/third_party/conpty/1.0/win10-arm64/conpty.dll",
    "node_modules/@earendil-works/pi-coding-agent/package.json",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/win32-x64/bin/esbuild.exe",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/linux-x64/bin/esbuild",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/darwin-arm64/bin/esbuild",
    "node_modules/@img/colour/index.js",
    "node_modules/@img/sharp-win32-x64/sharp.node",
    "node_modules/@img/sharp-linux-x64/sharp.node",
    "node_modules/@mariozechner/clipboard/index.js",
    "node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.node",
    "node_modules/@mariozechner/clipboard-darwin-x64/clipboard.node",
    "node_modules/@next/swc-win32-x64-msvc/next-swc.node",
    "node_modules/@next/swc-linux-x64-gnu/next-swc.node",
    "node_modules/lucide-react/dist/lucide.js",
    "node_modules/foo/index.js",
    "node_modules/foo/LICENSE",
    "node_modules/foo/README.md",
    "node_modules/foo/docs/guide.md",
    "node_modules/foo/examples/demo.js",
    "node_modules/foo/tests/foo.test.js",
    "node_modules/foo/debug.pdb",
    "node_modules/foo/bundle.js.map",
    "node_modules/@henlii/pidance/package.json",
    "node_modules/@henlii/pidance/bin/pidance.js",
    "node_modules/@henlii/pidance/bin/pidance-http-server.js",
    "node_modules/@henlii/pidance/.next/BUILD_ID",
    "node_modules/@henlii/pidance/.next/cache/junk.bin",
  ];
  for (const rel of files) write(root, rel);
  return root;
}

function byCategory(entries) {
  const map = new Map();
  for (const entry of entries) {
    const list = map.get(entry.category) ?? [];
    list.push(entry.relPath);
    map.set(entry.category, list);
  }
  return map;
}

test("瘦身计划：只删非目标平台的多平台二进制，保留 win32-x64", () => {
  const root = makeFixture();
  try {
    const { entries, missingKeep } = planPrune({ root });
    const plan = byCategory(entries);
    const binaries = plan.get("cross-platform-binary") ?? [];
    assert.equal(missingKeep.length, 0);
    for (const expected of [
      "node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/linux-x64",
      "node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/darwin-arm64",
      "node_modules/@img/sharp-linux-x64",
      "node_modules/@mariozechner/clipboard-darwin-x64",
      "node_modules/@next/swc-linux-x64-gnu",
      "node_modules/node-pty/prebuilds/darwin-arm64",
      "node_modules/node-pty/prebuilds/linux-x64",
      "node_modules/node-pty/third_party/conpty/1.0/win10-arm64",
    ]) {
      assert.ok(binaries.includes(expected), `应删除 ${expected}`);
    }
    for (const kept of [
      "node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/win32-x64",
      "node_modules/@img/sharp-win32-x64",
      "node_modules/@img/colour",
      "node_modules/@mariozechner/clipboard",
      "node_modules/@mariozechner/clipboard-win32-x64-msvc",
      "node_modules/@next/swc-win32-x64-msvc",
      "node_modules/node-pty/prebuilds/win32-x64",
      "node_modules/node-pty/third_party/conpty/1.0/win10-x64",
    ]) {
      assert.ok(!binaries.includes(kept), `不应删除 ${kept}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("瘦身计划：文档/示例/测试/调试符号/构建期包/缓存各归各类，产物保留", () => {
  const root = makeFixture();
  try {
    const { entries } = planPrune({ root });
    const plan = byCategory(entries);
    assert.ok(plan.get("docs").includes("node_modules/foo/docs"));
    assert.ok(plan.get("examples").includes("node_modules/foo/examples"));
    assert.ok(plan.get("tests").includes("node_modules/foo/tests"));
    assert.ok(plan.get("debug-symbols").includes("node_modules/foo/debug.pdb"));
    assert.ok(plan.get("source-maps").includes("node_modules/foo/bundle.js.map"));
    assert.ok(plan.get("build-time-only").includes("node_modules/lucide-react"));
    assert.ok(plan.get("dev-assets").includes("node_modules/@henlii/pidance/.next/cache"));
    const all = entries.map((entry) => entry.relPath);
    for (const kept of ["node_modules/foo/index.js", "node_modules/foo/LICENSE", "node_modules/foo/README.md"]) {
      assert.ok(!all.includes(kept), `不应删除 ${kept}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("瘦身计划：嵌套命中只保留最外层，避免重复统计", () => {
  const root = makeFixture();
  try {
    const { entries } = planPrune({ root });
    const paths = entries.map((entry) => entry.relPath);
    for (const entry of paths) {
      assert.ok(!paths.some((other) => other !== entry && entry.startsWith(`${other}/`)), `${entry} 被更外层覆盖`);
    }
    const summary = summarize(entries);
    assert.ok(summary.every((item) => item.bytes > 0));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("执行瘦身：删除计划内条目、保留必需输入，缺输入时报告", () => {
  const root = makeFixture();
  try {
    const { entries } = planPrune({ root });
    const result = applyPlan({ root, entries });
    assert.ok(result.removed > 0);
    assert.equal(fs.existsSync(path.join(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/linux-x64")), false);
    assert.equal(verifyRequiredInputs(root, { platform: "win32" }).length, 0);

    fs.rmSync(path.join(root, "node_modules/@henlii/pidance/.next/BUILD_ID"));
    assert.deepEqual(verifyRequiredInputs(root, { platform: "win32" }), ["node_modules/@henlii/pidance/.next/BUILD_ID"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("平台规则：win32-x64 只保留目标平台包，别平台包不进入 keep", () => {
  const families = platformFamilies("win32", "x64");
  const esbuild = families.find((family) => family.id === "@esbuild");
  assert.equal(esbuild.keep.test("win32-x64"), true);
  assert.equal(esbuild.keep.test("linux-x64"), false);
  const swc = families.find((family) => family.id === "@next/swc");
  assert.equal(swc.keep.test("swc-win32-x64-msvc"), true);
  assert.equal(swc.keep.test("env"), false);
  assert.equal(swc.filter("env"), false);
  const img = families.find((family) => family.id === "@img");
  assert.equal(img.keep.test("sharp-libvips-win32-x64"), true);
  assert.equal(img.keep.test("colour"), true);
  assert.equal(img.keep.test("sharp-linux-x64"), false);

  const linuxFamilies = platformFamilies("linux", "x64");
  assert.equal(linuxFamilies[0].keep.test("linux-x64"), true);
  assert.equal(linuxFamilies[1].keep.test("swc-linux-x64-gnu"), true);
  assert.equal(linuxFamilies[2].keep.test("sharp-win32-x64"), false);

  const [prebuilds, conpty] = platformDirRules("win32", "x64");
  assert.equal(prebuilds.keep.test("win32-x64"), true);
  assert.equal(prebuilds.keep.test("darwin-arm64"), false);
  assert.equal(conpty.keep.test("win10-x64"), true);
  assert.equal(conpty.keep.test("win10-arm64"), false);
  assert.equal(platformDirRules("linux", "x64")[0].keep.test("linux-x64"), true);
});

test("缺少目标平台包时给出 missingKeep 警告，而不是静默删光", () => {
  const root = makeFixture();
  try {
    fs.rmSync(path.join(root, "node_modules/@next/swc-win32-x64-msvc"), { recursive: true, force: true });
    const { missingKeep } = planPrune({ root });
    assert.ok(missingKeep.some((message) => message.includes("@next/swc")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI：缺必需输入时先失败，且不改动任何文件", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-prune-"));
  try {
    write(root, "node_modules/foo/bundle.js.map");
    write(root, "node_modules/@img/sharp-linux-x64/sharp.node");
    const result = spawnSync(process.execPath, [scriptPath, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /尚未改动任何文件/);
    assert.equal(
      fs.existsSync(path.join(root, "node_modules/@img/sharp-linux-x64/sharp.node")),
      true,
      "校验失败时不得开删",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI：--dry-run --json 不改动文件，--keep-build-time 保留构建期包", () => {
  const root = makeFixture();
  try {
    const raw = execFileSync(process.execPath, [scriptPath, "--root", root, "--dry-run", "--json"], { encoding: "utf8" });
    const report = JSON.parse(raw);
    assert.equal(report.platform, "win32-x64");
    assert.ok(report.categories.some((item) => item.category === "cross-platform-binary"));
    assert.ok(fs.existsSync(path.join(root, "node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild/linux-x64")));

    execFileSync(process.execPath, [scriptPath, "--root", root, "--keep-build-time"], { encoding: "utf8" });
    assert.equal(fs.existsSync(path.join(root, "node_modules/lucide-react")), true);
    assert.equal(fs.existsSync(path.join(root, "node_modules/@img/sharp-linux-x64")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
