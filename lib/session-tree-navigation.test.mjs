/**
 * 树导航的判定与落地（issue #90）。
 *
 * 为什么要这个文件：同一条命令有两条落地路径（Host 的 live writer / Service 的离线写），
 * 判定必须一致，否则同一命令在两条路径上给出不同结果。这里固定判定本身（noop / 清 sidecar /
 * branch）、assistant 轮末解析、sidecar 落地，以及 **liveWriter 模式不交接、不取租约**。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync as writeFile } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const {
  applyTreeNavigation,
  planBranchFromAssistant,
  planSelectLeafExact,
} = await jiti.import("./session-tree-navigation.ts");
const { createSessionService } = await jiti.import("./session-service.ts");
const { readLeafSidecar } = await jiti.import("./session-leaf-sidecar.ts");
const { asDiskSessionView, openSessionManager } = await jiti.import("./pi-session-io.ts");

const HEADER = { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp" };

/** 最小会话 fixture：user → assistant → toolResult → user（turnEnd 可验证）。 */
function writeFixture(file) {
  writeFile(
    file,
    [
      JSON.stringify(HEADER),
      JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "q1" } }),
      JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
      JSON.stringify({ type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", content: [] } }),
      JSON.stringify({ type: "message", id: "u2", parentId: "t1", message: { role: "user", content: "q2" } }),
    ].join("\n"),
  );
}

async function withFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "tree-nav-"));
  const file = join(dir, "session.jsonl");
  writeFixture(file);
  try {
    return await run({ dir, file });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("planSelectLeafExact：目标 = 当前 leaf 时 noop，tai 时清 sidecar，其余写 sidecar", async () => {
    withFixture(({ file }) => {
    const view = asDiskSessionView(openSessionManager(file));
    assert.equal(view.getLeafId(), "u2", "无 sidecar 时 leaf = 文件末尾");
    assert.deepEqual(planSelectLeafExact(view, "u2"), { kind: "noop" }, "目标就是当前 leaf：无变化");
    assert.deepEqual(planSelectLeafExact(view, "a1"), { kind: "branch", leafId: "a1", clearSidecar: false });
    view.branch("a1");
    assert.deepEqual(planSelectLeafExact(view, "u2"), { kind: "branch", leafId: "u2", clearSidecar: true }, "回到末尾：清掉过期 sidecar");
    assert.throws(() => planSelectLeafExact(view, "nope"), /Entry nope not found/);
  });
});

test("planBranchFromAssistant：解析到轮末，末尾时清 sidecar；非 assistant 拒绝", async () => {
    withFixture(({ file }) => {
    const view = asDiskSessionView(openSessionManager(file));
    assert.deepEqual(
      planBranchFromAssistant(view, "a1"),
      { kind: "branch", leafId: "t1", clearSidecar: false },
      "轮末 = 下一条 user 之前的最后一条 entry",
    );
    assert.throws(() => planBranchFromAssistant(view, "u1"), /Only assistant messages can be branched from/);
    assert.throws(() => planBranchFromAssistant(view, "nope"), /Entry not found/);
  });
  // 轮末就是文件末尾（这里没有后续 user）：sidecar 必须是「清」而不是写 —— 写了会让
  // 下次开盘把默认 leaf 固化成冗余指针。
  const dir = mkdtempSync(join(tmpdir(), "tree-nav-tail-"));
  const file = join(dir, "session.jsonl");
  try {
    writeFile(
      file,
      [
        JSON.stringify(HEADER),
        JSON.stringify({ type: "message", id: "u1", parentId: null, message: { role: "user", content: "q1" } }),
        JSON.stringify({ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
        JSON.stringify({ type: "message", id: "t1", parentId: "a1", message: { role: "toolResult", toolCallId: "c1", content: [] } }),
      ].join("\n"),
    );
    const view = asDiskSessionView(openSessionManager(file));
    assert.deepEqual(planBranchFromAssistant(view, "a1"), { kind: "branch", leafId: "t1", clearSidecar: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyTreeNavigation：branch 落 sidecar，clearSidecar 删掉它，noop 不写任何东西", async () => {
    withFixture(({ file }) => {
    const view = asDiskSessionView(openSessionManager(file));
    applyTreeNavigation({ sessionManager: view, sessionFile: file, plan: { kind: "noop" } });
    assert.equal(readLeafSidecar(file), null, "noop 不得写 sidecar");
    applyTreeNavigation({
      sessionManager: view,
      sessionFile: file,
      plan: { kind: "branch", leafId: "a1", clearSidecar: false },
    });
    assert.equal(readLeafSidecar(file), "a1");
    assert.equal(view.getLeafId(), "a1", "内存 leaf 同步改掉（live writer 才看得到）");
    applyTreeNavigation({
      sessionManager: view,
      sessionFile: file,
      plan: { kind: "branch", leafId: "u2", clearSidecar: true },
    });
    assert.equal(readLeafSidecar(file), null, "回到末尾：sidecar 必须清掉，否则重启弹回旧分支");
  });
});

test("applyTreeNavigation：sidecar 写失败时内存 leaf 必须原样不动（不留内存/磁盘分裂）", async () => {
  withFixture(({ dir, file }) => {
    const view = asDiskSessionView(openSessionManager(file));
    assert.equal(view.getLeafId(), "u2");
    // 让 sidecar 写失败：把它的父目录位置占成一个普通文件（dirname(exists) 为真 → 写入 ENOTDIR）。
    const blocked = join(dir, "blocked");
    writeFile(blocked, "not a directory");
    assert.throws(
      () =>
        applyTreeNavigation({
          sessionManager: view,
          sessionFile: join(blocked, "session.jsonl"),
          plan: { kind: "branch", leafId: "a1", clearSidecar: false },
        }),
      /ENOTDIR|not a directory/i,
      "sidecar 写失败必须抛给调用方",
    );
    assert.equal(view.getLeafId(), "u2", "写失败时内存 leaf 不得被改（先写盘再改内存）");
  });
});

test("Service liveWriter 模式：用 Host 的 writer 写，不交接、不取离线租约（#90）", async () => {
  withFixture(async ({ file }) => {
        const view = asDiskSessionView(openSessionManager(file));
    let handoffs = 0;
    let opens = 0;
    const service = createSessionService({
      getRpcSession: () => ({ isAlive: () => true, inner: { isBashRunning: false } }),
      resolveSessionPath: async () => file,
      openSessionView: () => {
        opens += 1;
        throw new Error("live 模式不得再开磁盘视图");
      },
      invalidateSessionListCache: () => {},
    });
    const result = await service.selectLeafExact("s1", "a1", {
      handoff: async () => {
        handoffs += 1;
      },
      liveWriter: { sessionManager: view, sessionFile: file },
    });
    assert.deepEqual(result, { cancelled: false });
    assert.equal(handoffs, 0, "live 模式不得交接 writer");
    assert.equal(opens, 0, "live 模式不得再开磁盘视图（否则同进程两个 writer）");
    assert.equal(readLeafSidecar(file), "a1");
  });
});

test("Service 离线模式仍然交接并开磁盘视图（无 liveWriter 时的既有契约）", async () => {
  withFixture(async ({ file }) => {
    const order = [];
    const service = createSessionService({
      getRpcSession: () => undefined,
      resolveSessionPath: async () => file,
      listAllSessions: async () => [],
      invalidateSessionListCache: () => {},
    });
    const result = await service.selectLeafExact("s1", "a1", {
      handoff: async () => {
        order.push("handoff");
      },
    });
    assert.deepEqual(result, { cancelled: false });
    assert.deepEqual(order, ["handoff"]);
    assert.equal(readLeafSidecar(file), "a1");
  });
});
