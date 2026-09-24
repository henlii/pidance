import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  resolveSessionPath,
  markExistingSubagentRelation,
  buildSessionNavigationSnapshot,
  computeParentRunTreeStamp,
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

test("无 model_change 时从最后一条 assistant 推断 context.model", () => {
  const context = buildSessionContext([
    userEntry("u1", null, "hello"),
    assistantEntry("a1", "u1", "hi"),
  ]);
  assert.deepEqual(context.model, { provider: "test", modelId: "test-model", id: "test-model" });
});

test("model_change 优先于 assistant 推断", () => {
  const context = buildSessionContext([
    {
      type: "model_change",
      id: "mc",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      provider: "zenmux",
      modelId: "claude-a",
    },
    userEntry("u1", "mc", "hello"),
    assistantEntry("a1", "u1", "hi"),
  ]);
  assert.deepEqual(context.model, { provider: "zenmux", modelId: "claude-a", id: "claude-a" });
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

test("stripMetadataNodes：超长链迭代处理不栈溢出，label 提升语义不变", async () => {
  const { stripMetadataNodes } = await jiti.import("./session-reader.ts");
  // 构造 20000 层线性链（递归版必然 Maximum call stack）
  let node = { entry: { id: "leaf", type: "message" }, children: [] };
  for (let i = 0; i < 20000; i++) {
    node = { entry: { id: `n${i}`, type: "message" }, children: [node] };
  }
  const result = stripMetadataNodes([node]);
  // 链不变（无 label）：根节点保留，深度逐层展开不抛错
  assert.equal(result.length, 1);
  let depth = 0;
  let cur = result[0];
  while (cur.children.length > 0) { cur = cur.children[0]; depth++; }
  assert.equal(depth, 20000);
  assert.equal(cur.entry.id, "leaf");

  // label 提升语义：label 节点被提升（子节点挂到父位置）
  const labelTree = [
    {
      entry: { id: "root", type: "message" },
      children: [
        { entry: { id: "label1", type: "label" }, children: [
          { entry: { id: "a", type: "message" }, children: [] },
          { entry: { id: "b", type: "message" }, children: [] },
        ] },
        { entry: { id: "c", type: "message" }, children: [] },
      ],
    },
  ];
  const hoisted = stripMetadataNodes(labelTree);
  assert.deepEqual(hoisted[0].children.map((c) => c.entry.id), ["a", "b", "c"]);
});

test("path cache 命中后若文件已不存在则自愈", async () => {
  const sessionId = `missing-cache-heal-${Date.now()}`;
  const missing = join(tmpdir(), "pidance-missing-path", `${sessionId}.jsonl`);
  cacheSessionPath(sessionId, missing);
  try {
    assert.equal(await resolveSessionPath(sessionId), null);
    assert.equal(globalThis.__piSessionPathCache?.has(sessionId), false);
  } finally {
    invalidateSessionPathCache(sessionId);
  }
});

test("父 jsonl 不变时，已有 run 目录内新建/删除 session 会改树戳", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-run-stamp-"));
  const parent = join(dir, "parent.jsonl");
  writeFileSync(parent, "{\"type\":\"session\"}\n");
  const runRoot = join(dir, "parent");
  const hex = join(runRoot, "aaaaaaaa");
  const run0 = join(hex, "run-0");
  mkdirSync(run0, { recursive: true });
  const before = computeParentRunTreeStamp(parent);
  writeFileSync(join(run0, "session.jsonl"), "{\"type\":\"session\"}\n");
  const created = computeParentRunTreeStamp(parent);
  assert.notEqual(created, before, "新建 session.jsonl 必须让树戳变化");
  rmSync(join(run0, "session.jsonl"));
  const deleted = computeParentRunTreeStamp(parent);
  assert.notEqual(deleted, created, "删除 session.jsonl 必须让树戳变化");
  rmSync(dir, { recursive: true, force: true });
});

test("列表：linked checkout 的会话 projectRoot 等于 cwd，不折回主仓也不返回 worktreeBranch", async () => {
  const { listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
  const base = mkdtempSync(join(tmpdir(), "pidance-sessions-wt-"));
  const agentDir = join(base, "agent");
  const repo = join(base, "repo");
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const git = (cwd, args) => execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  try {
    // 真实 linked checkout：主仓 + git worktree add 出来的旁路目录（同一个 git common dir）
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "x");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "init"]);
    const worktreePath = join(realpathSync(base), "repo-worktrees", "feat");
    git(repo, ["worktree", "add", "-b", "feat", worktreePath]);
    assert.equal(realpathSync(worktreePath), worktreePath, "临时目录不应是符号链接，路径可直接比较");
    const repoRoot = realpathSync(repo);

    const sessionRoot = join(agentDir, "sessions");
    for (const [dir, id, cwd] of [["main-dir", "main-session", repoRoot], ["wt-dir", "wt-session", worktreePath]]) {
      mkdirSync(join(sessionRoot, dir), { recursive: true });
      writeFileSync(
        join(sessionRoot, dir, `${id}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`,
      );
    }

    invalidateSessionListCache();
    const sessions = await listAllSessions();
    const main = sessions.find((s) => s.id === "main-session");
    const worktree = sessions.find((s) => s.id === "wt-session");
    assert.ok(main && worktree, "两个会话都应被发现");
    // 两个不同目录 = 两个项目：旁路 checkout 不折回主仓
    assert.equal(main.projectRoot, main.cwd);
    assert.equal(worktree.cwd, worktreePath);
    assert.equal(worktree.projectRoot, worktreePath);
    assert.notEqual(worktree.projectRoot, main.projectRoot);
    // 字段确实不再返回
    assert.equal("worktreeBranch" in worktree, false);
    assert.equal("worktreeBranch" in main, false);
  } finally {
    invalidateSessionListCache();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(base, { recursive: true, force: true });
  }
});

// ── 会话路径有界定位 + 目录 allowStale ─────────────────────────────────────
// 深链首次打开、重启、多标签冷启动本来要等全目录扫描（自述 2-7s）。

const METADATA_CACHE_FILE = "pidance-session-cache.json";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeTimedSessionFile(sessionRoot, projectDir, id, cwd = "/tmp/project") {
  const dir = join(sessionRoot, projectDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n`);
  return path;
}

async function withTempAgentDir(run) {
  const base = mkdtempSync(join(tmpdir(), "pidance-path-lookup-"));
  const agentDir = join(base, "agent");
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await run({ base, agentDir, sessionRoot: join(agentDir, "sessions") });
  } finally {
    const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
    invalidateSessionListCache();
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(base, { recursive: true, force: true });
  }
}

test("resolveSessionPath：深链首次解析走有界定位，不触发全目录扫描", async () => {
  const { resolveSessionPath, invalidateSessionPathCache, listAllSessions } = await jiti.import("./session-reader.ts");
  await withTempAgentDir(async ({ agentDir, sessionRoot }) => {
    const expected = writeTimedSessionFile(sessionRoot, "proj", "deep-link-session");
    invalidateSessionPathCache("deep-link-session");

    assert.equal(await resolveSessionPath("deep-link-session"), expected);

    // 全目录扫描会写元数据缓存（防抖 1.5s）：等过防抖，文件仍不该出现
    const cacheFile = join(agentDir, METADATA_CACHE_FILE);
    await sleep(1700);
    assert.equal(existsSync(cacheFile), false, "有界定位不应触发目录扫描");

    // 对照组：真的跑一次目录扫描必定写缓存（证明上面的探针有效）
    await listAllSessions();
    await sleep(1700);
    assert.equal(existsSync(cacheFile), true, "目录扫描确实会写元数据缓存");
  });
});

test("resolveSessionPath：文件名不匹配的会话仍能靠目录扫描兜底", async () => {
  const { resolveSessionPath, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");
  await withTempAgentDir(async ({ sessionRoot }) => {
    // 文件名不带 _<id> 后缀：有界定位找不到，必须回退目录扫描
    const dir = join(sessionRoot, "odd");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "weird-name.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "odd-named", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project" })}\n`);
    invalidateSessionPathCache("odd-named");
    assert.equal(await resolveSessionPath("odd-named"), path);
  });
});

test("resolveSessionIdByPath：sessions 根内的路径直接由 header 解析", async () => {
  const { resolveSessionIdByPath } = await jiti.import("./session-reader.ts");
  await withTempAgentDir(async ({ base, sessionRoot }) => {
    const path = writeTimedSessionFile(sessionRoot, "proj", "by-path-session");
    assert.equal(await resolveSessionIdByPath(path), "by-path-session");
    // 根外路径不得被当作会话（越界一律返回 undefined）
    assert.equal(await resolveSessionIdByPath(join(base, "outside.jsonl")), undefined);
  });
});

test("resolveSessionManagerForRead：无 live 时读路径接入只读视图缓存", async () => {
  const { resolveSessionManagerForRead } = await jiti.import("./session-reader.ts");
  const { sessionReadCacheStats, invalidateSessionReadCache } = await jiti.import("./session-read-manager-cache.ts");
  await withTempAgentDir(async ({ sessionRoot }) => {
    const path = writeTimedSessionFile(sessionRoot, "proj", "read-view-session");
    invalidateSessionReadCache();

    const first = resolveSessionManagerForRead({ filePath: path });
    assert.equal(first.getHeader()?.id, "read-view-session");
    // 每次调用返回的是新的包装对象（identity 不能比），但底层视图必须进缓存：
    // 缓存命中语义由 session-read-manager-cache.test.mjs 覆盖。
    assert.equal(sessionReadCacheStats().entries, 1, "读路径应把解析结果放进共享缓存");

    invalidateSessionReadCache();
    const second = resolveSessionManagerForRead({ filePath: path });
    assert.equal(second.getEntries().length, first.getEntries().length);
    assert.equal(sessionReadCacheStats().entries, 1, "清掉后读路径会重新填充缓存");
  });
});

test("listAllSessions({ allowStale })：旧目录立刻可用，普通调用仍重建", async () => {
  const { listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
  await withTempAgentDir(async ({ sessionRoot }) => {
    writeTimedSessionFile(sessionRoot, "proj", "session-one");
    invalidateSessionListCache();
    assert.equal((await listAllSessions()).length, 1);

    // 新增第二个会话 + 失效（agent 活动就会走到这里）
    writeTimedSessionFile(sessionRoot, "proj", "session-two");
    invalidateSessionListCache();

    const stale = await listAllSessions({ allowStale: true });
    assert.equal(stale.length, 1, "stale 读者先用上一轮目录，不做同步重建");

    const fresh = await listAllSessions();
    assert.equal(fresh.length, 2, "普通调用必须重建");
  });
});
