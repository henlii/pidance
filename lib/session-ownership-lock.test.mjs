import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { tryAcquireSessionLock } = await jiti.import("./session-ownership-lock.ts");

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
