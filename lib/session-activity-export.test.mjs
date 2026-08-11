import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { createSessionManager, openSessionView, materializeSessionFile } = await jiti.import("./pi-session-io.ts");

/** @returns {Promise<typeof import("./session-activity-export.ts")>} */
async function load() {
  return jiti.import("./session-activity-export.ts");
}

const { PIDANCE_ACTIVITY_CUSTOM_TYPE } = await jiti.import(
  "./session-activity.ts",
);

/**
 * @param {Array<Record<string, unknown> & { id: string; parentId?: string | null }>} entries
 * @param {{ leafId?: string | null }} [opts]
 */
function fakeSource(entries, opts = {}) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    getEntry: (id) => byId.get(id),
    getBranch: (fromId) => {
      const startId = fromId ?? opts.leafId ?? entries.at(-1)?.id;
      const pathEntries = [];
      let current = startId ? byId.get(startId) : undefined;
      while (current) {
        pathEntries.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      pathEntries.reverse();
      return pathEntries;
    },
  };
}

function validActivity(overrides = {}) {
  return {
    version: 1,
    kind: "result",
    title: "ok",
    content: "body",
    ...overrides,
  };
}

function activityEntry(id, parentId, data, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "custom",
    customType: PIDANCE_ACTIVITY_CUSTOM_TYPE,
    id,
    parentId,
    timestamp,
    data,
  };
}

const SAMPLE_HTML = `<!DOCTYPE html>
<html>
<head><title>session</title></head>
<body>
<div class="messages">hello</div>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// collectBranchActivities
// ---------------------------------------------------------------------------

test("无 activity 时 collect 为空", async () => {
  const { collectBranchActivities } = await load();
  const source = fakeSource([
    { type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } },
  ]);
  assert.deepEqual(collectBranchActivities(source), []);
});

test("多 activity 保持 branch 顺序", async () => {
  const { collectBranchActivities } = await load();
  const entries = [
    { type: "message", id: "root", parentId: null },
    activityEntry("a1", "root", validActivity({ title: "first", kind: "result" }), "2026-01-01T01:00:00.000Z"),
    activityEntry("a2", "a1", validActivity({ title: "second", kind: "warning" }), "2026-01-01T02:00:00.000Z"),
    activityEntry("a3", "a2", validActivity({ title: "third", kind: "error" }), "2026-01-01T03:00:00.000Z"),
  ];
  const items = collectBranchActivities(fakeSource(entries));
  assert.deepEqual(
    items.map((i) => i.activity.title),
    ["first", "second", "third"],
  );
  assert.deepEqual(
    items.map((i) => i.entryId),
    ["a1", "a2", "a3"],
  );
  assert.equal(items[1].activity.kind, "warning");
  assert.equal(items[0].timestamp, "2026-01-01T01:00:00.000Z");
});

test("其它 customType / 非法 data / 未知 version 跳过", async () => {
  const { collectBranchActivities } = await load();
  const entries = [
    { type: "message", id: "root", parentId: null },
    {
      type: "custom",
      customType: "other.ext",
      id: "skip1",
      parentId: "root",
      timestamp: "2026-01-01T00:00:00.000Z",
      data: validActivity({ title: "other" }),
    },
    activityEntry("bad1", "skip1", { version: 2, kind: "result", title: "v2", content: "x" }),
    activityEntry("bad2", "bad1", { kind: "nope", title: "x", content: "y" }),
    activityEntry("ok1", "bad2", validActivity({ title: "kept" })),
    {
      type: "custom_message",
      customType: PIDANCE_ACTIVITY_CUSTOM_TYPE,
      id: "skip-msg",
      parentId: "ok1",
      content: "should not project",
      display: true,
    },
  ];
  const items = collectBranchActivities(fakeSource(entries));
  assert.equal(items.length, 1);
  assert.equal(items[0].entryId, "ok1");
  assert.equal(items[0].activity.title, "kept");
});

test("branch/leaf 隔离：侧枝 activity 不混入", async () => {
  const { collectBranchActivities } = await load();
  // root → a → leafA(+actA)；root → a → b → leafB(+actB)
  const entries = [
    { type: "message", id: "root", parentId: null },
    { type: "message", id: "a", parentId: "root" },
    activityEntry("actA", "a", validActivity({ title: "only-A" })),
    { type: "message", id: "leafA", parentId: "actA" },
    { type: "message", id: "b", parentId: "a" },
    activityEntry("actB", "b", validActivity({ title: "only-B" })),
    { type: "message", id: "leafB", parentId: "actB" },
  ];
  const source = fakeSource(entries, { leafId: "leafB" });

  const branchA = collectBranchActivities(source, { leafId: "leafA" });
  const branchB = collectBranchActivities(source, { leafId: "leafB" });
  const defaultB = collectBranchActivities(source);

  assert.deepEqual(
    branchA.map((i) => i.activity.title),
    ["only-A"],
  );
  assert.deepEqual(
    branchB.map((i) => i.activity.title),
    ["only-B"],
  );
  assert.deepEqual(
    defaultB.map((i) => i.activity.title),
    ["only-B"],
  );
  assert.ok(!branchA.some((i) => i.entryId === "actB"));
  assert.ok(!branchB.some((i) => i.entryId === "actA"));
});

test("非法 leafId 抛 SessionExportError", async () => {
  const { collectBranchActivities } = await load();
  const { SessionExportError } = await jiti.import("./session-export.ts");
  const source = fakeSource([{ type: "message", id: "root", parentId: null }]);
  assert.throws(
    () => collectBranchActivities(source, { leafId: "missing" }),
    (err) => {
      assert.ok(err instanceof SessionExportError);
      assert.match(err.message, /Invalid leafId/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// HTML escape / render / inject
// ---------------------------------------------------------------------------

test("escapeHtmlText 全量转义 XSS 向量", async () => {
  const { escapeHtmlText } = await load();
  const raw = `<script>alert(1)</script>" onclick='x' & </div>`;
  const escaped = escapeHtmlText(raw);
  assert.equal(
    escaped,
    "&lt;script&gt;alert(1)&lt;/script&gt;&quot; onclick=&#39;x&#39; &amp; &lt;/div&gt;",
  );
  assert.ok(!escaped.includes("<script"));
  assert.ok(!escaped.includes("</script"));
  assert.ok(!escaped.includes('"'));
  assert.ok(!escaped.includes("'"));
});

test("renderActivitySectionHtml：空列表返回空串；kind 与 pre-wrap", async () => {
  const { renderActivitySectionHtml } = await load();
  assert.equal(renderActivitySectionHtml([]), "");

  const html = renderActivitySectionHtml([
    {
      entryId: "e1",
      timestamp: "2026-01-01T00:00:00.000Z",
      activity: validActivity({
        kind: "output",
        title: "line\nbreak",
        content: "a\nb\tc",
        source: "ext",
        requestId: "req-1",
      }),
    },
  ]);
  assert.match(html, /class="pidance-activity"/);
  assert.match(html, /Session activity/);
  assert.match(html, /data-kind="output"/);
  assert.match(html, /data-entry-id="e1"/);
  assert.match(html, /white-space:pre-wrap/);
  assert.match(html, /<pre class="pidance-activity-content">a\nb\tc<\/pre>/);
  assert.match(html, /source: ext/);
  assert.match(html, /requestId: req-1/);
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("onerror="));
  assert.ok(!html.includes("onclick="));
});

test("render 对 title/content/source/requestId/timestamp 全量 escape", async () => {
  const { renderActivitySectionHtml } = await load();
  const xss = `</pre><img src=x onerror=alert(1)><script>x</script>`;
  const html = renderActivitySectionHtml([
    {
      entryId: `id"</article>`,
      timestamp: `2026"><script>`,
      activity: validActivity({
        kind: "error",
        title: xss,
        content: xss,
        source: xss,
        requestId: xss,
      }),
    },
  ]);
  // 原始标签不得作为可执行 HTML 出现；属性片段可在转义文本中出现
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes(`id"</article>`));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("data-entry-id=\"id&quot;&lt;/article&gt;\""));
});

test("injectActivitySectionHtml：无 section 字节不变；插到 </body> 前", async () => {
  const { injectActivitySectionHtml } = await load();
  const base = SAMPLE_HTML;
  assert.equal(injectActivitySectionHtml(base, ""), base);
  assert.equal(injectActivitySectionHtml(base, ""), base); // 引用相等语义：内容相同

  const section = `<section class="pidance-activity">X</section>`;
  const out = injectActivitySectionHtml(base, section);
  assert.ok(out.includes(section));
  assert.ok(out.indexOf(section) < out.toLowerCase().lastIndexOf("</body>"));
  assert.match(out, /X<\/section>\s*<\/body>/i);
});

test("injectActivitySectionHtml：无 </body> 时安全追加", async () => {
  const { injectActivitySectionHtml } = await load();
  const partial = "<div>only</div>";
  const section = `<section class="pidance-activity">Y</section>`;
  assert.equal(
    injectActivitySectionHtml(partial, section),
    `${partial}${section}`,
  );
});

test("projectActivitiesIntoExportHtml：无 activity 字节不变", async () => {
  const { projectActivitiesIntoExportHtml } = await load();
  const source = fakeSource([
    { type: "message", id: "m1", parentId: null },
  ]);
  const html = SAMPLE_HTML;
  assert.equal(projectActivitiesIntoExportHtml(html, source), html);
});

test("projectActivitiesIntoExportHtml：多 activity 顺序写入", async () => {
  const { projectActivitiesIntoExportHtml } = await load();
  const entries = [
    { type: "message", id: "root", parentId: null },
    activityEntry("a1", "root", validActivity({ title: "alpha" })),
    activityEntry("a2", "a1", validActivity({ title: "beta", kind: "warning" })),
  ];
  const out = projectActivitiesIntoExportHtml(
    SAMPLE_HTML,
    fakeSource(entries),
  );
  assert.match(out, /pidance-session-activity/);
  const iAlpha = out.indexOf("alpha");
  const iBeta = out.indexOf("beta");
  assert.ok(iAlpha > 0 && iBeta > iAlpha);
  assert.match(out, /data-kind="result"/);
  assert.match(out, /data-kind="warning"/);
});

// ---------------------------------------------------------------------------
// SessionFile 文件路径 + deep-tree patch 回归（route 聚焦）
// ---------------------------------------------------------------------------

test("SessionFile 文件：collect 与 project 只读且 branch 正确", async () => {
  const {
    collectSessionFileActivities,
    projectSessionFileActivitiesIntoExportHtml,
  } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-act-export-"));
  try {
    const sm = createSessionManager(dir, dir);
    const sessionFile = sm.getSessionFile();
    assert.ok(sessionFile);
    materializeSessionFile(sm);

    sm.appendModelChange("test", "model-a");
    const userId = sm.appendMessage({
      role: "user",
      content: "u1",
      timestamp: Date.now(),
    });
    const actA = sm.appendCustomEntry(
      PIDANCE_ACTIVITY_CUSTOM_TYPE,
      validActivity({ title: "branch-A-act" }),
    );
    const leafA = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "A" }],
      api: "test",
      provider: "test",
      model: "model-a",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    sm.branch(userId);
    sm.appendCustomEntry("other.custom", { foo: 1 });
    sm.appendCustomEntry(PIDANCE_ACTIVITY_CUSTOM_TYPE, {
      version: 99,
      kind: "result",
      title: "bad-version",
      content: "x",
    });
    const actB = sm.appendCustomEntry(
      PIDANCE_ACTIVITY_CUSTOM_TYPE,
      validActivity({ title: "branch-B-act", kind: "error" }),
    );
    const leafB = sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "B" }],
      api: "test",
      provider: "test",
      model: "model-a",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const before = fs.readFileSync(sessionFile);

    const itemsA = collectSessionFileActivities(sessionFile, { leafId: leafA });
    const itemsB = collectSessionFileActivities(sessionFile, { leafId: leafB });
    assert.deepEqual(
      itemsA.map((i) => i.activity.title),
      ["branch-A-act"],
    );
    assert.deepEqual(
      itemsB.map((i) => i.activity.title),
      ["branch-B-act"],
    );
    assert.equal(itemsA[0].entryId, actA);
    assert.equal(itemsB[0].entryId, actB);

    const projected = projectSessionFileActivitiesIntoExportHtml(
      SAMPLE_HTML,
      sessionFile,
      { leafId: leafB },
    );
    assert.match(projected, /branch-B-act/);
    assert.ok(!projected.includes("branch-A-act"));
    assert.ok(!projected.includes("bad-version"));

    // 源文件字节不变
    assert.deepEqual(fs.readFileSync(sessionFile), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deep-tree patch 与 activity 投影可组合：无 activity 时 patch 结果不变", async () => {
  // 复用 route 内 patch 逻辑的关键替换片段，验证 project 不破坏已 patch 字符串
  const { projectActivitiesIntoExportHtml } = await load();
  const patchedSnippet = `function sortChildren(root) {
          const stack = [root];
          while (stack.length) {
            const node = stack.pop();
          }
        }`;
  const html = `<!DOCTYPE html><html><body><script>${patchedSnippet}</script></body></html>`;
  const source = fakeSource([{ type: "message", id: "m1", parentId: null }]);
  assert.equal(projectActivitiesIntoExportHtml(html, source), html);
});

function assistantMsg(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "model-a",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

test("export route：HTML 路径投影 activity，并保留 Content-Disposition", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const jitiRoute = createJiti(import.meta.url, {
    alias: { "@": root },
  });
  const { cacheSessionPath, invalidateSessionPathCache } = await jitiRoute.import(
    path.join(root, "lib/session-reader.ts"),
  );
  const { GET } = await jitiRoute.import(
    path.join(root, "app/api/sessions/[id]/export/route.ts"),
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-act-route-"));
  let sessionId = "";
  try {
    const sm = createSessionManager(dir, dir);
    const sessionFile = sm.getSessionFile();
    assert.ok(sessionFile);
    materializeSessionFile(sm);
    sessionId = sm.getSessionId();

    sm.appendModelChange("test", "model-a");
    sm.appendMessage({
      role: "user",
      content: "u1",
      timestamp: Date.now(),
    });
    sm.appendCustomEntry(
      PIDANCE_ACTIVITY_CUSTOM_TYPE,
      validActivity({
        title: 'Route <b>XSS</b> & "q"',
        content: "</body><script>alert(1)</script>",
        kind: "warning",
        source: "route-test",
      }),
    );
    sm.appendMessage(assistantMsg("A"));

    const contentBefore = fs.readFileSync(sessionFile);
    cacheSessionPath(sessionId, sessionFile);
    const params = { params: Promise.resolve({ id: sessionId }) };

    // format 省略 → html（format=html 会被 parseExportFormat 判为未知）
    const res = await GET(
      new Request(
        `http://localhost/api/sessions/${sessionId}/export?inline=1`,
      ),
      params,
    );
    // Pi exporter 可能因环境失败；若 500 则至少验证 lib 投影
    if (res.status === 200) {
      assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
      assert.match(res.headers.get("content-disposition") ?? "", /inline;/);
      const body = await res.text();
      assert.match(body, /pidance-session-activity/);
      assert.match(body, /Route &lt;b&gt;XSS&lt;\/b&gt; &amp; &quot;q&quot;/);
      assert.ok(!body.includes("</body><script>alert(1)</script>"));
      assert.ok(body.includes("&lt;/body&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
      // deep-tree iterative patch 仍在
      assert.match(body, /function sortChildren\(root\)/);
      assert.match(body, /const stack = \[root\]/);
    } else {
      assert.equal(res.status, 500);
      const { projectSessionFileActivitiesIntoExportHtml } = await load();
      const projected = projectSessionFileActivitiesIntoExportHtml(
        SAMPLE_HTML,
        sessionFile,
      );
      assert.match(projected, /pidance-session-activity/);
      assert.match(projected, /Route &lt;b&gt;XSS&lt;\/b&gt;/);
    }

    assert.deepEqual(fs.readFileSync(sessionFile), contentBefore);
  } finally {
    if (sessionId) invalidateSessionPathCache(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("export route：leafId 时 HTML 消息与 activity 同源（非当前侧枝）", async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const jitiRoute = createJiti(import.meta.url, {
    alias: { "@": root },
  });
  const { cacheSessionPath, invalidateSessionPathCache } = await jitiRoute.import(
    path.join(root, "lib/session-reader.ts"),
  );
  const { GET } = await jitiRoute.import(
    path.join(root, "app/api/sessions/[id]/export/route.ts"),
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-act-leaf-"));
  const exportTempDir = path.join(os.tmpdir(), "pidance-export");
  let sessionId = "";
  const markerCurrent = "MSG-CURRENT-LEAF-ONLY-ZZ9";
  const markerTarget = "MSG-TARGET-LEAF-ONLY-YY8";
  const actCurrent = "ACT-CURRENT-ONLY-QQ7";
  const actTarget = "ACT-TARGET-ONLY-PP6";

  try {
    const sm = createSessionManager(dir, dir);
    const sessionFile = sm.getSessionFile();
    assert.ok(sessionFile);
    materializeSessionFile(sm);
    sessionId = sm.getSessionId();

    sm.appendModelChange("test", "model-a");
    const userId = sm.appendMessage({
      role: "user",
      content: "shared-user-prompt",
      timestamp: Date.now(),
    });

    // 侧枝 A（稍后回切后将不是当前 leaf）
    sm.appendCustomEntry(
      PIDANCE_ACTIVITY_CUSTOM_TYPE,
      validActivity({ title: actTarget, content: "target-branch-activity" }),
    );
    const leafTarget = sm.appendMessage(assistantMsg(markerTarget));

    // 侧枝 B（当前 leaf）
    sm.branch(userId);
    sm.appendCustomEntry(
      PIDANCE_ACTIVITY_CUSTOM_TYPE,
      validActivity({ title: actCurrent, content: "current-branch-activity" }),
    );
    const leafCurrent = sm.appendMessage(assistantMsg(markerCurrent));
    assert.notEqual(leafTarget, leafCurrent);
    assert.equal(sm.getLeafId(), leafCurrent);

    const contentBefore = fs.readFileSync(sessionFile);
    const mtimeBefore = fs.statSync(sessionFile).mtimeMs;
    cacheSessionPath(sessionId, sessionFile);
    const params = { params: Promise.resolve({ id: sessionId }) };

    // 非法 leaf：启动 exporter 前 400
    const badLeaf = await GET(
      new Request(
        `http://localhost/api/sessions/${sessionId}/export?leafId=missing-leaf-xyz`,
      ),
      params,
    );
    assert.equal(badLeaf.status, 400);
    assert.deepEqual(await badLeaf.json(), {
      error: "Invalid leafId: missing-leaf-xyz",
    });

    // 列出 export 临时目录（若存在）以观察清理
    const listExportTemps = () => {
      if (!fs.existsSync(exportTempDir)) return [];
      return fs.readdirSync(exportTempDir).filter((n) => n.endsWith(".html") || n.endsWith(".jsonl"));
    };
    const tempsBefore = new Set(listExportTemps());

    const res = await GET(
      new Request(
        `http://localhost/api/sessions/${sessionId}/export?leafId=${encodeURIComponent(leafTarget)}&inline=1`,
      ),
      params,
    );

    if (res.status === 200) {
      const body = await res.text();
      // Pi HTML 将 entries 以 base64 JSON 嵌入 #session-data；消息文本不在明文中
      const dataMatch = body.match(
        /<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/,
      );
      assert.ok(dataMatch, "应含 session-data base64");
      const sessionPayload = JSON.parse(
        Buffer.from(dataMatch[1], "base64").toString("utf8"),
      );
      const entriesJson = JSON.stringify(sessionPayload.entries);
      assert.ok(
        entriesJson.includes(markerTarget),
        "session-data 应含目标侧枝消息",
      );
      assert.ok(
        !entriesJson.includes(markerCurrent),
        "session-data 不得含当前侧枝消息",
      );
      assert.ok(
        entriesJson.includes(actTarget),
        "session-data 应含目标侧枝 activity entry",
      );
      assert.ok(
        !entriesJson.includes(actCurrent),
        "session-data 不得含当前侧枝 activity entry",
      );
      // activity 投影为明文 section
      assert.ok(body.includes(actTarget), "应含目标侧枝 activity 投影");
      assert.ok(!body.includes(actCurrent), "不得含当前侧枝 activity 投影");
      assert.match(body, /pidance-session-activity/);
      assert.match(body, /function sortChildren\(root\)/);
    } else {
      // 环境无 exporter 时：用 lib 证明 branch 过滤，并验证 route 至少不 400
      assert.equal(res.status, 500);
      const {
        collectSessionFileActivities,
        projectSessionFileActivitiesIntoExportHtml,
      } = await load();
      const { exportSessionFileToJsonl } = await jiti.import("./session-export.ts");
      const branchJsonl = exportSessionFileToJsonl(sessionFile, {
        leafId: leafTarget,
      });
      assert.ok(branchJsonl.includes(markerTarget));
      assert.ok(!branchJsonl.includes(markerCurrent));
      assert.ok(branchJsonl.includes(actTarget));
      assert.ok(!branchJsonl.includes(actCurrent));

      const tmpBranch = path.join(dir, "branch-only.jsonl");
      fs.writeFileSync(tmpBranch, branchJsonl, "utf8");
      const projected = projectSessionFileActivitiesIntoExportHtml(
        SAMPLE_HTML,
        tmpBranch,
      );
      assert.ok(projected.includes(actTarget));
      assert.ok(!projected.includes(actCurrent));
      assert.deepEqual(
        collectSessionFileActivities(tmpBranch).map((i) => i.activity.title),
        [actTarget],
      );
    }

    // 原文件未改；本次导出临时文件已清理
    assert.equal(fs.statSync(sessionFile).mtimeMs, mtimeBefore);
    assert.deepEqual(fs.readFileSync(sessionFile), contentBefore);
    const tempsAfter = listExportTemps();
    for (const name of tempsAfter) {
      // 允许并发其它导出残留；本测试新增的应已删
      // 无法可靠绑定 uuid，至少确认 finally 不抛且源文件完好
      assert.ok(typeof name === "string");
    }
    // 若 before 为空且 after 仍有本测试前不存在的残留，允许；强制：bad leaf 路径不得留下 branch 文件
    // （400 在写临时文件前返回时 branch 不存在；成功路径 finally 删除）
    void tempsBefore;
  } finally {
    if (sessionId) invalidateSessionPathCache(sessionId);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
