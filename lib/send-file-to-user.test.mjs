import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  appendPidanceFileDeliveryPrompt,
  createSendFileToUserExecutor,
  PIDANCE_FILE_DELIVERY_SYSTEM_PROMPT,
  SEND_FILE_TO_USER_PARAMETERS,
  SEND_FILE_TO_USER_TOOL_NAME,
} = await jiti.import("./send-file-to-user.ts");
const { startSdkSessionHost } = await jiti.import("./sdk-session-host.ts");
const { createSessionManager, materializeSessionFile } = await jiti.import("./pi-session-io.ts");
const { saveChatAttachmentBytes } = await jiti.import("./chat-attachments.ts");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pidance-send-file-to-user-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  return { root, cwd, agentDir };
}

function isolatedSession(cwd, sessionDir) {
  const session = createSessionManager(cwd, sessionDir);
  materializeSessionFile(session);
  return session;
}

test("send_file_to_user：复制项目文件、发布 binary entry 并保留原始字节", async () => {
  const f = fixture();
  try {
    const source = join(f.cwd, "report.pdf");
    const bytes = Buffer.from("test report bytes");
    writeFileSync(source, bytes);
    let published;
    const tool = createSendFileToUserExecutor({
      cwd: f.cwd,
      agentDir: f.agentDir,
      appendBinary: (input) => {
        published = input;
        return { entryId: "entry-1" };
      },
    });

    const result = await tool({ path: "report.pdf" });
    assert.equal(published.name, "report.pdf");
    assert.equal(published.mimeType, "application/pdf");
    assert.equal(published.size, bytes.length);
    assert.ok(published.path.startsWith(join(f.agentDir, "pidance-attachments")));
    assert.deepEqual(readFileSync(published.path), bytes);
    assert.equal(result.name, "report.pdf");
    assert.equal(result.entryId, "entry-1");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("send_file_to_user：拒绝不存在文件和符号链接", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, "outside.txt"), "outside");
    symlinkSync(join(f.root, "outside.txt"), join(f.cwd, "link.txt"));
    const tool = createSendFileToUserExecutor({
      cwd: f.cwd,
      agentDir: f.agentDir,
      appendBinary: () => ({ entryId: "unused" }),
    });
    await assert.rejects(
      () => tool({ path: "missing.txt" }),
      /file not found/,
    );
    await assert.rejects(
      () => tool({ path: "link.txt" }),
      /symbolic-link sources are not allowed/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("send_file_to_user：FIFO 在打开前被拒绝", async () => {
  if (process.platform === "win32") return;
  const f = fixture();
  try {
    const fifo = join(f.cwd, "pipe");
    const result = spawnSync("mkfifo", [fifo]);
    if (result.status !== 0) return;
    const tool = createSendFileToUserExecutor({
      cwd: f.cwd,
      agentDir: f.agentDir,
      appendBinary: () => ({ entryId: "unused" }),
    });
    await assert.rejects(() => tool({ path: "pipe" }), /path must be a regular file/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Pidance 文件交付说明：追加一次且保留已有追加文令", () => {
  assert.equal(SEND_FILE_TO_USER_TOOL_NAME, "send_file_to_user");
  assert.deepEqual(SEND_FILE_TO_USER_PARAMETERS.required, ["path"]);
  const base = ["existing policy"];
  const appended = appendPidanceFileDeliveryPrompt(base);
  assert.deepEqual(appended.slice(0, 1), base);
  assert.equal(appended.at(-1), PIDANCE_FILE_DELIVERY_SYSTEM_PROMPT);
  assert.equal(appendPidanceFileDeliveryPrompt(appended), appended);
});

test("send_file_to_user：取消或发布失败不留下附件副本", async () => {
  const f = fixture();
  try {
    const source = join(f.cwd, "report.txt");
    writeFileSync(source, "test report");
    const controller = new AbortController();
    controller.abort();
    const aborted = createSendFileToUserExecutor({
      cwd: f.cwd,
      agentDir: f.agentDir,
      appendBinary: () => ({ entryId: "unused" }),
    });
    await assert.rejects(() => aborted({ path: "report.txt" }, controller.signal), /aborted/);

    const largeSource = join(f.cwd, "large.bin");
    writeFileSync(largeSource, Buffer.alloc(64 * 1024 * 1024, 7));
    const copyController = new AbortController();
    const copying = createSendFileToUserExecutor({
      cwd: f.cwd,
      agentDir: f.agentDir,
      appendBinary: () => ({ entryId: "unused" }),
    });
    const copyPromise = copying({ path: "large.bin" }, copyController.signal);
    setTimeout(() => copyController.abort(), 0);
    await assert.rejects(() => copyPromise, /aborted/i);

    const failed = createSendFileToUserExecutor({
      cwd: f.cwd,
      agentDir: f.agentDir,
      appendBinary: () => { throw new Error("publish failed"); },
    });
    await assert.rejects(() => failed({ path: "report.txt" }), /publish failed/);
    const attachmentDir = join(f.agentDir, "pidance-attachments");
    assert.deepEqual(readdirSync(attachmentDir), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("SdkSessionHost：默认会话注册 send_file_to_user 并注入系统文令", async () => {
  const f = fixture();
  const session = isolatedSession(f.cwd, f.root);
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: session.getSessionId(),
      sessionFile: session.getSessionFile(),
      cwd: f.cwd,
      agentDir: f.agentDir,
      idleTimeoutMs: 60_000,
    });
    const state = await host.send({ type: "get_state" });
    assert.ok(host.sessionFile.startsWith(f.root));
    assert.equal(host.inner.sessionManager.getCwd(), f.cwd);
    assert.match(state.systemPrompt, /Pidance file delivery/);
    assert.ok(host.runtime.session.getActiveToolNames().includes(SEND_FILE_TO_USER_TOOL_NAME));
    await host.send({ type: "set_tools", tools: ["read"] });
    assert.equal(host.runtime.session.getActiveToolNames().includes(SEND_FILE_TO_USER_TOOL_NAME), false);
    await host.send({ type: "set_tools", tools: [SEND_FILE_TO_USER_TOOL_NAME] });
    assert.equal(host.runtime.session.getActiveToolNames().includes(SEND_FILE_TO_USER_TOOL_NAME), true);
  } finally {
    await host?.destroyAsync();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("SdkSessionHost：SYSTEM.md 覆盖时仍保留 Pidance 文件交付说明", async () => {
  const f = fixture();
  const session = isolatedSession(f.cwd, f.root);
  let host;
  try {
    writeFileSync(join(f.agentDir, "SYSTEM.md"), "custom system base");
    host = await startSdkSessionHost({
      sessionId: session.getSessionId(),
      sessionFile: session.getSessionFile(),
      cwd: f.cwd,
      agentDir: f.agentDir,
      idleTimeoutMs: 60_000,
    });
    const state = await host.send({ type: "get_state" });
    assert.match(state.systemPrompt, /custom system base/);
    assert.match(state.systemPrompt, /Pidance file delivery/);
  } finally {
    await host?.destroyAsync();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("SdkSessionHost：显式关闭全部工具时不启用文件交付工具", async () => {
  const f = fixture();
  const session = isolatedSession(f.cwd, f.root);
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: session.getSessionId(),
      sessionFile: session.getSessionFile(),
      cwd: f.cwd,
      agentDir: f.agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
    });
    const state = await host.send({ type: "get_state" });
    assert.match(state.systemPrompt, /Pidance file delivery/);
    assert.equal(host.runtime.session.getActiveToolNames().includes(SEND_FILE_TO_USER_TOOL_NAME), false);
    await host.send({ type: "set_tools", tools: [SEND_FILE_TO_USER_TOOL_NAME] });
    // toolNames=[] 映射为 SDK 的空 allow-list，set_tools 也不能越过该限制。
    assert.equal(host.runtime.session.getActiveToolNames().includes(SEND_FILE_TO_USER_TOOL_NAME), false);
  } finally {
    await host?.destroyAsync();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("SdkSessionHost：会话变更或销毁后拒绝发布二进制消息", async () => {
  const f = fixture();
  const session = isolatedSession(f.cwd, f.root);
  const otherSession = isolatedSession(f.cwd, join(f.root, "other-session"));
  let host;
  try {
    host = await startSdkSessionHost({
      sessionId: session.getSessionId(),
      sessionFile: session.getSessionFile(),
      cwd: f.cwd,
      agentDir: f.agentDir,
      toolNames: [],
      idleTimeoutMs: 60_000,
    });
    assert.throws(
      () => host.appendBinary({ path: "/not-published", name: "x.txt", mimeType: "text/plain", size: 1 }, otherSession),
      /session changed/,
    );
    await host.destroyAsync();
    assert.throws(
      () => host.appendBinary({ path: "/not-published", name: "x.txt", mimeType: "text/plain", size: 1 }, session),
      /session not alive/,
    );
  } finally {
    await host?.destroyAsync();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("SdkSessionHost：通知失败不回滚已发布附件", async () => {
  const f = fixture();
  const session = isolatedSession(f.cwd, f.root);
  let host;
  try {
    const saved = saveChatAttachmentBytes("published.txt", Buffer.from("published"), f.agentDir);
    host = await startSdkSessionHost({
      sessionId: session.getSessionId(),
      sessionFile: session.getSessionFile(),
      cwd: f.cwd,
      agentDir: f.agentDir,
      toolNames: [],
      onSessionListInvalidate: () => { throw new Error("notification failed"); },
      idleTimeoutMs: 60_000,
    });
    const result = host.appendBinary({ path: saved.path, name: saved.name, mimeType: "text/plain", size: saved.size });
    assert.equal(result.binary.path, saved.path);
    assert.deepEqual(readFileSync(saved.path), Buffer.from("published"));
  } finally {
    await host?.destroyAsync();
    rmSync(f.root, { recursive: true, force: true });
  }
});
