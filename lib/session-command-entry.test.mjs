import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeCommandEntryData, parseCommandEntryData, findCommandEntry, PIDANCE_COMMAND_CUSTOM_TYPE } =
  await jiti.import("./session-command-entry.ts");

test("normalizeCommandEntryData：trim + 默认 ok/version", () => {
  const d = normalizeCommandEntryData({ command: "  /compact  " });
  assert.equal(d.command, "/compact");
  assert.equal(d.ok, true);
  assert.equal(d.version, 1);
  assert.equal(d.result, undefined);

  const withResult = normalizeCommandEntryData({ command: "/name 会话", ok: true, result: "  Session renamed  " });
  assert.equal(withResult.result, "Session renamed");
});

test("parseCommandEntryData：非法 version/data 安全跳过", () => {
  assert.equal(parseCommandEntryData(null), null);
  assert.equal(parseCommandEntryData({ version: 999, command: "/x" }), null);
  assert.equal(parseCommandEntryData({ version: 1, command: "   " }), null);
  assert.equal(parseCommandEntryData({ version: 1, command: "/ok" })?.command, "/ok");
});

test("findCommandEntry：从 entries 查命令条目", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hi" } },
    {
      type: "custom",
      id: "cmd1",
      parentId: "u1",
      customType: PIDANCE_COMMAND_CUSTOM_TYPE,
      data: { version: 1, command: "/compact", ok: true },
      timestamp: "2026-01-01T00:00:00.000Z",
    },
  ];
  assert.equal(findCommandEntry(entries, "cmd1")?.command, "/compact");
  assert.equal(findCommandEntry(entries, "u1"), null);
});
