import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("普通会话与空值（新会话）全部能力开放", async () => {
  const { getSessionCapabilities } = await jiti.import("./session-capabilities.ts");
  for (const session of [undefined, null, {}, { readOnly: undefined }]) {
    const caps = getSessionCapabilities(session);
    assert.equal(caps.readOnly, false);
    assert.equal(caps.canPrompt, true);
    assert.equal(caps.canFork, true);
    assert.equal(caps.canCompact, true);
    assert.equal(caps.canChangeModel, true);
    assert.equal(caps.canChangeThinking, true);
    assert.equal(caps.canChangeTools, true);
    assert.equal(caps.canRename, true);
    assert.equal(caps.canAutoName, true);
    assert.equal(caps.canDelete, true);
    assert.equal(caps.canConnectEvents, true);
    assert.equal(caps.canSendSessionCommands, true);
  }
});

test("readOnly 会话全部写/连接能力关闭", async () => {
  const { getSessionCapabilities } = await jiti.import("./session-capabilities.ts");
  const caps = getSessionCapabilities({ readOnly: true });
  assert.equal(caps.readOnly, true);
  assert.equal(caps.canPrompt, false);
  assert.equal(caps.canFork, false);
  assert.equal(caps.canCompact, false);
  assert.equal(caps.canChangeModel, false);
  assert.equal(caps.canChangeThinking, false);
  assert.equal(caps.canChangeTools, false);
  assert.equal(caps.canRename, false);
  assert.equal(caps.canAutoName, false);
  assert.equal(caps.canDelete, false);
  assert.equal(caps.canConnectEvents, false);
  assert.equal(caps.canSendSessionCommands, false);
});

test("canArchiveSession：普通可归档；running 或只读 subagent 禁用", async () => {
  const { canArchiveSession } = await jiti.import("./session-capabilities.ts");
  assert.equal(canArchiveSession(undefined, false), true);
  assert.equal(canArchiveSession({}, false), true);
  assert.equal(canArchiveSession({ readOnly: undefined }, false), true);
  // running 会话不可归档（后端 409）。
  assert.equal(canArchiveSession({}, true), false);
  assert.equal(canArchiveSession(undefined, true), false);
  // 只读 subagent 会话不可归档（后端 403）。
  assert.equal(canArchiveSession({ readOnly: true }, false), false);
  assert.equal(canArchiveSession({ readOnly: true }, true), false);
});
