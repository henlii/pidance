/**
 * 工具显示元数据的**活路径**（issue #75 阻断 2 修复轮）。
 *
 * 为什么必须有这条：审查发现活路径原本读 `session.getToolDefinition`，而 SDK **内置**定义也
 * 从那里出来 —— 内置工具的 `label` 就是那个小写工具名（`bash`/`edit`/`read`…），`edit` 还带
 * `renderShell: "self"`。采纳它们的后果是：本轮标题变 `bash·`/`edit·` 并在下一轮跳回 `Bash·`
 * （活快照有无决定走哪条路），edit 还会丢掉边框与状态色。而历史投影只扫扩展表，刷新后又变回去。
 *
 * 现在活路径只认**扩展注册**的定义（会话的 `ExtensionRunner.getToolDefinition`），与历史路径
 * 同一来源、同一规则（先注册者胜）。这里用真实 SdkSessionHost + 桩扩展表驱动那个投影步骤，
 * 断言：扩展声明生效、内置工具永远拿不到元数据、同名前缀的 label 被忽略、异常不影响事件流。
 *
 * 不调用真实模型：直接驱动 `withToolDisplayMeta` 这个投影步骤（与 lib/tool-render-slots.test.mjs
 * 同一手法：只打内部入口，但要断言输出形状）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { startSdkSessionHost } = await jiti.import("./sdk-session-host.ts");

const HOST_SOURCE = readFileSync(new URL("./sdk-session-host.ts", import.meta.url), "utf8");

/**
 * 起一个真实宿主（cwd/agentDir 都是临时目录），把扩展表的查找换成桩。
 * `tools` 里放的是「扩展注册的定义」——内置工具不在其中，这正是 runner 的真实形状。
 */
async function withHost(tools, run, { toolNames = ["bash", "edit", "read", "send_file_to_user"] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "display-meta-cwd-"));
  const agentDir = mkdtempSync(join(tmpdir(), "display-meta-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: "__new__display_meta",
      sessionFile: "",
      cwd,
      agentDir,
      toolNames,
      idleTimeoutMs: 60_000,
    });
    const runner = host.session.extensionRunner;
    const stub = (name) => tools[name];
    runner.getToolDefinition = stub;
    try {
      await run({ host, project: (event) => host.withToolDisplayMeta(event) });
    } finally {
      delete runner.getToolDefinition;
    }
  } finally {
    await host?.destroyAsync?.().catch(() => {});
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

const startEvent = (toolName) => ({ type: "tool_execution_start", toolCallId: "call-1", toolName, args: {} });

test("活路径：扩展声明的 label 与 renderShell 附到工具事件上", async () => {
  await withHost(
    {
      mcp: { name: "mcp", label: "MCP", renderShell: "self" },
      ask_advisor: { name: "ask_advisor", label: "Ask Advisor", renderShell: "self" },
    },
    async ({ project }) => {
      const mcp = project(startEvent("mcp"));
      assert.equal(mcp.toolLabel, "MCP");
      assert.equal(mcp.toolShell, "self");
      const advisor = project(startEvent("ask_advisor"));
      assert.equal(advisor.toolLabel, "Ask Advisor");
      assert.equal(advisor.toolShell, "self");
    },
  );
});

test("活路径：内置工具拿不到元数据（label 是小写工具名、edit 还带 self 的那种）", async () => {
  await withHost({}, async ({ project }) => {
    // 桩里没有 bash/edit —— 这正是 ExtensionRunner 的真实形状（它只汇总扩展注册的工具）。
    for (const name of ["bash", "edit", "read"]) {
      const event = project(startEvent(name));
      assert.equal(event.toolLabel, undefined, `${name} 不该带上内置定义的小写 label`);
      assert.equal(event.toolShell, undefined, `${name} 不该带上内置定义的 renderShell`);
    }
  });
});

test("活路径：label 精确等于工具名视为没声明名字，self 仍生效", async () => {
  await withHost(
    { edit: { name: "edit", label: "edit", renderShell: "self" }, bash: { name: "bash", label: "bash" } },
    async ({ project }) => {
      const edit = project(startEvent("edit"));
      assert.equal(edit.toolLabel, undefined, "同名前缀的 label 不得改标题");
      assert.equal(edit.toolShell, "self", "renderShell 独立判定");
      assert.equal(project(startEvent("bash")).toolLabel, undefined);
    },
  );
});

test("活路径：只差大小写的 label 是显示改进，必须保留（pi-mcp-adapter 给 mcp 的 label 是 MCP）", async () => {
  await withHost({ mcp: { name: "mcp", label: "MCP" } }, async ({ project }) => {
    assert.equal(project(startEvent("mcp")).toolLabel, "MCP");
  });
});

test("活路径：扩展表抛错 / 返回非对象 / 非 start 事件都不影响事件流", async () => {
  await withHost(
    {
      boom: null,
    },
    async ({ host, project }) => {
      const runner = host.session.extensionRunner;
      runner.getToolDefinition = () => { throw new Error("extension blew up"); };
      const event = startEvent("boom");
      assert.deepEqual(project(event), event, "抛错时原样返回");
      runner.getToolDefinition = () => "not-an-object";
      assert.deepEqual(project(startEvent("boom")), startEvent("boom"), "非对象定义原样返回");
      const messageEnd = { type: "message_end", message: { role: "assistant" } };
      assert.deepEqual(project(messageEnd), messageEnd, "只有 start 事件需要元数据");
    },
  );
});

test("源码契约：活路径查扩展 runner，而不是 session.getToolDefinition", () => {
  const start = HOST_SOURCE.indexOf("private withToolDisplayMeta(");
  assert.ok(start > 0, "缺 withToolDisplayMeta");
  const block = HOST_SOURCE.slice(start, HOST_SOURCE.indexOf("private contextUsageSnapshot("));
  assert.ok(
    block.includes("this.session.extensionRunner"),
    "必须查扩展 runner：session.getToolDefinition 会带进内置定义（label 是小写工具名）",
  );
  assert.ok(
    !block.includes("getToolRenderDefinition"),
    "不得再走 getToolRenderDefinition（那条路含内置定义）",
  );
});
