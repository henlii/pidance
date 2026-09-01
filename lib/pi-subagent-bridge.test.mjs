import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PI_SUBAGENT_PI_BINARY_ENV,
  resolvePackagePiCli,
  resolvePidancePiCli,
  configurePiSubagentBinaryFromPackage,
  configurePiSubagentBinary,
} = await jiti.import("./pi-subagent-bridge.ts");

test("resolvePackagePiCli 解析 package.json 声明的 bin.pi", () => {
  const packageRoot = join(
    process.cwd(),
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const declaredBin = typeof manifest.bin === "string"
    ? manifest.bin
    : manifest.bin?.pi;
  assert.equal(typeof declaredBin, "string");

  const cli = resolvePackagePiCli(process.cwd());
  assert.equal(cli, resolve(packageRoot, declaredBin));
  assert.ok(existsSync(cli));
  assert.ok(statSync(cli).isFile());
});

test("resolvePackagePiCli 拒绝 package root 外的 bin.pi", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-pi-cli-"));
  try {
    const packageRoot = join(
      root,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(root, "outside.js"), "");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ bin: { pi: "../../../outside.js" } }),
    );

    assert.equal(resolvePackagePiCli(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePidancePiCli 默认走包内 CLI", () => {
  const previous = process.env[PI_SUBAGENT_PI_BINARY_ENV];
  const prevRuntime = process.env.PIDANCE_PI_RUNTIME;
  try {
    delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
    delete process.env.PIDANCE_PI_RUNTIME;
    const cli = resolvePidancePiCli();
    assert.ok(cli);
    assert.match(cli, /pi-coding-agent[/\\]dist[/\\]bundle[/\\]cli\.js$/);
  } finally {
    if (previous === undefined) delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
    else process.env[PI_SUBAGENT_PI_BINARY_ENV] = previous;
    if (prevRuntime === undefined) delete process.env.PIDANCE_PI_RUNTIME;
    else process.env.PIDANCE_PI_RUNTIME = prevRuntime;
  }
});

test("configurePiSubagentBinaryFromPackage 设置环境变量", () => {
  const previous = process.env[PI_SUBAGENT_PI_BINARY_ENV];
  try {
    const cli = configurePiSubagentBinaryFromPackage();
    assert.ok(cli);
    assert.equal(process.env[PI_SUBAGENT_PI_BINARY_ENV], cli);
    assert.ok(existsSync(cli));
  } finally {
    if (previous === undefined) delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
    else process.env[PI_SUBAGENT_PI_BINARY_ENV] = previous;
  }
});

test("configurePiSubagentBinary 兼容别名", () => {
  const previous = process.env[PI_SUBAGENT_PI_BINARY_ENV];
  try {
    const cli = configurePiSubagentBinary();
    assert.ok(cli);
  } finally {
    if (previous === undefined) delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
    else process.env[PI_SUBAGENT_PI_BINARY_ENV] = previous;
  }
});
