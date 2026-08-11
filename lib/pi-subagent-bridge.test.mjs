import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, statSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PI_SUBAGENT_PI_BINARY_ENV,
  resolvePackagePiCli,
  resolvePidancePiCli,
  configurePiSubagentBinaryFromPackage,
  configurePiSubagentBinary,
} = await jiti.import("./pi-subagent-bridge.ts");

test("resolvePackagePiCli 解析到包内 dist/cli.js", () => {
  const cli = resolvePackagePiCli(process.cwd());
  assert.ok(cli, "应解析到包内 cli");
  assert.ok(existsSync(cli));
  assert.ok(statSync(cli).isFile());
  assert.match(cli, /pi-coding-agent[/\\]dist[/\\]cli\.js$/);
});

test("resolvePidancePiCli 默认走包内 CLI", () => {
  const previous = process.env[PI_SUBAGENT_PI_BINARY_ENV];
  const prevRuntime = process.env.PIDANCE_PI_RUNTIME;
  try {
    delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
    delete process.env.PIDANCE_PI_RUNTIME;
    const cli = resolvePidancePiCli();
    assert.ok(cli);
    assert.match(cli, /pi-coding-agent[/\\]dist[/\\]cli\.js$/);
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
