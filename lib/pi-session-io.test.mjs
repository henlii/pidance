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
  hasSdkFileSurface,
  reparentSessionFile,
  SDK_SESSION_FILE_SURFACE_MISSING,
} = await jiti.import("./pi-session-io.ts");
const {
  writeLeafSidecar,
  readLeafSidecar,
  clearLeafSidecar,
  leafSidecarPath,
} = await jiti.import("./session-leaf-sidecar.ts");

test("createSessionManager 默认不落盘；materialize 后写出 header", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-io-"));
  try {
    const sm = createSessionManager("/tmp/proj", dir);
    const file = sm.getSessionFile();
    assert.ok(file);
    assert.equal(existsSync(file), false, "新建空会话不应出现在磁盘/侧栏");
    materializeSessionFile(sm);
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
    materializeSessionFile(sm);
    const file = sm.getSessionFile();
    const a = sm.appendMessage({ role: "user", content: "a", timestamp: Date.now() });
    materializeSessionFile(sm);
    const b = sm.appendMessage({ role: "user", content: "b", timestamp: Date.now() });
    materializeSessionFile(sm);
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
    materializeSessionFile(sm);
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
    materializeSessionFile(sm);
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
    materializeSessionFile(sm);
    writeLeafSidecar(file, "nonexistent-id");
    const reopened = openSessionManager(file);
    assert.ok(reopened.getLeafId());
    assert.equal(readLeafSidecar(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ---------------------------------------------------------------------------
// Issue #36：Pi SDK 私有写入入口的适配层
//
// 已核实 SDK（dist/core/session-manager.d.ts）没有公开的「立即落盘」入口：
// - isPersisted() 返回「启用了持久化」，不是「已写盘」（实测无 assistant 时
//   文件不存在而 isPersisted() 为 true）；
// - _persist() 在无 assistant 时不建文件；
// - 公开方法里没有 flush / materialize / save。
// 因此只能走 _rewriteFile() 与 flushed。要求：集中一处，缺失时明确失败。
// ---------------------------------------------------------------------------

test("#36 SDK 仍提供写入入口：hasSdkFileSurface 为真", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-io-surface-"));
  try {
    const sm = createSessionManager("/tmp/proj", dir);
    assert.equal(hasSdkFileSurface(sm), true, "当前 SDK 基线必须提供 _rewriteFile");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#36 isPersisted() 不等于已写盘（该语义是适配层存在的理由）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-io-persist-"));
  try {
    const sm = createSessionManager("/tmp/proj", dir);
    const file = sm.getSessionFile();
    // 记录 SDK 语义：启用持久化 ≠ 文件存在。若将来 SDK 改为已写盘，
    // materialize 的「无 assistant 也要存在」仍成立，但这条断言会失败并提醒更新。
    assert.equal(sm.isPersisted(), true, "create() 默认启用持久化");
    assert.equal(existsSync(file), false, "延迟落盘：此时文件不应存在");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#36 入口缺失时明确失败，不静默跳过", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-io-missing-"));
  try {
    const sm = createSessionManager("/tmp/proj", dir);
    // 模拟 SDK 升级后私有成员消失（_rewriteFile 是原型方法，需在原型上遮蔽）
    const proto = Object.getPrototypeOf(sm);
    const original = Object.getOwnPropertyDescriptor(proto, "_rewriteFile");
    proto._rewriteFile = undefined;
    try {
      assert.equal(hasSdkFileSurface(sm), false);
      assert.throws(() => materializeSessionFile(sm), (error) => {
        assert.match(error.message, /_rewriteFile/);
        assert.equal(error.message, SDK_SESSION_FILE_SURFACE_MISSING);
        return true;
      }, "缺失必须是显式错误（旧实现用 ?. 静默跳过）");
    } finally {
      if (original) Object.defineProperty(proto, "_rewriteFile", original);
      else delete proto._rewriteFile;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#36 reparentSessionFile 实际改写 parentSession（行为，不靠成员名）", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-io-reparent-"));
  try {
    const parent = createSessionManager("/tmp/proj", dir);
    materializeSessionFile(parent);
    const child = createSessionManager("/tmp/proj", dir);
    materializeSessionFile(child);
    const childFile = child.getSessionFile();
    const parentFile = parent.getSessionFile();

    reparentSessionFile(childFile, parentFile);
    assert.equal(openSessionManager(childFile).getHeader()?.parentSession, parentFile);

    reparentSessionFile(childFile, undefined);
    assert.equal(openSessionManager(childFile).getHeader()?.parentSession, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
