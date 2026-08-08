import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseNpmSpec,
  listPluginPackages,
  getInstalledPath,
} = await jiti.import("./plugin-packages.ts");

test("parseNpmSpec 解析 name 与 version", () => {
  assert.deepEqual(parseNpmSpec("pi-web-access"), { name: "pi-web-access", version: undefined });
  assert.deepEqual(parseNpmSpec("pi-web-access@1.2.3"), {
    name: "pi-web-access",
    version: "1.2.3",
  });
  assert.deepEqual(parseNpmSpec("@scope/pkg@2.0.0"), {
    name: "@scope/pkg",
    version: "2.0.0",
  });
});

test("已安装 npm 包：extensions 计入 counts", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-plugins-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "proj");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:demo-plugin"] }),
      "utf8",
    );

    const pkgRoot = join(agentDir, "npm", "node_modules", "demo-plugin");
    mkdirSync(join(pkgRoot, "extensions"), { recursive: true });
    writeFileSync(join(pkgRoot, "extensions", "index.ts"), "export default {};\n", "utf8");
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({ name: "demo-plugin", version: "1.0.0" }),
      "utf8",
    );

    const result = listPluginPackages({ agentDir, cwd });
    assert.equal(result.packages.length, 1);
    const pkg = result.packages[0];
    assert.equal(pkg.source, "npm:demo-plugin");
    assert.equal(pkg.scope, "global");
    assert.ok(pkg.installedPath);
    assert.ok(pkg.counts.extensions >= 1);
    assert.equal(pkg.status, "loaded");
    assert.equal(result.totals.extensions >= 1, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未安装包 → missing + diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-plugins-miss-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "proj");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ packages: ["npm:not-installed-xyz"] }),
      "utf8",
    );

    const result = listPluginPackages({ agentDir, cwd });
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].status, "missing");
    assert.equal(result.packages[0].installedPath, undefined);
    assert.ok(result.diagnostics.some((d) => d.type === "warning"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getInstalledPath npm user 路径", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-plugins-path-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "proj");
    mkdirSync(agentDir, { recursive: true });
    const pkgRoot = join(agentDir, "npm", "node_modules", "foo");
    mkdirSync(pkgRoot, { recursive: true });
    const info = getInstalledPath("npm:foo", "global", { agentDir, cwd });
    assert.equal(info.kind, "npm");
    assert.equal(info.installedPath, pkgRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
