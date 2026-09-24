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

/**
 * 造一份指定字节数的偏好 JSON（用 padding 撑到目标大小）。
 */
function bigPrefsJson(bytes, draftValue = "上限内侧的草稿") {
  const head = `{"drafts":{"session-a":{"value":"${draftValue}"}},"padding":"`;
  const end = `"}`;
  const pad = bytes - Buffer.byteLength(head + end);
  return head + "x".repeat(Math.max(0, pad)) + end;
}

test("偏好文件超过字节上限时降级为空串（不读整份、不抛错）", () => {
  // 上限 4MB（lib/composer-draft-text.ts 的 COMPOSER_DRAFT_MAX_BYTES）：这是插件**同步**
  // 调用路径上的一次整文件读，必须有上界；超限等同于「没有草稿」，而不是抛错。
  withAgentDir(bigPrefsJson(4 * 1024 * 1024 + 1024), (dir) => {
    assert.equal(readComposerDraftText("session-a", dir), "", "超过 4MB 不读整份");
  });
  // 边界内侧仍要读得到：证明这不是把「大文件」一刀切掉
  withAgentDir(bigPrefsJson(4 * 1024 * 1024 - 1024), (dir) => {
    assert.equal(readComposerDraftText("session-a", dir), "上限内侧的草稿");
  });
});

test("读的是盘上镜像：浏览器已清空、PUT 还没到时读到的仍是旧文本", () => {
  // 这条记录的是**契约**而不是「正确行为」（issue #74 审查 P1）：本模块看不到浏览器里的
  // 输入框，只认盘上那份草稿（客户端清空走立即 flush，但仍要等一次 PUT 到达）。
  // 消费方把它当激活门槛时（pi-subagents 的 fleet 用 `getEditorText() === ""`），
  // 用户清空后立刻按键可能因这份旧文本不激活。客户端的门槛（空输入框才路由）不受影响。
  withAgentDir(JSON.stringify({ drafts: { "session-a": { value: "清空前打的字" } } }), (dir) => {
    assert.equal(readComposerDraftText("session-a", dir), "清空前打的字");
  });
});

test("会话创建前的草稿键（new:…）不在宿主会传的 id 里", () => {
  // 客户端在会话还不存在时用 new:${cwd} / new:${intentId} / "new" 作键
  // （hooks/useAgentSession.ts 的 draftKey），而宿主传的是已落盘的会话 id。
  withAgentDir(JSON.stringify({ drafts: { "new:/tmp/proj": { value: "建会话前打的字" } } }), (dir) => {
    assert.equal(readComposerDraftText("new:/tmp/proj", dir), "建会话前打的字", "键对得上就读得到");
    assert.equal(readComposerDraftText("session-1", dir), "", "宿主传的是会话 id，对不上就是空串");
  });
});

// 文档里引用的性能数字（偏好文件 42KB / 148 条草稿时 readFileSync + JSON.parse 约 0.5ms）
// 用下面这条命令可复现（在真实 agentDir 上只读，不改动）：
//   node -e 'const{readFileSync,statSync}=require("fs");const p=process.env.HOME+"/.pi/agent/pidance-preferences.json";
//   const t=process.hrtime.bigint();for(let i=0;i<200;i++)JSON.parse(readFileSync(p,"utf8"));console.log(statSync(p).size,
//   Number(process.hrtime.bigint()-t)/2e8,"ms/次")'
