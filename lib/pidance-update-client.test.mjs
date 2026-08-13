import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { waitForPidanceReady } = await jiti.import("./pidance-update-client.ts");

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("waitForPidanceReady：版本对上即就绪", async () => {
  const ok = await waitForPidanceReady({
    expectedVersion: "0.2.3",
    timeoutMs: 5_000,
    intervalMs: 1,
    sleepImpl: async () => undefined,
    fetchImpl: async () => jsonResponse(200, { version: "0.2.3" }),
  });
  assert.equal(ok, true);
});

test("waitForPidanceReady：401 视为进程已起来", async () => {
  const ok = await waitForPidanceReady({
    expectedVersion: "0.2.3",
    timeoutMs: 5_000,
    intervalMs: 1,
    sleepImpl: async () => undefined,
    fetchImpl: async () => new Response("auth", { status: 401 }),
  });
  assert.equal(ok, true);
});

test("waitForPidanceReady：先失败再成功", async () => {
  let n = 0;
  const ok = await waitForPidanceReady({
    expectedVersion: "0.2.3",
    timeoutMs: 5_000,
    intervalMs: 1,
    sleepImpl: async () => undefined,
    fetchImpl: async () => {
      n += 1;
      if (n < 3) throw new Error("ECONNREFUSED");
      return jsonResponse(200, { version: "0.2.3" });
    },
  });
  assert.equal(ok, true);
  assert.ok(n >= 3);
});

test("waitForPidanceReady：超时返回 false", async () => {
  let now = 0;
  const ok = await waitForPidanceReady({
    expectedVersion: "0.2.3",
    timeoutMs: 10,
    intervalMs: 5,
    now: () => now,
    sleepImpl: async () => {
      now += 5;
    },
    fetchImpl: async () => {
      throw new Error("down");
    },
  });
  assert.equal(ok, false);
});
