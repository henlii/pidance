/**
 * #27（A4 的浏览器侧）：发送失败必须把服务端的 locked 409 映射成 **locked 文案**，
 * 而不是通用「发送失败」。
 *
 * 场景：B 端的 `lockedByOther` 还没刷新（1s 轮询/SSE 未到）时用户就发送 —— 服务端会以
 * `SESSION_RUNNING_LOCKED_MESSAGE` 返回 409。这条链路上有三段，任何一段断掉用户都会看到
 * 一个没有解释的通用错误：
 *   1. 服务端 409 body.error = `SESSION_RUNNING_LOCKED_MESSAGE`（外部契约，不改）；
 *   2. 客户端把它作为**错误消息**从 runtime registry 传出来（不能被吞成 accepted）；
 *   3. UI 用**同一个归类器**判定 locked 并显示 locked 文案。
 *
 * 第 3 段原先在 hook 里用本地子串 `error.includes("locked by another")` 判断 —— 那是同一概念
 * 的第二种写法，会漏掉同类措辞（`running lease`）。本文件既测归类器契约，也用源码门禁钉住
 * 「只有一种写法」。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { classifyPromptRejection } = await jiti.import("./agent-commands.ts");
const { SESSION_RUNNING_LOCKED_MESSAGE } = await jiti.import("./session-running-lease.ts");
const { createBrowserSessionRuntimeRegistry } = await jiti.import("./browser-session-runtime-registry.ts");

const ROOT = new URL("../", import.meta.url).pathname;
const HOOK = "hooks/useAgentSession.ts";

test("#27 浏览器侧：服务端 409 的 locked 消息归类为 locked，其它错误仍是 error", () => {
  // 服务端契约文案（wire 上就是这句）→ 必须 locked
  assert.equal(classifyPromptRejection(new Error(SESSION_RUNNING_LOCKED_MESSAGE)), "locked");
  // 同类措辞（租约相关的其它表达）也不能漏
  assert.equal(classifyPromptRejection(new Error("running lease held by another process")), "locked");
  assert.equal(classifyPromptRejection(new Error("session is owned by another process")), "locked");
  // 其它错误不得被当成 locked（否则会给用户看错误的解释）
  assert.equal(classifyPromptRejection(new Error("ECONNRESET")), "error");
  assert.equal(classifyPromptRejection(new Error("Invalid prompt receipt")), "error");
  assert.equal(classifyPromptRejection(undefined), "error");
  assert.equal(classifyPromptRejection(""), "error");
});

test("#27 浏览器侧：runtime 把对端锁定当作**失败**传出（不吞成 accepted），并带上服务端消息", async () => {
  const registry = createBrowserSessionRuntimeRegistry({
    async postPrompt() {
      // 服务端 409 → agent-client 抛出的就是 body.error
      throw new Error(SESSION_RUNNING_LOCKED_MESSAGE);
    },
    createEventStream: () => ({
      connect: async () => ({ status: "connected", source: { close() {}, readyState: 1, onmessage: null, onerror: null } }),
      ensureConnected: async () => {},
      close() {},
      getCurrentSource: () => null,
      isCurrent: () => true,
    }),
    restoreDraft() {},
  });
  const receipt = await registry.submitPrompt({
    target: { kind: "persisted", sessionId: "locked-session" },
    submissionId: "sub-27-locked",
    message: "hello",
    draftKey: "locked-session",
  });
  assert.notEqual(receipt.status, "accepted", "对端锁定绝不能结算成 accepted（否则用户以为发出去了）");
  assert.equal(receipt.status, "unknown");
  assert.ok(
    typeof receipt.error === "string" && receipt.error.includes("locked by another Pidance process"),
    `回执必须带上服务端原文，UI 才能归类成 locked；实际 error=${JSON.stringify(receipt.error)}`,
  );
  assert.equal(classifyPromptRejection(receipt.error), "locked", "回执错误必须能被归类为 locked");
});

test("#27 浏览器侧门禁：locked 判定只有一种写法（不得再出现本地子串判断）", async () => {
  const src = await readFile(join(ROOT, HOOK), "utf8");
  assert.ok(
    src.includes("classifyPromptRejection(error) === \"locked\"")
      || /classifyPromptRejection\([^)]*\) === "locked"/.test(src),
    `${HOOK} 的发送失败路径必须用 classifyPromptRejection 判定 locked（一个概念一个写法）`,
  );
  const adHoc = src
    .split("\n")
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => /includes\(\s*["']locked by another/.test(line));
  assert.deepEqual(
    adHoc,
    [],
    `不要再用本地子串判断 locked（会漏掉同类措辞，也会与归类器分叉）：\n`
      + adHoc.map(({ line, index }) => `  ${HOOK}:${index}: ${line.trim()}`).join("\n"),
  );
});
