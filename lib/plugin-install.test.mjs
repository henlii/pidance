/**
 * 自管插件 install/remove/update 逻辑测试：
 * 使用 mock runner 注入，避免真实调用 npm；settings 走临时目录。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./plugin-install.ts");

/** 写 settings.json（只含 packages 字段） */
function writeSettings(settingsPath, packages) {
  writeFileSync(settingsPath, JSON.stringify({ packages }), "utf8");
}

/** 读 settings.json 的 packages 字段 */
function readPackages(settingsPath) {
  return JSON.parse(readFileSync(settingsPath, "utf8")).packages;
}

/** 记录 npm 调用的 mock runner */
function mockRunner(calls) {
  return {
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "", stderr: "" };
    },
  };
}

test("resolveNpmBin：node 同目录存在 npm 时用绝对路径", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-npm-bin-"));
  try {
    writeFileSync(join(dir, "npm"), "");
    assert.equal(mod.resolveNpmBin({}, join(dir, "node")), join(dir, "npm"));
    assert.equal(mod.resolveNpmBin({}, join(tmpdir(), "no-such-node-bin", "node")), "npm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requireNpmSource 校验 npm: 源", () => {
  assert.deepEqual(mod.requireNpmSource("npm:pi-web-access"), {
    spec: "pi-web-access",
    name: "pi-web-access",
    version: undefined,
  });
  assert.deepEqual(mod.requireNpmSource("npm:@scope/pkg@1.2.3"), {
    spec: "@scope/pkg@1.2.3",
    name: "@scope/pkg",
    version: "1.2.3",
  });
  // 非 npm: 源抛 PluginUnsupportedSourceError
  assert.throws(() => mod.requireNpmSource("git:github.com/x/y"), mod.PluginUnsupportedSourceError);
  assert.throws(() => mod.requireNpmSource("/local/path"), mod.PluginUnsupportedSourceError);
});

test("getNpmInstallRoot global/project 路径", () => {
  const agentDir = join(tmpdir(), "pidance-agent");
  assert.equal(mod.getNpmInstallRoot("global", { agentDir }), join(agentDir, "npm"));
  assert.equal(
    mod.getNpmInstallRoot("project", { agentDir, cwd: "/proj" }),
    join("/proj", ".pi", "npm"),
  );
});

test("addPackageToSettings 追加 / 去重 / 保留过滤信息", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-install-add-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const settingsPath = join(agentDir, "settings.json");
    writeSettings(settingsPath, []);

    // 不存在 → 追加
    assert.equal(mod.addPackageToSettings("npm:foo", "global", { agentDir }), true);
    assert.deepEqual(readPackages(settingsPath), ["npm:foo"]);
    // 同源重复 → 不重复添加
    assert.equal(mod.addPackageToSettings("npm:foo", "global", { agentDir }), false);
    assert.deepEqual(readPackages(settingsPath), ["npm:foo"]);
    // disabled（object）entry：同身份更新 source，保留过滤数组
    writeSettings(settingsPath, [
      { source: "npm:foo", extensions: [], skills: [], prompts: [], themes: [] },
    ]);
    assert.equal(mod.addPackageToSettings("npm:foo@2.0.0", "global", { agentDir }), true);
    assert.deepEqual(readPackages(settingsPath), [
      { source: "npm:foo@2.0.0", extensions: [], skills: [], prompts: [], themes: [] },
    ]);
    // 版本不同的另一包 → 追加
    assert.equal(mod.addPackageToSettings("npm:bar", "global", { agentDir }), true);
    assert.equal(readPackages(settingsPath).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removePackageFromSettings 移除匹配（身份忽略版本）", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-install-rm-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const settingsPath = join(agentDir, "settings.json");
    writeSettings(settingsPath, ["npm:foo", "npm:bar@1.0.0"]);

    assert.equal(mod.removePackageFromSettings("npm:foo", "global", { agentDir }), true);
    assert.deepEqual(readPackages(settingsPath), ["npm:bar@1.0.0"]);
    // 按身份匹配：输入不带版本也能移除 pinned entry
    assert.equal(mod.removePackageFromSettings("npm:bar", "global", { agentDir }), true);
    assert.deepEqual(readPackages(settingsPath), []);
    // 无匹配 → false 且不改写
    assert.equal(mod.removePackageFromSettings("npm:zzz", "global", { agentDir }), false);
    assert.deepEqual(readPackages(settingsPath), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installPluginPackage：npm install + package.json + settings 追加", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-install-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const settingsPath = join(agentDir, "settings.json");
    writeSettings(settingsPath, []);
    const calls = [];
    const installRoot = join(agentDir, "npm");

    await mod.installPluginPackage("npm:demo-plugin@1.2.0", "global", {
      agentDir,
      runner: mockRunner(calls),
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "install",
      "demo-plugin@1.2.0",
      "--prefix",
      installRoot,
      "--legacy-peer-deps",
    ]);
    // 安装根创建 package.json
    assert.equal(
      JSON.parse(readFileSync(join(installRoot, "package.json"), "utf8")).private,
      true,
    );
    // settings 追加源字符串
    assert.deepEqual(readPackages(settingsPath), ["npm:demo-plugin@1.2.0"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installPluginPackage：project scope 安装到 <cwd>/.pi/npm 并写项目 settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-install-proj-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "proj");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const calls = [];
    const installRoot = join(cwd, ".pi", "npm");

    await mod.installPluginPackage("npm:p2", "project", {
      agentDir,
      cwd,
      runner: mockRunner(calls),
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "install",
      "p2",
      "--prefix",
      installRoot,
      "--legacy-peer-deps",
    ]);
    // 项目 settings 写在 <cwd>/.pi/settings.json
    assert.deepEqual(readPackages(join(cwd, ".pi", "settings.json")), ["npm:p2"]);
    // 全局 settings 不受影响
    assert.equal(existsSync(join(agentDir, "settings.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installPluginPackage：非 npm: 源抛错且不改 settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-install-bad-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const settingsPath = join(agentDir, "settings.json");
    writeSettings(settingsPath, []);
    const calls = [];

    await assert.rejects(
      mod.installPluginPackage("git:github.com/x/y", "global", {
        agentDir,
        runner: mockRunner(calls),
      }),
      mod.PluginUnsupportedSourceError,
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(readPackages(settingsPath), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removePluginPackage：npm uninstall + settings 移除", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-remove-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const settingsPath = join(agentDir, "settings.json");
    writeSettings(settingsPath, ["npm:foo"]);
    // installRoot 存在才真正跑 npm
    mkdirSync(join(agentDir, "npm"), { recursive: true });
    const calls = [];

    await mod.removePluginPackage("npm:foo", "global", {
      agentDir,
      runner: mockRunner(calls),
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "uninstall",
      "foo",
      "--prefix",
      join(agentDir, "npm"),
      "--legacy-peer-deps",
    ]);
    assert.deepEqual(readPackages(settingsPath), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removePluginPackage：installRoot 不存在时仅清理 settings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-remove-noroot-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const settingsPath = join(agentDir, "settings.json");
    writeSettings(settingsPath, ["npm:foo"]);
    const calls = [];

    await mod.removePluginPackage("npm:foo", "global", {
      agentDir,
      runner: mockRunner(calls),
    });

    assert.equal(calls.length, 0);
    assert.deepEqual(readPackages(settingsPath), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePluginPackage：未 pinned 升到 <name>@latest，settings 保持原样", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-update-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const settingsPath = join(agentDir, "settings.json");
    writeSettings(settingsPath, ["npm:foo"]);
    mkdirSync(join(agentDir, "npm"), { recursive: true });
    const calls = [];

    await mod.updatePluginPackage("npm:foo", "global", {
      agentDir,
      runner: mockRunner(calls),
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "install",
      "foo@latest",
      "--prefix",
      join(agentDir, "npm"),
      "--legacy-peer-deps",
    ]);
    // update 不改写 settings（保留原 source，后续仍可匹配）
    assert.deepEqual(readPackages(settingsPath), ["npm:foo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePluginPackage：pinned 版本按原 spec 重装", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-update-pinned-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeSettings(join(agentDir, "settings.json"), ["npm:foo@1.2.3"]);
    mkdirSync(join(agentDir, "npm"), { recursive: true });
    const calls = [];

    await mod.updatePluginPackage("npm:foo", "global", {
      agentDir,
      runner: mockRunner(calls),
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      "install",
      "foo@1.2.3",
      "--prefix",
      join(agentDir, "npm"),
      "--legacy-peer-deps",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("updatePluginPackage：无匹配抛清晰错误且不调用 npm", async () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-update-nomatch-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    writeSettings(join(agentDir, "settings.json"), ["npm:other"]);
    const calls = [];

    await assert.rejects(
      mod.updatePluginPackage("npm:foo", "global", {
        agentDir,
        runner: mockRunner(calls),
      }),
      /未在.*找到匹配/,
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
