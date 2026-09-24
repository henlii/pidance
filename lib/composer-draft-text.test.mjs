/**
 * `ctx.ui.getEditorText()` 的服务端草稿读取（issue #74）。
 *
 * 隔离在临时 agentDir 上：这里只读偏好文件，但绝不能碰用户真实的 ~/.pi/agent。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readComposerDraftText } = await jiti.import("./composer-draft-text.ts");
const { PIDANCE_PREFS_FILENAME } = await jiti.import("./pidance-prefs-file.ts");

/** 在临时 agentDir 里放一份偏好文件（raw 为 null 表示不放文件）。 */
function withAgentDir(raw, run) {
  const dir = mkdtempSync(join(tmpdir(), "pidance-composer-text-"));
  try {
    if (raw !== null) writeFileSync(join(dir, PIDANCE_PREFS_FILENAME), raw, "utf8");
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("读得到该会话的草稿文本", () => {
  withAgentDir(
    JSON.stringify({
      drafts: {
        "session-a": { value: "帮我改这个函数", images: [], updatedAt: 1 },
        "session-b": { value: "另一个会话的草稿", images: [] },
      },
      other: 1,
    }),
    (dir) => {
      assert.equal(readComposerDraftText("session-a", dir), "帮我改这个函数");
      assert.equal(readComposerDraftText("session-b", dir), "另一个会话的草稿");
    },
  );
});

test("形状不对一律空串：无草稿 / 无 drafts / 值不是字符串 / 只有图", () => {
  withAgentDir(JSON.stringify({ drafts: { "session-a": { value: "有草稿" } } }), (dir) => {
    assert.equal(readComposerDraftText("session-missing", dir), "", "没有该会话的草稿");
  });
  withAgentDir(JSON.stringify({ drafts: { "session-a": { images: [{ mimeType: "image/png" }] } } }), (dir) => {
    assert.equal(readComposerDraftText("session-a", dir), "", "只有图没有文字");
  });
  withAgentDir(JSON.stringify({ drafts: { "session-a": { value: 42 } } }), (dir) => {
    assert.equal(readComposerDraftText("session-a", dir), "", "value 不是字符串");
  });
  withAgentDir(JSON.stringify({ drafts: [] }), (dir) => {
    assert.equal(readComposerDraftText("session-a", dir), "", "drafts 是数组");
  });
  withAgentDir(JSON.stringify(["not-an-object"]), (dir) => {
    assert.equal(readComposerDraftText("session-a", dir), "", "顶层不是对象");
  });
});

test("文件缺失或不是 JSON 都不抛错，只是空串（插件调的是同步 API）", () => {
  withAgentDir(null, (dir) => {
    assert.equal(readComposerDraftText("session-a", dir), "");
  });
  withAgentDir("{ 这不是 JSON", (dir) => {
    assert.equal(readComposerDraftText("session-a", dir), "");
  });
  assert.equal(readComposerDraftText("session-a", join(tmpdir(), "pidance-no-such-agent-dir")), "");
});

test("空 sessionId 直接空串（不读盘）", () => {
  assert.equal(readComposerDraftText(""), "");
});
