/**
 * 斜杠命令参数补全的服务端语义（issue #75）。
 *
 * 用**真实的 SdkSessionHost** 驱动 `send({type:"get_command_argument_completions"})`，
 * 只把扩展运行的命令表换成假的（与 tool-render-slots 同一手法）：
 * 插件返回 `AutocompleteItem[]`，宿主必须规范化后再给客户端 ——
 * 非法条目（缺 value / 非对象）一律丢弃，插件抛错按「没有候选」处理。
 *
 * 与 TUI 的契约对齐（`pi-tui/dist/autocomplete.js`）：
 * - prefix 是**命令名之后的整段文本**，含空串；
 * - 返回的 value 是要替进输入框的完整参数文本（可以自带尾部空格）；
 * - 没有该命令 / 没有该方法 -> 空候选（不是错误）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { startSdkSessionHost } = await jiti.import("./sdk-session-host.ts");

async function withHost(commands, run) {
  const cwd = mkdtempSync(join(tmpdir(), "slash-args-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "slash-args-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "__new__test",
      sessionFile: "",
      cwd,
      agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
    });
    const runner = host.session.extensionRunner;
    const original = runner.getRegisteredCommands;
    runner.getRegisteredCommands = () => commands;
    try {
      await run(host);
    } finally {
      runner.getRegisteredCommands = original;
    }
  } finally {
    await host?.destroyAsync?.().catch(() => {});
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("参数补全：prefix 原样传给插件，返回的 value 保留（含自带空格）", async () => {
  const calls = [];
  await withHost([
    {
      invocationName: "mcp",
      description: "MCP",
      getArgumentCompletions: (prefix) => {
        calls.push(prefix);
        return [{ value: "token set ", label: "set — set token" }, { value: "token status", label: "status" }];
      },
    },
  ], async (host) => {
    const result = await host.send({ type: "get_command_argument_completions", name: "mcp", prefix: "tok" });
    assert.deepEqual(calls, ["tok"], "插件收到的是命令名之后的整段文本");
    assert.deepEqual(result, {
      items: [
        { value: "token set ", label: "set — set token" },
        { value: "token status", label: "status" },
      ],
    });
  });
});

test("参数补全：空 prefix 也转发（列出第一级候选）", async () => {
  await withHost([
    { invocationName: "subagents-guide", getArgumentCompletions: (prefix) => (prefix === "" ? [{ value: "topics", label: "topics" }] : null) },
  ], async (host) => {
    const result = await host.send({ type: "get_command_argument_completions", name: "subagents-guide", prefix: "" });
    assert.deepEqual(result, { items: [{ value: "topics", label: "topics" }] });
  });
});

test("参数补全：没有该命令 / 没有该方法 / 返回 null 一律空候选", async () => {
  await withHost([
    { invocationName: "plain", description: "no completions" },
    { invocationName: "nulls", getArgumentCompletions: () => null },
  ], async (host) => {
    assert.deepEqual(await host.send({ type: "get_command_argument_completions", name: "plain", prefix: "" }), { items: [] });
    assert.deepEqual(await host.send({ type: "get_command_argument_completions", name: "nulls", prefix: "" }), { items: [] });
    assert.deepEqual(await host.send({ type: "get_command_argument_completions", name: "missing", prefix: "" }), { items: [] });
  });
});

test("参数补全：非法条目被丢弃，插件抛错按空候选处理", async () => {
  await withHost([
    {
      invocationName: "messy",
      getArgumentCompletions: () => [
        { value: "ok", label: "Ok" },
        { value: "", label: "empty value" },
        { label: "no value" },
        "not-an-object",
        null,
        { value: "no-label" },
      ],
    },
    { invocationName: "boom", getArgumentCompletions: () => { throw new Error("plugin boom"); } },
  ], async (host) => {
    assert.deepEqual(await host.send({ type: "get_command_argument_completions", name: "messy", prefix: "" }), {
      items: [
        { value: "ok", label: "Ok" },
        { value: "no-label", label: "no-label" },
      ],
    });
    assert.deepEqual(await host.send({ type: "get_command_argument_completions", name: "boom", prefix: "" }), { items: [] });
  });
});

test("get_commands 标记哪些命令提供参数补全（客户端据此决定要不要问下一级）", async () => {
  await withHost([
    { invocationName: "with-args", description: "a", getArgumentCompletions: () => [] },
    { invocationName: "without-args", description: "b" },
  ], async (host) => {
    const result = await host.send({ type: "get_commands" });
    const byName = new Map(result.commands.map((c) => [c.name, c]));
    assert.equal(byName.get("with-args").hasArgumentCompletions, true);
    assert.equal("hasArgumentCompletions" in byName.get("without-args"), false, "没有该方法就不该标能力");
  });
});
