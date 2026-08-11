/**
 * Pi SessionManager 磁盘封装回归（替代已删 SessionFile 测试的核心行为）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createSessionManager,
  openSessionManager,
  openSessionView,
  materializeSessionFile,
} = await jiti.import("./pi-session-io.ts");
const {
  writeLeafSidecar,
  readLeafSidecar,
  clearLeafSidecar,
  leafSidecarPath,
} = await jiti.import("./session-leaf-sidecar.ts");

test("createSessionManager 立即落盘 header", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-io-"));
  try {
    const sm = createSessionManager("/tmp/proj", dir);
    const file = sm.getSessionFile();
    assert.ok(file);
    assert.ok(existsSync(file));
    const header = JSON.parse(readFileSync(file, "utf8").trim().split("\n")[0]);
    assert.equal(header.type, "session");
    assert.equal(header.version, 3);
    assert.equal(header.cwd, "/tmp/proj");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openSessionManager 应用 leaf sidecar", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-io-leaf-"));
  try {
    const sm = createSessionManager("/tmp/proj", dir);
    const file = sm.getSessionFile();
    const a = sm.appendMessage({ role: "user", content: "a", timestamp: Date.now() });
    // 强制写出（user message 也需落盘供 reopen）
    materializeSessionFile(sm);
    // 再写一条再 materialize 不够；有 assistant 才自然 flush。用 _rewriteFile
    sm._rewriteFile();
    const b = sm.appendMessage({ role: "user", content: "b", timestamp: Date.now() });
    sm._rewriteFile();
    writeLeafSidecar(file, a);
    const reopened = openSessionManager(file);
    assert.equal(reopened.getLeafId(), a);
    clearLeafSidecar(file);
    assert.ok(!existsSync(leafSidecarPath(file)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openSessionView branch / createBranchedSession / appendCustomEntry", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-io-br-"));
  try {
    const sm = createSessionManager("/tmp/proj", dir);
    const file = sm.getSessionFile();
    const a = sm.appendMessage({ role: "user", content: "a", timestamp: Date.now() });
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      timestamp: Date.now(),
    });
    const b = sm.appendMessage({ role: "user", content: "b", timestamp: Date.now() });
    sm._rewriteFile();
    const view = openSessionView(file);
    view.branch(a);
    assert.equal(view.getLeafId(), a);
    const customId = view.appendCustomEntry("pidance.activity", {
      kind: "result",
      title: "t",
      content: "c",
      version: 1,
    });
    assert.ok(customId);
    sm._rewriteFile();
    const mgr = openSessionManager(file);
    const branched = mgr.createBranchedSession(a);
    // createBranchedSession 会把 manager 切到新会话；无 assistant 时需 materialize
    materializeSessionFile(mgr);
    assert.ok(branched && existsSync(branched), `branched=${branched}`);
    const child = openSessionView(branched);
    assert.ok(child.getSessionId());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("损坏 sidecar 安全忽略", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-io-bad-"));
  try {
    const sm = createSessionManager("/tmp/proj", dir);
    const file = sm.getSessionFile();
    sm.appendMessage({ role: "user", content: "x", timestamp: Date.now() });
    sm._rewriteFile();
    writeLeafSidecar(file, "nonexistent-id");
    const reopened = openSessionManager(file);
    assert.ok(reopened.getLeafId());
    assert.equal(readLeafSidecar(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
