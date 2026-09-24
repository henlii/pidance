import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  collectTurnWrittenFiles,
  extractWrittenPathsFromToolCall,
  isTurnFinalAssistantMessage,
  resolveWrittenFilePath,
} = await jiti.import("./turn-written-files.ts");

const CWD = "/repo";

function toolCall(toolCallId, toolName, input) {
  return { type: "toolCall", toolCallId, toolName, input };
}

function assistant(toolCalls, text = "") {
  return {
    role: "assistant",
    model: "m",
    provider: "p",
    content: [...(text ? [{ type: "text", text }] : []), ...toolCalls],
  };
}

function toolResult(toolCallId, { isError = false, details } = {}) {
  return {
    role: "toolResult",
    toolCallId,
    content: [{ type: "text", text: "ok" }],
    isError,
    ...(details !== undefined ? { details } : {}),
  };
}

function user(text) {
  return { role: "user", content: text };
}

function resultsOf(entries) {
  return new Map(entries.map((entry) => [entry.toolCallId, entry]));
}

test("edit 成功记一条；失败或仍在执行不算写入", () => {
  assert.deepEqual(
    extractWrittenPathsFromToolCall("edit", { path: "/repo/a.ts" }, toolResult("c1")),
    ["/repo/a.ts"],
  );
  assert.deepEqual(
    extractWrittenPathsFromToolCall("edit", { path: "/repo/a.ts" }, toolResult("c1", { isError: true })),
    [],
    "失败的工具调用不应算写入",
  );
  assert.deepEqual(
    extractWrittenPathsFromToolCall("edit", { path: "/repo/a.ts" }, undefined),
    [],
    "仍在执行（没有结果）不应算写入",
  );
  assert.deepEqual(
    extractWrittenPathsFromToolCall("bash", { command: "echo x > a.ts" }, toolResult("c1")),
    [],
    "非写入类工具恒空",
  );
});

test("write 的 file_path 兼容键；缺路径时空", () => {
  assert.deepEqual(extractWrittenPathsFromToolCall("write", { file_path: "/repo/b.ts" }, toolResult("c1")), ["/repo/b.ts"]);
  assert.deepEqual(extractWrittenPathsFromToolCall("write", {}, toolResult("c1")), []);
});

test("apply_patch：优先 appliedFiles，失败且无 appliedFiles 视为没写成，删除的不算", () => {
  const ok = toolResult("c1", {
    details: { result: { appliedFiles: ["/repo/a.ts", "/repo/renamed.ts"] } },
  });
  assert.deepEqual(extractWrittenPathsFromToolCall("apply_patch", {}, ok), ["/repo/a.ts", "/repo/renamed.ts"]);

  const failed = toolResult("c1", { details: { result: { failures: [{ filePath: "/repo/a.ts", message: "mismatch" }] } } });
  assert.deepEqual(extractWrittenPathsFromToolCall("apply_patch", {}, failed), []);

  const deleted = toolResult("c1", {
    details: {
      result: { appliedFiles: ["/repo/gone.ts", "/repo/kept.ts"] },
      preview: { files: [{ operation: "delete", filePath: "/repo/gone.ts" }] },
    },
  });
  assert.deepEqual(
    extractWrittenPathsFromToolCall("apply_patch", {}, deleted),
    ["/repo/kept.ts"],
    "被删除的文件不算本轮写入",
  );

  const v4aDelete = toolResult("c1", { details: { result: { appliedFiles: ["/repo/old.ts", "/repo/new.ts"] } } });
  const input = { input: "*** Begin Patch\n*** Delete File: /repo/old.ts\n*** End Patch" };
  assert.deepEqual(extractWrittenPathsFromToolCall("apply_patch", input, v4aDelete), ["/repo/new.ts"]);
});

test("apply_patch 退到 preview / 补丁文档", () => {
  const previewOnly = toolResult("c1", {
    details: {
      preview: { files: [{ operation: "update", filePath: "/repo/from-preview.ts", diff: "- 1 old\n+ 1 new" }] },
    },
  });
  assert.deepEqual(extractWrittenPathsFromToolCall("apply_patch", {}, previewOnly), ["/repo/from-preview.ts"]);

  const docOnly = toolResult("c1", { details: {} });
  const input = { input: "*** Begin Patch\n*** Add File: /repo/from-doc.ts\n+x\n*** End Patch" };
  assert.deepEqual(extractWrittenPathsFromToolCall("apply_patch", input, docOnly), ["/repo/from-doc.ts"]);
});

test("相对路径按 cwd 拼接，绝对路径原样", () => {
  assert.equal(resolveWrittenFilePath("/repo/a.ts", CWD), "/repo/a.ts");
  assert.equal(resolveWrittenFilePath("src/a.ts", CWD), "/repo/src/a.ts");
  assert.equal(resolveWrittenFilePath("./src/a.ts", CWD), "/repo/src/a.ts");
  // POSIX 下反斜杠是合法文件名字符，file-paths 的归一故意不做全局替换 ——
  // 只有 Windows 盘符/UNC 形式会被改写（下一条），相对路径原样拼接。
  assert.equal(resolveWrittenFilePath("src\\a.ts", CWD), "/repo/src\\a.ts");
  assert.equal(resolveWrittenFilePath("C:\\repo\\a.ts", CWD), "C:/repo/a.ts");
  assert.equal(resolveWrittenFilePath("", CWD), "");
});

test("本轮汇总：跨多个 assistant step 聚合、按出现顺序去重、不跨轮", () => {
  const messages = [
    user("上一轮"),
    assistant([toolCall("c0", "edit", { path: "/repo/previous.ts" })]),
    toolResult("c0"),
    user("这一轮"),
    assistant([toolCall("c1", "edit", { path: "/repo/a.ts" })]),
    toolResult("c1"),
    assistant([toolCall("c2", "write", { path: "/repo/a.ts" }), toolCall("c3", "edit", { path: "/repo/b.ts" })]),
    toolResult("c2"),
    toolResult("c3"),
    assistant([], "改完了"),
  ];

  const files = collectTurnWrittenFiles({
    messages,
    index: 9,
    toolResults: resultsOf([
      { toolCallId: "c0", isError: false },
      { toolCallId: "c1", isError: false },
      { toolCallId: "c2", isError: false },
      { toolCallId: "c3", isError: false },
    ]),
    cwd: CWD,
  });

  assert.deepEqual(files.map((f) => f.filePath), ["/repo/a.ts", "/repo/b.ts"], "去重保留首次出现顺序，且不含上一轮");
});

test("本轮汇总：流式消息接在末尾，工具仍在执行时不列", () => {
  const messages = [
    user("这一轮"),
    assistant([toolCall("c1", "edit", { path: "/repo/a.ts" })]),
    toolResult("c1"),
  ];
  const live = assistant([toolCall("c2", "write", { path: "/repo/b.ts" })]);

  const withPending = collectTurnWrittenFiles({
    messages,
    index: null,
    liveMessage: live,
    toolResults: resultsOf([{ toolCallId: "c1", isError: false }]), // c2 尚无结果
    cwd: CWD,
  });
  assert.deepEqual(withPending.map((f) => f.filePath), ["/repo/a.ts"]);

  const withResult = collectTurnWrittenFiles({
    messages,
    index: null,
    liveMessage: live,
    toolResults: resultsOf([
      { toolCallId: "c1", isError: false },
      { toolCallId: "c2", isError: false },
    ]),
    cwd: CWD,
  });
  assert.deepEqual(withResult.map((f) => f.filePath), ["/repo/a.ts", "/repo/b.ts"]);
});

test("收尾消息判定：同一轮里只有最后一条 assistant 为真", () => {
  const messages = [
    user("u1"),
    assistant([toolCall("c1", "edit", { path: "/repo/a.ts" })]),
    toolResult("c1"),
    assistant([], "收尾"),
    user("u2"),
    assistant([], "下一轮"),
  ];
  assert.equal(isTurnFinalAssistantMessage(messages, 1), false);
  assert.equal(isTurnFinalAssistantMessage(messages, 3), true);
  assert.equal(isTurnFinalAssistantMessage(messages, 5), true);
  assert.equal(isTurnFinalAssistantMessage(messages, 0), false, "user 消息不是收尾 assistant");
});
