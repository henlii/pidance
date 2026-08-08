import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, statSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PI_SUBAGENT_PI_BINARY_ENV,
  resolvePidancePiCli,
  configurePiSubagentBinary,
} = await jiti.import("./pi-subagent-bridge.ts");

test("resolvePidancePiCli 优先解析外部 pi（PATH / PIDANCE_PI_RUNTIME）", () => {
  const cli = resolvePidancePiCli();
  assert.ok(cli, "应解析到 pi 二进制");
  assert.ok(existsSync(cli), "路径必须存在");
  assert.ok(statSync(cli).isFile(), "必须是常规文件");
  // 外部 pi 或过渡期 npm 包 cli 均可
  assert.ok(
    /[/\\]pi$/.test(cli) || /pi-coding-agent[/\\]dist[/\\]cli\.js$/.test(cli),
    `unexpected cli path: ${cli}`,
  );
});

test("configurePiSubagentBinary 设置 PI_SUBAGENT_PI_BINARY 并返回路径", () => {
  const previous = process.env[PI_SUBAGENT_PI_BINARY_ENV];
  try {
    const cli = configurePiSubagentBinary();
    assert.ok(cli, "应成功配置");
    assert.equal(process.env[PI_SUBAGENT_PI_BINARY_ENV], cli);
    assert.ok(existsSync(process.env[PI_SUBAGENT_PI_BINARY_ENV]));
  } finally {
    if (previous === undefined) delete process.env[PI_SUBAGENT_PI_BINARY_ENV];
    else process.env[PI_SUBAGENT_PI_BINARY_ENV] = previous;
  }
});
