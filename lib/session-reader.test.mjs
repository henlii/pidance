import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildSessionContext,
  cacheSessionPath,
  invalidateSessionPathCache,
  readSessionHeader,
  resolveSessionIdByPath,
  markExistingSubagentRelation,
  buildSessionNavigationSnapshot,
} = await jiti.import("./session-reader.ts");

test("已由 SessionManager 枚举的 child 被标记为只读 relation", () => {
  const session = { id: "child", path: "/tmp/child.jsonl", cwd: "/tmp", created: "", modified: "", messageCount: 0, firstMessage: "" };
  const result = markExistingSubagentRelation(session, {
    path: session.path,
    header: { type: "session", id: "child", timestamp: "", cwd: "/tmp" },
    parentSessionId: "parent",
    runId: "12345678",
    runIndex: 3,
  });
  assert.equal(result, session);
  assert.equal(result.readOnly, true);
  assert.deepEqual(result.subagent, { parentSessionId: "parent", runId: "12345678", runIndex: 3 });
});

function userEntry(id, parentId, content, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "user",
      content,
    },
  };
}

function assistantEntry(id, parentId, text, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: [{ type: "text", text }],
    },
  };
}

test("compaction 不截断：完整链正常显示（含压缩前旧消息）", () => {
  const entries = [
    userEntry("u1", null, "old user request"),
    assistantEntry("a1", "u1", "old assistant answer"),
    userEntry("u2", "a1", "kept user request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary",
      firstKeptEntryId: "u2",
      tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u1", "a1", "u2", "cmp", "u3"]);
  assert.deepEqual(
    context.messages.map((message) => [message.role, message.customType, message.content]),
    [
      ["user", undefined, "old user request"],
      ["assistant", undefined, [{ text: "old assistant answer", type: "text" }]],
      ["user", undefined, "kept user request"],
      ["custom", "compaction", "old exchange summary"],
      ["user", undefined, "after compaction"],
    ],
  );
});

test("完整链包含所有 compaction（无截断）", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "first kept request"),
    {
      type: "compaction",
      id: "cmp1",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "first summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    assistantEntry("a2", "cmp1", "second kept answer"),
    userEntry("u3", "a2", "second kept request"),
    {
      type: "compaction",
      id: "cmp2",
      parentId: "u3",
      timestamp: "2026-01-01T00:00:06.000Z",
      summary: "latest summary",
      firstKeptEntryId: "a2",
      tokensBefore: 200,
    },
    assistantEntry("a3", "cmp2", "latest answer"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u1", "a1", "u2", "cmp1", "a2", "u3", "cmp2", "a3"]);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].content, "old request");
  assert.equal(context.messages.length, context.entryIds.length);
});

test("uses the selected leaf's path before a later compaction", () => {
  const entries = [
    userEntry("u1", null, "root request"),
    assistantEntry("a1", "u1", "root answer"),
    userEntry("u2", "a1", "main branch"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "main branch summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    userEntry("alt", "a1", "alternate branch"),
  ];

  const context = buildSessionContext(entries, "alt");

  assert.deepEqual(context.entryIds, ["u1", "a1", "alt"]);
  assert.equal(context.messages.some((message) => message.role === "custom"), false);
});

test("returns an empty context for a null leaf", () => {
  const context = buildSessionContext([
    userEntry("u1", null, "not active"),
  ], null);

  assert.deepEqual(context.messages, []);
  assert.deepEqual(context.entryIds, []);
});

test("defers historical thinking without changing live-session content", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "large reasoning" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(deferred.messages[1].content[0], {
    type: "thinking",
    thinking: "",
    deferred: true,
  });

  const full = buildSessionContext(entries);
  assert.equal(full.messages[1].content[0].thinking, "large reasoning");
});

test("does not defer empty historical thinking blocks", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const context = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(context.messages[1].content[0], { type: "thinking", thinking: "" });
});

test("defers only base64 images from historical tool results", () => {
  const userImage = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const toolImage = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "QUJDRA==" },
  };
  const toolUrlImage = {
    type: "image",
    source: { type: "url", url: "https://example.com/result.png" },
  };
  const flatToolImage = {
    type: "image",
    data: "QUJDRA==",
    mimeType: "image/png",
  };
  const entries = [
    userEntry("u1", null, [{ type: "text", text: "inspect this" }, userImage]),
    assistantEntry("a1", "u1", "reading"),
    {
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        content: [
          { type: "text", text: "Read image file" },
          toolImage,
          flatToolImage,
          toolUrlImage,
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferToolResultImages: true });
  assert.deepEqual(deferred.messages[0].content[1], userImage);
  assert.deepEqual(deferred.messages[2].content[0], { type: "text", text: "Read image file" });
  assert.deepEqual(deferred.messages[2].content[1], toolUrlImage);
  assert.match(deferred.messages[2].content[2].text, /2 tool result images omitted.*image\/jpeg, image\/png.*~8 bytes/);

  const full = buildSessionContext(entries);
  assert.deepEqual(full.messages[2].content[1], toolImage);
  assert.deepEqual(full.messages[2].content[2], flatToolImage);
  assert.deepEqual(full.messages[2].content[3], toolUrlImage);
});

test("defers heavy toolResult.details (diff/patch/diffData) when deferMedia", () => {
  const bigDiff = "x".repeat(5000);
  const entries = [
    userEntry("u1", null, "edit me"),
    assistantEntry("a1", "u1", "editing"),
    {
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-edit",
        toolName: "edit",
        content: [{ type: "text", text: "Edited file" }],
        details: {
          diff: bigDiff,
          patch: bigDiff,
          diffData: { hunks: bigDiff },
          firstChangedLine: 12,
          note: "keep-me",
        },
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferToolResultImages: true });
  const tr = deferred.messages[2];
  assert.equal(tr.role, "toolResult");
  assert.equal(tr.details.deferredHeavy, true);
  assert.equal(tr.details.firstChangedLine, 12);
  assert.equal(tr.details.note, "keep-me");
  assert.equal(tr.details.diff, undefined);
  assert.equal(tr.details.patch, undefined);
  assert.equal(tr.details.diffData, undefined);

  const full = buildSessionContext(entries);
  assert.equal(full.messages[2].details.diff, bigDiff);
  assert.equal(full.messages[2].details.deferredHeavy, undefined);
});

test("deferMedia 不剥离 todo tasks / subagent results 等非白名单 details", () => {
  const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, content: `task-${i}`, status: "pending" }));
  const entries = [
    userEntry("u1", null, "plan"),
    assistantEntry("a1", "u1", "todo"),
    {
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-todo",
        toolName: "todo",
        content: [{ type: "text", text: "ok" }],
        details: {
          tasks,
          results: [{ sessionFile: "/tmp/x.jsonl" }],
          diff: "x".repeat(1000),
        },
      },
    },
  ];
  const deferred = buildSessionContext(entries, undefined, { deferToolResultImages: true });
  const tr = deferred.messages[2];
  assert.equal(tr.details.deferredHeavy, true);
  assert.deepEqual(tr.details.tasks, tasks);
  assert.deepEqual(tr.details.results, [{ sessionFile: "/tmp/x.jsonl" }]);
  assert.equal(tr.details.diff, undefined);
});

test("preserves hidden custom messages so the UI can render them collapsed", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "custom_message",
      id: "c1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "extension_debug",
      content: "hidden extension payload",
      display: false,
      details: { source: "test" },
    },
    assistantEntry("a1", "c1", "done"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u1", "c1", "a1"]);
  assert.equal(context.messages[1].role, "custom");
  assert.equal(context.messages[1].customType, "extension_debug");
  assert.equal(context.messages[1].display, false);
  assert.equal(context.messages[1].content, "hidden extension payload");
});

test("preserves valid epoch timestamps on synthetic UI messages", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u1",
      timestamp: "1970-01-01T00:00:00.000Z",
      summary: "epoch summary",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    },
  ];

  const context = buildSessionContext(entries);

  // 完整链：user 消息在前，compaction 摘要随后（不截断）。
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].content, "start");
  assert.equal(context.messages[1].role, "custom");
  assert.equal(context.messages[1].customType, "compaction");
  assert.equal(context.messages[1].timestamp, 0);
});

test("reads only a bounded session header, including headers larger than 4 KiB", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-"));
  const filePath = join(dir, "session.jsonl");
  const parentSession = `/tmp/${"p".repeat(5_000)}.jsonl`;
  writeFileSync(filePath, `${JSON.stringify({
    type: "session",
    version: 3,
    id: "session",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    parentSession,
  })}\n${JSON.stringify(userEntry("u1", null, "message"))}\n`);

  try {
    assert.equal(readSessionHeader(filePath)?.parentSession, parentSession);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null for malformed or unbounded session headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-invalid-"));
  const malformedPath = join(dir, "malformed.jsonl");
  const oversizedPath = join(dir, "oversized.jsonl");
  writeFileSync(malformedPath, "{not-json}\n");
  writeFileSync(oversizedPath, "x".repeat(64 * 1024));

  try {
    assert.equal(readSessionHeader(malformedPath), null);
    assert.equal(readSessionHeader(oversizedPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps forward and reverse session path caches in sync", async () => {
  const sessionId = "cache-test-session";
  const filePath = join(tmpdir(), "pi-web-cache-test", "..", "cache-test", "session.jsonl");

  cacheSessionPath(sessionId, filePath);
  try {
    assert.equal(
      await resolveSessionIdByPath(filePath),
      sessionId,
    );
  } finally {
    invalidateSessionPathCache(sessionId);
  }

  assert.equal(globalThis.__piSessionPathCache?.has(sessionId), false);
  assert.equal(globalThis.__piPathToSessionIdCache?.has(normalize(filePath)), false);
});

test("branch_summary 映射为 role=custom / customType=branch_summary，不再伪装 user", () => {
  const entries = [
    userEntry("u1", null, "root"),
    assistantEntry("a1", "u1", "answer"),
    {
      type: "branch_summary",
      id: "bs1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:05.000Z",
      fromId: "old-leaf",
      summary: "abandoned branch notes",
      details: { readFiles: ["a.ts"] },
      usage: { input: 10, output: 2 },
      fromHook: true,
    },
    userEntry("u2", "bs1", "continue"),
  ];

  const context = buildSessionContext(entries);
  const summaryMsg = context.messages.find((m) => m.customType === "branch_summary");
  assert.ok(summaryMsg);
  assert.equal(summaryMsg.role, "custom");
  assert.equal(summaryMsg.customType, "branch_summary");
  assert.equal(summaryMsg.content, "abandoned branch notes");
  assert.equal(summaryMsg.display, true);
  assert.equal(summaryMsg.timestamp, Date.parse("2026-01-01T00:00:05.000Z"));
  assert.deepEqual(summaryMsg.details, {
    fromId: "old-leaf",
    details: { readFiles: ["a.ts"] },
    usage: { input: 10, output: 2 },
    fromHook: true,
  });
  // 不得伪装成 user
  assert.equal(
    context.messages.some((m) => m.role === "user" && String(m.content).includes("explored another branch")),
    false,
  );
});

test("空 summary 的 branch_summary 不进入消息列表", () => {
  const entries = [
    userEntry("u1", null, "root"),
    {
      type: "branch_summary",
      id: "bs-empty",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      fromId: "x",
      summary: "",
    },
  ];
  const context = buildSessionContext(entries);
  assert.equal(context.messages.some((m) => m.customType === "branch_summary"), false);
  assert.deepEqual(context.entryIds, ["u1"]);
});

test("压缩前旧消息正常显示（完整链，不截断）", () => {
  const entries = [
    userEntry("u1", null, "old user request"),
    assistantEntry("a1", "u1", "old assistant answer"),
    userEntry("u2", "a1", "kept user request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary",
      firstKeptEntryId: "u2",
      tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ];

  const full = buildSessionContext(entries);
  assert.deepEqual(full.entryIds, ["u1", "a1", "u2", "cmp", "u3"]);
  assert.deepEqual(
    full.messages.map((m) => [m.role, m.content]),
    [
      ["user", "old user request"],
      ["assistant", [{ text: "old assistant answer", type: "text" }]],
      ["user", "kept user request"],
      ["custom", "old exchange summary"],
      ["user", "after compaction"],
    ],
  );
});

test("pidance.command 条目投影为命令消息（非法 data 安全跳过）", () => {
  const entries = [
    userEntry("u1", null, "hello"),
    {
      type: "custom",
      id: "cmd1",
      parentId: "u1",
      customType: "pidance.command",
      data: { version: 1, command: "/compact", ok: true, result: "Compacted context" },
      timestamp: "2026-01-01T00:00:04.000Z",
    },
    {
      type: "custom",
      id: "bad1",
      parentId: "cmd1",
      customType: "pidance.command",
      data: { version: 999, command: "/oops" },
      timestamp: "2026-01-01T00:00:05.000Z",
    },
  ];
  const context = buildSessionContext(entries);
  const commandMessages = context.messages.filter((m) => m.role === "custom" && m.customType === "pidance.command");
  assert.equal(commandMessages.length, 1);
  assert.equal(commandMessages[0].content, "/compact");
  assert.deepEqual(commandMessages[0].details, { ok: true, result: "Compacted context" });
});
