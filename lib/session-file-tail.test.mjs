/**
 * 会话文件跟随的探测与等待（跨进程 / 外部修改）。
 *
 * 这里只测文件层：偏移、半行、截断、换 inode、等待超时。投影（entry → message）
 * 仍由 `/api/sessions/[id]/context?after=` 负责，不在这一层重复。
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { probeSessionFile, readLastEntryId, waitForSessionFileChange } = await jiti.import("./session-file-tail.ts");

function makeFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), "pidance-tail-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return { dir, path };
}

const entry = (id, parentId = null, extra = {}) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text: id }] },
  ...extra,
});

test("首次探测只建基线：不报 changed，给最后一条完整 entry 的 id", () => {
  const { dir, path } = makeFile([entry("a"), entry("b", "a")]);
  try {
    const probe = probeSessionFile(path, null, { writerActive: false });
    assert.equal(probe.available, true);
    assert.equal(probe.changed, false, "首次不该说变了（客户端刚读完详情）");
    assert.equal(probe.reset, false);
    assert.equal(probe.lastEntryId, "b");
    assert.ok(probe.size > 0 && probe.ino > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("追加一行 → changed；半行不算，lastEntryId 停在最后一条完整行", () => {
  const { dir, path } = makeFile([entry("a")]);
  try {
    const first = probeSessionFile(path, null, {});
    appendFileSync(path, `${JSON.stringify(entry("b", "a"))}\n`);
    const grown = probeSessionFile(path, { offset: first.size, ino: first.ino }, {});
    assert.equal(grown.changed, true);
    assert.equal(grown.lastEntryId, "b");

    // 写端正在写：没有换行的半行不能当 entry，也不能推进 lastEntryId
    appendFileSync(path, '{"type":"message","id":"c","pare');
    const partial = probeSessionFile(path, { offset: grown.size, ino: grown.ino }, {});
    assert.equal(partial.changed, true, "字节数变了仍然是变化");
    assert.equal(partial.lastEntryId, "b", "半行不能被当成最后一条");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("文件被截断：无 writer 判 reset，有 writer 判 externalRewrite", () => {
  const { dir, path } = makeFile([entry("a"), entry("b", "a")]);
  try {
    const baseline = probeSessionFile(path, null, {});
    writeFileSync(path, `${JSON.stringify(entry("a"))}\n`);
    const noWriter = probeSessionFile(path, { offset: baseline.size, ino: baseline.ino }, { writerActive: false });
    assert.equal(noWriter.reset, true, "外部手改后应整份重载");
    assert.equal(noWriter.externalRewrite, false);

    writeFileSync(path, '{"type":');
    const withWriter = probeSessionFile(path, { offset: baseline.size, ino: baseline.ino }, { writerActive: true });
    assert.equal(withWriter.reset, false, "writer 活着时不能静默采纳外部改写");
    assert.equal(withWriter.externalRewrite, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("换 inode（文件被替换成新文件）→ 判失效", () => {
  const { dir, path } = makeFile([entry("a")]);
  const replacement = join(dir, "replacement.jsonl");
  try {
    const baseline = probeSessionFile(path, null, {});
    writeFileSync(replacement, `${JSON.stringify(entry("z"))}\n`);
    renameSync(replacement, path);
    const probe = probeSessionFile(path, { offset: baseline.size, ino: baseline.ino }, { writerActive: false });
    assert.equal(probe.reset, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("尾部探测只看 64KB 窗口：长会话也能拿到最后一条 id", () => {
  const filler = "x".repeat(2_000);
  const lines = [];
  for (let index = 0; index < 80; index += 1) lines.push(entry(`e${index}`, null, { note: filler }));
  const { dir, path } = makeFile(lines);
  try {
    const probe = probeSessionFile(path, null, {});
    assert.ok(probe.size > 64 * 1024, "样本应大于探测窗口");
    assert.equal(readLastEntryId(path, probe.size), "e79");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("等待：追加后立刻返回 true，等不到就超时返回 false", async () => {
  const { dir, path } = makeFile([entry("a")]);
  try {
    const first = probeSessionFile(path, null, {});
    const waitAppend = waitForSessionFileChange(
      path,
      { ino: first.ino, size: first.size },
      2_000,
    );
    setTimeout(() => appendFileSync(path, `${JSON.stringify(entry("b", "a"))}\n`), 60);
    assert.equal(await waitAppend, true);

    const afterAppend = probeSessionFile(path, null, {});
    assert.equal(await waitForSessionFileChange(path, { ino: afterAppend.ino, size: afterAppend.size }, 200), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("等待可被 abort 取消（退订 = 关页面/切会话）", async () => {
  const { dir, path } = makeFile([entry("a")]);
  try {
    const first = probeSessionFile(path, null, {});
    const controller = new AbortController();
    const waiting = waitForSessionFileChange(path, { ino: first.ino, size: first.size }, 5_000, controller.signal);
    controller.abort();
    assert.equal(await waiting, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
