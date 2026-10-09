/**
 * 内核内置扩展（codemode / tool-search / mcp）的接入契约。
 *
 * 关键不是「加载了」，而是「以可替换形态加载」：插件（例如 pi-mcp-adapter 的 `/mcp`）先注册同名命令时，
 * 内置那个必须整个被略过 —— 否则两边都会去读 mcp.json 连服务器，等于双重连接。
 * 这个文件用真的 DefaultResourceLoader 在临时目录里验证这条语义，并用一个「假适配器」代表插件。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });

test("内置扩展以可替换形态导出：三项、都 replaceable、factory 是函数", async () => {
  const { PIDANCE_BUILTIN_EXTENSIONS } = await jiti.import("./sdk-session-host.ts");
  assert.ok(Array.isArray(PIDANCE_BUILTIN_EXTENSIONS));
  const names = PIDANCE_BUILTIN_EXTENSIONS.map((e) => e.name).sort();
  assert.deepEqual(names, ["codemode", "mcp", "tool-search"]);
  for (const entry of PIDANCE_BUILTIN_EXTENSIONS) {
    assert.equal(typeof entry.factory, "function", `${entry.name} 的 factory 必须是函数`);
    // 纯函数形态会让内置与插件同时加载（双重连接），所以这条是硬要求
    assert.equal(entry.replaceable, true, `${entry.name} 必须 replaceable`);
  }
});

test("插件注册同名命令时内置 MCP 被顶掉，codemode / tool-search 照常在", async (t) => {
  const { DefaultResourceLoader } = await import("@earendil-works/pi-coding-agent");
  const { PIDANCE_BUILTIN_EXTENSIONS } = await jiti.import("./sdk-session-host.ts");
  const root = mkdtempSync(join(tmpdir(), "pidance-builtin-ext-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 代表 pi-mcp-adapter：它注册 `/mcp` 命令（内置 MCP 就是靠这个名字被略过的）
  const adapterLike = {
    name: "fake-mcp-adapter",
    factory: (pi) => pi.registerCommand("mcp", { handler: async () => {} }),
  };

  const withAdapter = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [...PIDANCE_BUILTIN_EXTENSIONS, adapterLike],
  });
  await withAdapter.reload();
  const paths = withAdapter.getExtensions().extensions.map((e) => e.path);
  assert.ok(paths.includes("<inline:codemode>"), `codemode 应在场：${paths.join(",")}`);
  assert.ok(paths.includes("<inline:tool-search>"), `tool-search 应在场：${paths.join(",")}`);
  assert.ok(!paths.includes("<inline:mcp>"), `内置 MCP 应被同名插件顶掉：${paths.join(",")}`);

  // 反证：没有插件时内置 MCP 一定在场 —— 证明上一条是「被顶掉」而不是「没接上」
  const withoutAdapter = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [...PIDANCE_BUILTIN_EXTENSIONS],
  });
  await withoutAdapter.reload();
  const pathsWithout = withoutAdapter.getExtensions().extensions.map((e) => e.path);
  assert.ok(pathsWithout.includes("<inline:mcp>"), `没有插件时内置 MCP 应在场：${pathsWithout.join(",")}`);
});
