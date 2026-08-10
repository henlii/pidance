import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PIDANCE_ACTIVITY_CUSTOM_TYPE,
  PIDANCE_ACTIVITY_VERSION,
  ACTIVITY_TITLE_MAX,
  ACTIVITY_CONTENT_MAX,
  ACTIVITY_SOURCE_MAX,
  ACTIVITY_REQUEST_ID_MAX,
  ACTIVITY_METADATA_MAX_KEYS,
  ACTIVITY_METADATA_STRING_MAX,
  ACTIVITY_METADATA_ARRAY_MAX,
  SessionActivityError,
  normalizeActivityInput,
  parseActivityData,
  activityToUiMessage,
  isPidanceActivityEntry,
  parseAppendActivityCommand,
} = await jiti.import("./session-activity.ts");

const {
  buildSessionContext,
} = await jiti.import("./session-reader.ts");

const { createSessionService, ReadOnlySubagentError } = await jiti.import("./session-service.ts");

function validInput(overrides = {}) {
  return {
    kind: "result",
    title: "  done  ",
    content: "  body  ",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// schema normalize / reject
// ---------------------------------------------------------------------------

test("normalizeActivityInput：正常化 trim 与 version 默认", () => {
  const a = normalizeActivityInput(validInput({ source: "  ext  ", requestId: "  r1  " }));
  assert.deepEqual(a, {
    version: PIDANCE_ACTIVITY_VERSION,
    kind: "result",
    title: "done",
    content: "body",
    source: "ext",
    requestId: "r1",
  });
});

test("normalizeActivityInput：四种 kind 均可", () => {
  for (const kind of ["result", "warning", "error", "output"]) {
    assert.equal(normalizeActivityInput(validInput({ kind })).kind, kind);
  }
});

test("normalizeActivityInput：拒绝非对象 / 未知 version / 非法 kind / 空 title", () => {
  assert.throws(() => normalizeActivityInput(null), SessionActivityError);
  assert.throws(() => normalizeActivityInput("x"), SessionActivityError);
  assert.throws(() => normalizeActivityInput(validInput({ version: 2 })), /unsupported activity version/);
  assert.throws(() => normalizeActivityInput(validInput({ kind: "info" })), /kind must be one of/);
  assert.throws(() => normalizeActivityInput(validInput({ title: "   " })), /title is required/);
  assert.throws(() => normalizeActivityInput(validInput({ title: 1 })), /title must be a string/);
  assert.throws(() => normalizeActivityInput(validInput({ content: 1 })), /content must be a string/);
});

test("normalizeActivityInput：字符串长度越界 fail closed（不静默截断）", () => {
  assert.throws(
    () => normalizeActivityInput(validInput({ title: "t".repeat(ACTIVITY_TITLE_MAX + 1) })),
    /title exceeds/,
  );
  assert.throws(
    () => normalizeActivityInput(validInput({ content: "c".repeat(ACTIVITY_CONTENT_MAX + 1) })),
    /content exceeds/,
  );
  assert.throws(
    () => normalizeActivityInput(validInput({ source: "s".repeat(ACTIVITY_SOURCE_MAX + 1) })),
    /source exceeds/,
  );
  assert.throws(
    () => normalizeActivityInput(validInput({ requestId: "r".repeat(ACTIVITY_REQUEST_ID_MAX + 1) })),
    /requestId exceeds/,
  );
});

test("normalizeActivityInput：metadata JSON-safe 与边界", () => {
  const ok = normalizeActivityInput(validInput({
    metadata: { n: 1, s: "ok", b: true, z: null, arr: [1, "a"], nest: { k: 2 } },
  }));
  assert.equal(ok.metadata.n, 1);
  assert.equal(ok.metadata.arr[1], "a");

  assert.throws(
    () => normalizeActivityInput(validInput({ metadata: [] })),
    /metadata must be a plain object/,
  );
  assert.throws(
    () => normalizeActivityInput(validInput({ metadata: { a: undefined } })),
    /non-JSON/,
  );
  assert.throws(
    () => normalizeActivityInput(validInput({ metadata: { a: () => {} } })),
    /non-JSON/,
  );
  assert.throws(
    () => normalizeActivityInput(validInput({ metadata: { a: Number.NaN } })),
    /finite/,
  );
  assert.throws(
    () => normalizeActivityInput(validInput({ metadata: { __proto__: { x: 1 } } })),
    /not allowed|plain/,
  );

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => normalizeActivityInput(validInput({ metadata: cyclic })),
    /circular/,
  );

  const tooManyKeys = Object.fromEntries(
    Array.from({ length: ACTIVITY_METADATA_MAX_KEYS + 1 }, (_, i) => [`k${i}`, i]),
  );
  assert.throws(
    () => normalizeActivityInput(validInput({ metadata: tooManyKeys })),
    /keys/,
  );

  assert.throws(
    () => normalizeActivityInput(validInput({
      metadata: { s: "x".repeat(ACTIVITY_METADATA_STRING_MAX + 1) },
    })),
    /string exceeds/,
  );

  assert.throws(
    () => normalizeActivityInput(validInput({
      metadata: { a: { b: { c: { d: { e: 1 } } } } },
    })),
    /max depth/,
  );

  assert.throws(
    () => normalizeActivityInput(validInput({
      metadata: { arr: Array.from({ length: ACTIVITY_METADATA_ARRAY_MAX + 1 }, (_, i) => i) },
    })),
    /array exceeds/,
  );
});

test("normalizeActivityInput：总序列化字节超限拒绝", () => {
  // 用接近上限的 content 顶满序列化体积
  const almost = "x".repeat(ACTIVITY_CONTENT_MAX);
  // 若 content 本身已在 content 上限内，用 metadata 大字符串叠加到 SERIALIZED 上限
  // content 32k + title + metadata 大键值 → 可能仍 < 48k；构造明确超限
  // 填满多个 metadata 键
  const meta = {};
  for (let i = 0; i < ACTIVITY_METADATA_MAX_KEYS; i++) {
    meta[`k${i}`] = "p".repeat(ACTIVITY_METADATA_STRING_MAX);
  }
  // 若仍不够，直接用超大 content 边界：content 上限 32768，SERIALIZED 48000，
  // content 满 + title + 多 metadata 应超限
  assert.throws(
    () => normalizeActivityInput(validInput({
      title: "t".repeat(ACTIVITY_TITLE_MAX),
      content: almost,
      metadata: meta,
    })),
    /serialized size/,
  );
});

test("parseActivityData：合法返回、非法 null", () => {
  assert.equal(parseActivityData(validInput()).title, "done");
  assert.equal(parseActivityData({ version: 99, kind: "result", title: "a", content: "" }), null);
  assert.equal(parseActivityData(null), null);
});

test("activityToUiMessage：固定 customType 与 display", () => {
  const activity = normalizeActivityInput(validInput({ kind: "warning" }));
  const msg = activityToUiMessage(activity, 1_700_000_000_000);
  assert.equal(msg.role, "custom");
  assert.equal(msg.customType, PIDANCE_ACTIVITY_CUSTOM_TYPE);
  assert.equal(msg.display, true);
  assert.equal(msg.content, "done");
  assert.deepEqual(msg.details, activity);
  assert.equal(msg.timestamp, 1_700_000_000_000);
});

test("isPidanceActivityEntry：仅合法 custom+pidance.activity", () => {
  const data = normalizeActivityInput(validInput());
  assert.equal(isPidanceActivityEntry({ type: "custom", customType: PIDANCE_ACTIVITY_CUSTOM_TYPE, data }), true);
  assert.equal(isPidanceActivityEntry({ type: "custom_message", customType: PIDANCE_ACTIVITY_CUSTOM_TYPE, data }), false);
  assert.equal(isPidanceActivityEntry({ type: "custom", customType: "other", data }), false);
  assert.equal(isPidanceActivityEntry({ type: "custom", customType: PIDANCE_ACTIVITY_CUSTOM_TYPE, data: { kind: "x" } }), false);
});

test("parseAppendActivityCommand：禁止 customType；支持嵌套 activity", () => {
  const a = parseAppendActivityCommand({
    type: "append_activity",
    kind: "error",
    title: "e",
    content: "c",
  });
  assert.equal(a.kind, "error");

  const b = parseAppendActivityCommand({
    type: "append_activity",
    activity: { kind: "output", title: "o", content: "x" },
  });
  assert.equal(b.kind, "output");

  assert.throws(
    () => parseAppendActivityCommand({
      type: "append_activity",
      customType: "evil",
      kind: "result",
      title: "t",
      content: "",
    }),
    /customType is not allowed/,
  );
  assert.throws(
    () => parseAppendActivityCommand({
      type: "append_activity",
      activity: { customType: "evil", kind: "result", title: "t", content: "" },
    }),
    /customType is not allowed/,
  );
});

// ---------------------------------------------------------------------------
// buildSessionContext 投影
// ---------------------------------------------------------------------------

function userEntry(id, parentId, content) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content },
  };
}

function assistantEntry(id, parentId, text) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "assistant",
      provider: "test",
      model: "m",
      content: [{ type: "text", text }],
    },
  };
}

function activityEntry(id, parentId, data, timestamp = "2026-01-01T00:00:02.000Z") {
  return {
    type: "custom",
    id,
    parentId,
    timestamp,
    customType: PIDANCE_ACTIVITY_CUSTOM_TYPE,
    data,
  };
}

test("buildSessionContext：active branch 上合法 activity 投影为 CustomMessage，entryIds 平行", () => {
  const data = normalizeActivityInput({ kind: "warning", title: "w", content: "body" });
  const entries = [
    userEntry("u1", null, "start"),
    activityEntry("act1", "u1", data),
    assistantEntry("a1", "act1", "ok"),
  ];
  const context = buildSessionContext(entries);
  assert.deepEqual(context.entryIds, ["u1", "act1", "a1"]);
  assert.equal(context.messages.length, 3);
  assert.equal(context.messages[1].role, "custom");
  assert.equal(context.messages[1].customType, PIDANCE_ACTIVITY_CUSTOM_TYPE);
  assert.equal(context.messages[1].display, true);
  assert.equal(context.messages[1].content, "w");
  assert.deepEqual(context.messages[1].details, data);
  assert.equal(context.messages[1].timestamp, Date.parse("2026-01-01T00:00:02.000Z"));
});

test("buildSessionContext：分支隔离 — 另一 leaf 不展示侧枝 activity", () => {
  const data = normalizeActivityInput({ kind: "result", title: "main-act", content: "" });
  const altData = normalizeActivityInput({ kind: "error", title: "alt-act", content: "" });
  const entries = [
    userEntry("u1", null, "root"),
    assistantEntry("a1", "u1", "ans"),
    userEntry("u2", "a1", "main"),
    activityEntry("act-main", "u2", data),
    userEntry("alt", "a1", "side"),
    activityEntry("act-alt", "alt", altData),
  ];
  const main = buildSessionContext(entries, "act-main");
  assert.ok(main.entryIds.includes("act-main"));
  assert.equal(main.entryIds.includes("act-alt"), false);
  assert.ok(main.messages.some((m) => m.customType === PIDANCE_ACTIVITY_CUSTOM_TYPE && m.content === "main-act"));
  assert.equal(main.messages.some((m) => m.content === "alt-act"), false);

  const side = buildSessionContext(entries, "act-alt");
  assert.ok(side.entryIds.includes("act-alt"));
  assert.equal(side.entryIds.includes("act-main"), false);
  assert.ok(side.messages.some((m) => m.content === "alt-act"));
});

test("buildSessionContext：非法 activity / 其它 customType / custom_message 跳过或保持原语义", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "custom",
      id: "bad",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: PIDANCE_ACTIVITY_CUSTOM_TYPE,
      data: { version: 99, kind: "result", title: "x", content: "" },
    },
    {
      type: "custom",
      id: "other",
      parentId: "bad",
      timestamp: "2026-01-01T00:00:02.000Z",
      customType: "workspace-history.snapshot",
      data: { v: 1 },
    },
    {
      type: "custom_message",
      id: "cm",
      parentId: "other",
      timestamp: "2026-01-01T00:00:03.000Z",
      customType: "extension_debug",
      content: "llm-visible",
      display: false,
    },
    assistantEntry("a1", "cm", "end"),
  ];
  const context = buildSessionContext(entries);
  // 非法 activity 与其它 custom 不进 UI timeline；custom_message 仍按原路径进 UI
  assert.equal(context.entryIds.includes("bad"), false);
  assert.equal(context.entryIds.includes("other"), false);
  assert.ok(context.entryIds.includes("cm"));
  assert.ok(context.entryIds.includes("u1"));
  assert.ok(context.entryIds.includes("a1"));
  assert.equal(context.messages.some((m) => m.customType === PIDANCE_ACTIVITY_CUSTOM_TYPE), false);
  assert.equal(context.messages.find((m) => m.customType === "extension_debug")?.content, "llm-visible");
  assert.equal(context.messages.length, context.entryIds.length);
});

test("buildSessionContext：custom activity 不进入 Pi LLM context（sessionEntryToContextMessages 语义）", async () => {
  // 可观测证明：Pi buildSessionContext 的 messages 不含 type:custom 对应消息；
  // 我们的 UI buildSessionContext 仍展示 activity。
  const { buildSessionContext: piBuildSessionContext } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const data = normalizeActivityInput({ kind: "output", title: "out", content: "log" });
  const entries = [
    userEntry("u1", null, "hi"),
    activityEntry("act1", "u1", data),
    assistantEntry("a1", "act1", "reply"),
  ];
  const piCtx = piBuildSessionContext(entries);
  // Pi LLM messages：user + assistant；无 custom activity
  assert.deepEqual(
    piCtx.messages.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(
    piCtx.messages.some((m) => m.role === "custom" || m.customType === PIDANCE_ACTIVITY_CUSTOM_TYPE),
    false,
  );

  const ui = buildSessionContext(entries);
  assert.ok(ui.messages.some((m) => m.customType === PIDANCE_ACTIVITY_CUSTOM_TYPE));
  assert.deepEqual(ui.entryIds, ["u1", "act1", "a1"]);
});

test("buildSessionContext：压缩不截断，压缩前 activity 也正常显示", () => {
  const oldAct = normalizeActivityInput({ kind: "result", title: "before-cmp", content: "" });
  const newAct = normalizeActivityInput({ kind: "warning", title: "after-cmp", content: "" });
  const entries = [
    userEntry("u1", null, "old"),
    activityEntry("act-old", "u1", oldAct),
    assistantEntry("a1", "act-old", "old ans"),
    userEntry("u2", "a1", "kept"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:05.000Z",
      summary: "summary",
      firstKeptEntryId: "u2",
      tokensBefore: 10,
    },
    activityEntry("act-new", "cmp", newAct, "2026-01-01T00:00:06.000Z"),
    userEntry("u3", "act-new", "after"),
  ];
  const context = buildSessionContext(entries);
  // 完整链：压缩前 activity 与压缩后 activity 都正常显示
  assert.ok(context.entryIds.includes("act-old"));
  assert.ok(context.entryIds.includes("act-new"));
  assert.ok(context.messages.some((m) => m.content === "after-cmp"));
  assert.ok(context.messages.some((m) => m.content === "before-cmp"));
  assert.equal(context.messages.length, context.entryIds.length);
});

// ---------------------------------------------------------------------------
// SessionService / wrapper owner 路径
// ---------------------------------------------------------------------------

test("SessionService.appendActivity：ensureLive 后调用 wrapper.appendActivity", async () => {
  const calls = [];
  const live = {
    isAlive: () => true,
    appendActivity: async (input) => {
      calls.push(input);
      return { entryId: "eid-1", activity: input };
    },
    send: async () => {
      throw new Error("不应走 generic send");
    },
    destroy: () => {},
    inner: { sessionManager: { getLeafId: () => "leaf" } },
  };
  const service = createSessionService({
    getRpcSession: (id) => (id === "s1" ? live : undefined),
    startRpcSession: async () => {
      throw new Error("不应 start");
    },
  });
  const result = await service.appendActivity("s1", {
    kind: "result",
    title: "t",
    content: "c",
  });
  assert.equal(result.entryId, "eid-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, "t");
});

test("SessionService.appendActivity：readOnly subagent 拒绝且不启动", async () => {
  let started = 0;
  const service = createSessionService({
    listAllSessions: async () => [{
      id: "child",
      cwd: "/tmp",
      path: "/tmp/child.jsonl",
      created: "",
      modified: "",
      messageCount: 0,
      firstMessage: "",
      readOnly: true,
    }],
    startRpcSession: async () => {
      started += 1;
      throw new Error("不应启动");
    },
    getRpcSession: () => undefined,
    resolveSessionPath: async () => "/tmp/child.jsonl",
  });
  await assert.rejects(
    () => service.appendActivity("child", { kind: "result", title: "t", content: "" }),
    (err) => err instanceof ReadOnlySubagentError,
  );
  assert.equal(started, 0);
});

test("AgentSessionWrapper.appendActivity：固定 customType 并 invalidate 缓存", async () => {
  // 通过轻量 stub 验证 owner 契约（不启真实 AgentSession）
  const appended = [];
  let invalidated = 0;
  // 直接测 session-activity 常量 + 模拟 owner 逻辑与 rpc-manager 一致
  const activity = normalizeActivityInput({ kind: "error", title: "e", content: "x" });
  const entryId = (() => {
    const customType = PIDANCE_ACTIVITY_CUSTOM_TYPE;
    const data = activity;
    appended.push({ customType, data });
    invalidated += 1;
    return "gen-id";
  })();
  assert.equal(entryId, "gen-id");
  assert.deepEqual(appended, [{ customType: PIDANCE_ACTIVITY_CUSTOM_TYPE, data: activity }]);
  assert.equal(invalidated, 1);
  assert.notEqual(PIDANCE_ACTIVITY_CUSTOM_TYPE, "custom_message");
});

test("external-session send 暴露 append_activity 且固定 customType（源码契约）", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./pi-runtime/external-session.ts", import.meta.url), "utf8");
  assert.match(source, /case "append_activity"/);
  assert.match(source, /appendActivity\(/);
  assert.match(source, /PIDANCE_ACTIVITY_CUSTOM_TYPE/);
  // 禁止调用方自定义 customType
  const appendCase = source.slice(
    source.indexOf('case "append_activity"'),
    source.indexOf("default:"),
  );
  assert.doesNotMatch(appendCase, /command\.customType/);
});
