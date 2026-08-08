import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  parseNavigateTreeCommand,
  parseSetBranchLabelCommand,
  BRANCH_LABEL_MAX_LENGTH,
  startRpcSession,
} = await jiti.import("./rpc-manager.ts");

test("parseNavigateTreeCommand 透传 summarize 与 trim 后的 customInstructions / targetId", () => {
  assert.deepEqual(
    parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "  entry-1  ",
      summarize: true,
      customInstructions: "  关注 diff  ",
    }),
    {
      targetId: "entry-1",
      summarize: true,
      customInstructions: "关注 diff",
    },
  );

  assert.deepEqual(
    parseNavigateTreeCommand({ type: "navigate_tree", targetId: "e2" }),
    { targetId: "e2" },
  );

  // 仅空白的 customInstructions 不透传
  assert.deepEqual(
    parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e3",
      customInstructions: "   ",
    }),
    { targetId: "e3" },
  );
});

test("parseNavigateTreeCommand 拒绝非法参数与客户端 replaceInstructions", () => {
  assert.throws(
    () => parseNavigateTreeCommand({ type: "navigate_tree" }),
    /targetId is required/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({ type: "navigate_tree", targetId: "  " }),
    /targetId is required/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e1",
      replaceInstructions: true,
    }),
    /replaceInstructions is not allowed/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e1",
      summarize: "yes",
    }),
    /summarize must be a boolean/,
  );
  assert.throws(
    () => parseNavigateTreeCommand({
      type: "navigate_tree",
      targetId: "e1",
      customInstructions: 12,
    }),
    /customInstructions must be a string/,
  );
});

test("parseSetBranchLabelCommand 支持 set / clear，超长拒绝，targetId 已 trim", () => {
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "  n1  ", label: "  书签A  " }),
    { targetId: "n1", label: "书签A" },
  );

  // trim 后空 → 清除
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: "   " }),
    { targetId: "n1", label: undefined },
  );
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: undefined }),
    { targetId: "n1", label: undefined },
  );

  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: "x".repeat(BRANCH_LABEL_MAX_LENGTH + 1) }),
    /maximum length/,
  );
  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", label: "ok" }),
    /targetId is required/,
  );
  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1" }),
    /label is required/,
  );
  assert.throws(
    () => parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: 1 }),
    /label must be a string/,
  );

  // 边界：恰好最大长度可接受
  const max = "y".repeat(BRANCH_LABEL_MAX_LENGTH);
  assert.deepEqual(
    parseSetBranchLabelCommand({ type: "set_branch_label", targetId: "n1", label: max }),
    { targetId: "n1", label: max },
  );
});

// ---------------------------------------------------------------------------
// 静态门禁：产品只用外部 pi（rpc），inprocess 已移除
// ---------------------------------------------------------------------------

test("静态门禁：rpc-manager 不 import SDK / inprocess / session-service", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  // 默认（外部）路径零 SDK 顶层依赖
  assert.doesNotMatch(source, /from\s+["']@earendil/);
  // inprocess 死代码已删：不再动态加载 rpc-manager-inprocess
  assert.doesNotMatch(source, /import\(["']\.\/rpc-manager-inprocess["']\)/);
  // P1-4：rpc-manager 不 import session-service，导航动作经注入 seam 落地
  assert.doesNotMatch(source, /from\s+["']\.\/session-service["']/);
});

test("rpc-manager inprocess 模式抛「已移除」错误（源码含文案）", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /inprocess.*已移除|已移除/);

  // 动态验证：显式 PIDANCE_AGENT_RUNTIME=inprocess 时 startRpcSession 拒绝，
  // 不落外部进程启动路径。
  const prev = process.env.PIDANCE_AGENT_RUNTIME;
  process.env.PIDANCE_AGENT_RUNTIME = "inprocess";
  try {
    await assert.rejects(
      () => startRpcSession("inprocess-gate", "", "/tmp"),
      /已移除/,
    );
  } finally {
    if (prev === undefined) delete process.env.PIDANCE_AGENT_RUNTIME;
    else process.env.PIDANCE_AGENT_RUNTIME = prev;
  }
});
