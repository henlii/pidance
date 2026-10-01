import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { waitForPidanceReady, runPidanceUpgrade } = await jiti.import("./pidance-update-client.ts");

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

test("runPidanceUpgrade：重启把 SSE 切断时不报失败，按实际版本判定", async () => {
  const original = globalThis.fetch;
  // 模拟真实情况：apply 流在 installing 阶段被服务重启切断（浏览器抛 Error in input stream）
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/update/apply")) {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"type":"progress","phase":"installing","percent":50,"message":"安装中"}\n\n',
          ));
          controller.error(new TypeError("Error in input stream"));
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return jsonResponse(200, { version: "0.2.9" });
  };
  try {
    const phases = [];
    const result = await runPidanceUpgrade("0.2.9", (event) => phases.push(event.phase), {
      // 重启后的就绪探测：模拟新进程起来、版本已是目标版本
      wait: async ({ expectedVersion }) => expectedVersion === "0.2.9",
    });
    assert.equal(result.ok, true, "流被切断不该判失败（实际已升级）");
    assert.equal(result.status, "upgraded");
    assert.equal(result.targetVersion, "0.2.9");
    assert.ok(phases.includes("waiting"), "应进入等待服务就绪阶段");
  } finally {
    globalThis.fetch = original;
  }
});

test("runPidanceUpgrade：流切断但服务始终没到目标版本 → 仍报失败", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/update/apply")) {
      return new Response(new ReadableStream({
        start(controller) { controller.error(new TypeError("Error in input stream")); },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    return jsonResponse(200, { version: "0.2.8" });
  };
  try {
    const result = await runPidanceUpgrade("0.2.9", () => {}, {
      wait: async () => false, // 等待就绪始终失败
    });
    assert.equal(result.ok, false, "没到目标版本就该报失败");
  } finally {
    globalThis.fetch = original;
  }
});
