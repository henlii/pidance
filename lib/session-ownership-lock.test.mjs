import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  tryAcquireSessionLock,
  tryAcquireSessionOwnership,
  releaseUnwantedLockKeys,
  findForeignSessionLockPid,
  isSessionLockedError,
  SESSION_LOCKED_MESSAGE,
} = await jiti.import("./session-ownership-lock.ts");

test("tryAcquireSessionLock：同 key 互斥，释放后可再取", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-lock-"));
  try {
    const a = tryAcquireSessionLock("session-a", dir);
    assert.ok(a);
    assert.equal(tryAcquireSessionLock("session-a", dir), null);
    assert.ok(tryAcquireSessionLock("session-b", dir));
    a.release();
    const again = tryAcquireSessionLock("session-a", dir);
    assert.ok(again);
    again.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryAcquireSessionOwnership：id+file 同时持有，缺一不可插入", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-lock-both-"));
  try {
    const held = tryAcquireSessionOwnership(["sid-1", "/tmp/s.jsonl"], dir);
    assert.ok(held);
    assert.deepEqual(held.keys, ["sid-1", "/tmp/s.jsonl"]);
    assert.equal(tryAcquireSessionLock("sid-1", dir), null);
    assert.equal(tryAcquireSessionLock("/tmp/s.jsonl", dir), null);
    assert.equal(tryAcquireSessionOwnership(["sid-1", "/tmp/s.jsonl"], dir), null);
    held.release();
    const again = tryAcquireSessionOwnership(["sid-1", "/tmp/s.jsonl"], dir);
    assert.ok(again);
    again.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryAcquireSessionOwnership：换钥时先抢新钥匙，旧钥匙在成功前仍占用", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-lock-rekey-"));
  try {
    const fileKey = "/tmp/new.jsonl";
    const temp = tryAcquireSessionLock("__new__1", dir);
    assert.ok(temp);
    const expanded = tryAcquireSessionOwnership(["real-id", fileKey], dir, temp);
    assert.ok(expanded);
    // 新钥匙已占用，另一进程插不进
    assert.equal(tryAcquireSessionLock("real-id", dir), null);
    assert.equal(tryAcquireSessionLock(fileKey, dir), null);
    // 旧 temp 钥匙在释放前仍占用
    assert.equal(tryAcquireSessionLock("__new__1", dir), null);
    releaseUnwantedLockKeys(temp, ["real-id", fileKey]);
    const tempAgain = tryAcquireSessionLock("__new__1", dir);
    assert.ok(tempAgain, "换钥成功后才释放 temp 钥匙");
    tempAgain.release();
    expanded.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tryAcquireSessionOwnership：第二把钥匙失败时回滚第一把，且不释放 held", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-lock-rollback-"));
  try {
    const blocker = tryAcquireSessionLock("file-b", dir);
    assert.ok(blocker);
    const held = tryAcquireSessionLock("temp-a", dir);
    assert.ok(held);
    assert.equal(tryAcquireSessionOwnership(["id-a", "file-b"], dir, held), null);
    const tempStill = tryAcquireSessionLock("temp-a", dir);
    assert.equal(tempStill, null, "失败不得释放 held");
    const idStillFree = tryAcquireSessionLock("id-a", dir);
    assert.ok(idStillFree, "失败的新钥匙必须回滚");
    idStillFree.release();
    held.release();
    blocker.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isSessionLockedError 识别所有权锁文案", () => {
  assert.equal(isSessionLockedError(new Error(SESSION_LOCKED_MESSAGE)), true);
  assert.equal(isSessionLockedError("other"), false);
});

test("findForeignSessionLockPid：本进程锁不算占用，外进程 pid 算占用", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-lock-inspect-"));
  try {
    assert.equal(findForeignSessionLockPid(["sid-x"], dir), null);
    const ours = tryAcquireSessionLock("sid-x", dir);
    assert.ok(ours);
    assert.equal(findForeignSessionLockPid(["sid-x"], dir), null);
    ours.release();
    const lockDir = join(dir, "pidance-session-locks");
    writeFileSync(join(lockDir, "sid-y.lock"), JSON.stringify({ pid: 1, sessionKey: "sid-y" }));
    assert.equal(findForeignSessionLockPid(["sid-y"], dir), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
