import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

/** @returns {Promise<typeof import("./subagent-runs.ts")>} */
async function load() {
  return jiti.import("./subagent-runs.ts");
}

/**
 * 在临时目录写入一个 run 的 status/events/output。
 * @param {string} root
 * @param {string} id
 * @param {object} status
 * @param {{ events?: object[]; output?: string; outputName?: string }} [extra]
 */
function writeRun(root, id, status, extra = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const payload = { runId: id, ...status };
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(payload), "utf8");
  if (extra.events) {
    const lines = extra.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(path.join(dir, "events.jsonl"), lines, "utf8");
  }
  if (extra.output !== undefined) {
    const name = extra.outputName ?? "output-0.log";
    fs.writeFileSync(path.join(dir, name), extra.output, "utf8");
  }
  return dir;
}

function snapshotMtimes(dir) {
  /** @type {Record<string, { mtimeMs: number; size: number }>} */
  const out = {};
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isFile()) out[name] = { mtimeMs: st.mtimeMs, size: st.size };
  }
  return out;
}

test("resolveTempScopeId 镜像 uid / user / shared 回退", async () => {
  const { resolveTempScopeId, resolveAsyncRunsRoot } = await load();
  assert.equal(resolveTempScopeId({ getuid: () => 0 }), "uid-0");
  assert.equal(resolveTempScopeId({ getuid: () => 1000 }), "uid-1000");
  assert.equal(
    resolveTempScopeId({ getuid: undefined, env: { USER: "alice" } }),
    "user-alice",
  );
  assert.equal(
    resolveTempScopeId({
      getuid: undefined,
      env: {},
      userInfo: () => {
        throw new Error("no");
      },
      homedir: () => "/home/bob",
    }),
    "home-home-bob",
  );
  assert.equal(
    resolveTempScopeId({
      getuid: undefined,
      env: {},
      userInfo: () => ({ username: null }),
      homedir: () => {
        throw new Error("no");
      },
    }),
    "shared",
  );
  const root = resolveAsyncRunsRoot({
    getuid: () => 42,
    tmpdir: () => "/tmp",
  });
  assert.equal(root, path.join("/tmp", "pi-subagents-uid-42", "async-subagent-runs"));
});

test("parseSubagentRunsLimit 默认/上限/非法", async () => {
  const { parseSubagentRunsLimit, DEFAULT_LIMIT, MAX_LIMIT } = await load();
  assert.equal(parseSubagentRunsLimit(null), DEFAULT_LIMIT);
  assert.equal(parseSubagentRunsLimit(""), DEFAULT_LIMIT);
  assert.equal(parseSubagentRunsLimit("20"), 20);
  assert.equal(parseSubagentRunsLimit(String(MAX_LIMIT)), MAX_LIMIT);
  assert.equal(parseSubagentRunsLimit("0"), null);
  assert.equal(parseSubagentRunsLimit("51"), null);
  assert.equal(parseSubagentRunsLimit("-1"), null);
  assert.equal(parseSubagentRunsLimit("1.5"), null);
  assert.equal(parseSubagentRunsLimit("abc"), null);
  assert.equal(parseSubagentRunsLimit("20x"), null);
});

test("single/parallel/chain 正常解析 tokens/cost/attention/steps", async () => {
  const { listSubagentRuns } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sar-"));
  try {
    writeRun(
      root,
      "run-single",
      {
        mode: "single",
        state: "running",
        activityState: "needs_attention",
        startedAt: 1000,
        lastUpdate: 1500,
        cwd: "/proj/a",
        currentStep: 0,
        totalTokens: { input: 10, output: 20, total: 30 },
        totalCost: { inputTokens: 10, outputTokens: 20, costUsd: 0.01 },
        outputFile: "output-0.log",
        steps: [
          {
            agent: "coder",
            label: "main",
            status: "running",
            model: "claude",
            sessionFile: "/sessions/x.jsonl",
            activityState: "needs_attention",
            currentTool: "bash",
            recentOutput: ["line1", "line2"],
            tokens: { input: 10, output: 20, total: 30 },
            totalCost: { costUsd: 0.01 },
            startedAt: 1000,
          },
        ],
      },
      {
        events: [
          { type: "run.started", timestamp: 1000, message: "go" },
          { type: "step.tool", timestamp: 1200 },
        ],
        output: "hello output\n",
      },
    );
    writeRun(root, "run-parallel", {
      mode: "parallel",
      state: "complete",
      startedAt: 2000,
      endedAt: 3000,
      lastUpdate: 3000,
      totalTokens: { input: 1, output: 2, total: 3 },
      steps: [
        { agent: "a", status: "complete", tokens: { input: 1, output: 1, total: 2 } },
        { agent: "b", status: "complete", tokens: { input: 0, output: 1, total: 1 } },
      ],
    });
    writeRun(root, "run-chain", {
      mode: "chain",
      state: "queued",
      startedAt: 500,
      chainStepCount: 3,
      currentStep: 0,
      steps: [
        { agent: "s1", status: "pending" },
        { agent: "s2", status: "pending" },
        { agent: "s3", status: "pending" },
      ],
    });

    const res = listSubagentRuns({ root, limit: 20, now: () => 9999 });
    assert.equal(res.rootAvailable, true);
    assert.equal(res.generatedAt, 9999);
    assert.equal(res.runs.length, 3);

    const single = res.runs.find((r) => r.id === "run-single");
    assert.ok(single);
    assert.equal(single.state, "running");
    assert.equal(single.mode, "single");
    assert.equal(single.activityState, "needs_attention");
    assert.equal(single.cwd, "/proj/a");
    assert.deepEqual(single.totalTokens, { input: 10, output: 20, total: 30 });
    assert.equal(single.totalCostUsd, 0.01);
    assert.equal(single.steps.length, 1);
    assert.equal(single.steps[0].agent, "coder");
    assert.equal(single.steps[0].activityState, "needs_attention");
    assert.equal(single.steps[0].currentTool, "bash");
    assert.equal(single.steps[0].sessionFile, "/sessions/x.jsonl");
    assert.equal(single.steps[0].costUsd, 0.01);
    assert.deepEqual(single.steps[0].recentOutput, ["line1", "line2"]);
    assert.equal(single.recentEvents.length, 2);
    assert.equal(single.recentEvents[0].type, "run.started");
    assert.equal(single.outputTail, "hello output\n");
    assert.equal(single.outputTruncated, false);

    const parallel = res.runs.find((r) => r.id === "run-parallel");
    assert.ok(parallel);
    assert.equal(parallel.mode, "parallel");
    assert.equal(parallel.state, "complete");
    assert.equal(parallel.steps.length, 2);

    const chain = res.runs.find((r) => r.id === "run-chain");
    assert.ok(chain);
    assert.equal(chain.mode, "chain");
    assert.equal(chain.chainStepCount, 3);
    assert.equal(chain.steps.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("active-first / recent-first / limit", async () => {
  const { listSubagentRuns, sortRunsActiveFirst } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sar-sort-"));
  try {
    writeRun(root, "complete-old", {
      mode: "single",
      state: "complete",
      startedAt: 100,
      lastUpdate: 200,
    });
    writeRun(root, "running-new", {
      mode: "single",
      state: "running",
      startedAt: 300,
      lastUpdate: 400,
    });
    writeRun(root, "queued", {
      mode: "single",
      state: "queued",
      startedAt: 350,
      lastUpdate: 350,
    });
    writeRun(root, "failed", {
      mode: "single",
      state: "failed",
      startedAt: 500,
      lastUpdate: 600,
      error: "boom",
    });
    writeRun(root, "running-older", {
      mode: "single",
      state: "running",
      startedAt: 250,
      lastUpdate: 260,
    });

    const res = listSubagentRuns({ root, limit: 3 });
    assert.equal(res.runs.length, 3);
    // running 优先，且 lastUpdate 降序
    assert.equal(res.runs[0].id, "running-new");
    assert.equal(res.runs[1].id, "running-older");
    assert.equal(res.runs[2].id, "queued");

    const sorted = sortRunsActiveFirst(res.runs);
    assert.equal(sorted[0].state, "running");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("损坏 status、未知字段、截断 JSONL 仍保留其它 run", async () => {
  const { listSubagentRuns } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sar-bad-"));
  try {
    writeRun(root, "good", {
      mode: "single",
      state: "complete",
      startedAt: 1,
      lastUpdate: 2,
      unknownTop: { nested: true },
      steps: [{ agent: "x", status: "complete", weird: 1 }],
    });
    // 损坏 JSON
    const badDir = path.join(root, "bad-json");
    fs.mkdirSync(badDir);
    fs.writeFileSync(path.join(badDir, "status.json"), "{not-json", "utf8");
    // 缺少 state
    writeRun(root, "no-state", { mode: "single", startedAt: 1 });
    // 无效 state
    writeRun(root, "bad-state", { mode: "single", state: "flying", startedAt: 1 });
    // 截断 JSONL：首行半截 + 完整行
    writeRun(
      root,
      "trunc-events",
      { mode: "single", state: "paused", startedAt: 10, lastUpdate: 11 },
      {
        events: undefined,
      },
    );
    fs.writeFileSync(
      path.join(root, "trunc-events", "events.jsonl"),
      '{"type":"broken"\n{"type":"ok","timestamp":1,"message":"fine"}\n',
      "utf8",
    );

    const res = listSubagentRuns({ root });
    const ids = res.runs.map((r) => r.id).sort();
    assert.deepEqual(ids, ["good", "trunc-events"]);
    const trunc = res.runs.find((r) => r.id === "trunc-events");
    assert.ok(trunc);
    assert.ok(trunc.recentEvents.some((e) => e.type === "ok"));
    assert.equal(trunc.recentEvents.some((e) => e.type === "broken"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run/status/events/output symlink 拒绝；outputFile 越界拒绝", async () => {
  const { listSubagentRuns } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sar-sym-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sar-out-"));
  try {
    // 正常 run 作对照
    writeRun(
      root,
      "ok-run",
      {
        mode: "single",
        state: "complete",
        startedAt: 1,
        lastUpdate: 2,
        outputFile: "output-0.log",
      },
      { output: "inside" },
    );

    // run 目录本身是 symlink
    const realOutsideRun = path.join(outside, "evil-run");
    fs.mkdirSync(realOutsideRun);
    fs.writeFileSync(
      path.join(realOutsideRun, "status.json"),
      JSON.stringify({
        runId: "evil-run",
        mode: "single",
        state: "running",
        startedAt: 99,
      }),
    );
    fs.symlinkSync(realOutsideRun, path.join(root, "evil-run"));

    // status.json 是 symlink
    writeRun(root, "status-link", {
      mode: "single",
      state: "complete",
      startedAt: 3,
    });
    const statusPath = path.join(root, "status-link", "status.json");
    const outsideStatus = path.join(outside, "status.json");
    fs.writeFileSync(
      outsideStatus,
      JSON.stringify({
        runId: "status-link",
        mode: "single",
        state: "running",
        startedAt: 3,
      }),
    );
    fs.unlinkSync(statusPath);
    fs.symlinkSync(outsideStatus, statusPath);

    // events.jsonl 是 symlink → 事件为空，run 仍可出现
    writeRun(
      root,
      "events-link",
      { mode: "single", state: "complete", startedAt: 4, lastUpdate: 5 },
      { events: [{ type: "local" }] },
    );
    const eventsPath = path.join(root, "events-link", "events.jsonl");
    const outsideEvents = path.join(outside, "events.jsonl");
    fs.writeFileSync(outsideEvents, JSON.stringify({ type: "leaked" }) + "\n");
    fs.unlinkSync(eventsPath);
    fs.symlinkSync(outsideEvents, eventsPath);

    // output 是 symlink → 不读尾部
    writeRun(
      root,
      "output-link",
      {
        mode: "single",
        state: "complete",
        startedAt: 6,
        lastUpdate: 7,
        outputFile: "output-0.log",
      },
      { output: "local" },
    );
    const outPath = path.join(root, "output-link", "output-0.log");
    const outsideOut = path.join(outside, "out.log");
    fs.writeFileSync(outsideOut, "LEAKED-OUTPUT");
    fs.unlinkSync(outPath);
    fs.symlinkSync(outsideOut, outPath);

    // outputFile 越界：basename 不匹配
    writeRun(root, "bad-outname", {
      mode: "single",
      state: "complete",
      startedAt: 8,
      lastUpdate: 9,
      outputFile: "../secret.log",
    });
    fs.writeFileSync(path.join(root, "secret.log"), "nope");

    // outputFile 指向绝对路径越界
    writeRun(root, "abs-out", {
      mode: "single",
      state: "complete",
      startedAt: 10,
      lastUpdate: 11,
      outputFile: outsideOut,
    });

    const res = listSubagentRuns({ root });
    const byId = Object.fromEntries(res.runs.map((r) => [r.id, r]));

    assert.ok(byId["ok-run"]);
    assert.equal(byId["ok-run"].outputTail, "inside");

    // symlink run 目录被拒
    assert.equal(byId["evil-run"], undefined);

    // status symlink 被拒
    assert.equal(byId["status-link"], undefined);

    // events symlink → 无事件，但 run 保留
    assert.ok(byId["events-link"]);
    assert.deepEqual(byId["events-link"].recentEvents, []);

    // output symlink → 无 tail
    assert.ok(byId["output-link"]);
    assert.equal(byId["output-link"].outputTail, undefined);

    // 越界 outputFile 不读
    assert.ok(byId["bad-outname"]);
    assert.equal(byId["bad-outname"].outputTail, undefined);
    assert.ok(byId["abs-out"]);
    assert.equal(byId["abs-out"].outputTail, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("文件上限/尾部上限；读取前后 mtime/size 不变", async () => {
  const {
    listSubagentRuns,
    MAX_STATUS_BYTES,
    MAX_EVENTS_PARSE,
    MAX_RECENT_OUTPUT_ITEMS,
    MAX_RECENT_OUTPUT_ITEM_CHARS,
  } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sar-lim-"));
  try {
    // 过大 status → 跳过
    const hugeDir = path.join(root, "huge-status");
    fs.mkdirSync(hugeDir);
    fs.writeFileSync(
      path.join(hugeDir, "status.json"),
      JSON.stringify({
        runId: "huge-status",
        mode: "single",
        state: "complete",
        startedAt: 1,
        pad: "x".repeat(MAX_STATUS_BYTES),
      }),
    );

    // 正常 run + 长 events + 长 recentOutput + 长 output
    const longLine = "y".repeat(500);
    const events = [];
    for (let i = 0; i < 40; i += 1) {
      events.push({ type: `ev-${i}`, timestamp: i, message: longLine });
    }
    const manyOutputs = Array.from({ length: 20 }, (_, i) => `out-${i}-` + longLine);
    writeRun(
      root,
      "limited",
      {
        mode: "single",
        state: "running",
        startedAt: 1,
        lastUpdate: 2,
        activityState: "active_long_running",
        outputFile: "output-0.log",
        steps: [
          {
            agent: "w",
            status: "running",
            recentOutput: manyOutputs,
          },
        ],
      },
      {
        events,
        output: "HEAD\n" + "z".repeat(40 * 1024) + "\nTAIL-LINE\n",
      },
    );

    const dir = path.join(root, "limited");
    const before = snapshotMtimes(dir);
    const res = listSubagentRuns({ root });
    const after = snapshotMtimes(dir);

    assert.deepEqual(after, before);
    assert.equal(
      res.runs.some((r) => r.id === "huge-status"),
      false,
    );
    const limited = res.runs.find((r) => r.id === "limited");
    assert.ok(limited);
    assert.ok(limited.recentEvents.length <= MAX_EVENTS_PARSE);
    assert.ok(limited.steps[0].recentOutput.length <= MAX_RECENT_OUTPUT_ITEMS);
    for (const item of limited.steps[0].recentOutput) {
      assert.ok(item.length <= MAX_RECENT_OUTPUT_ITEM_CHARS);
    }
    assert.ok(limited.outputTail);
    assert.equal(limited.outputTruncated, true);
    assert.match(limited.outputTail, /TAIL-LINE/);
    // 只读：不写任何文件
    assert.equal(fs.readdirSync(dir).includes("status.json"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("根不存在返回 empty + rootAvailable false", async () => {
  const { listSubagentRuns } = await load();
  const missing = path.join(os.tmpdir(), "pi-sar-missing-" + Date.now() + "-nope");
  const res = listSubagentRuns({ root: missing, now: () => 42 });
  assert.deepEqual(res, {
    runs: [],
    generatedAt: 42,
    rootAvailable: false,
  });
});

test("非法 run 目录名跳过；枚举安全", async () => {
  const { listSubagentRuns, RUN_ID_RE } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sar-name-"));
  try {
    writeRun(root, "valid_id-1", {
      mode: "single",
      state: "complete",
      startedAt: 1,
    });
    // 含点/斜杠类名不会作为目录名创建成功；用不安全字符
    fs.mkdirSync(path.join(root, "has space"));
    fs.writeFileSync(
      path.join(root, "has space", "status.json"),
      JSON.stringify({
        runId: "has space",
        mode: "single",
        state: "complete",
        startedAt: 1,
      }),
    );
    assert.equal(RUN_ID_RE.test("has space"), false);
    assert.equal(RUN_ID_RE.test("valid_id-1"), true);

    const res = listSubagentRuns({ root });
    assert.equal(res.runs.length, 1);
    assert.equal(res.runs[0].id, "valid_id-1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hasActiveSubagentRunForSession：按父会话路径前缀判定归属 + 状态 + 陈旧上限", async () => {
  const { hasActiveSubagentRunForSession, SUBAGENT_RUN_STALE_MS } = await load();
  const parent = "/a/sessions/--repo--/2026-01-01T00-00-00-000Z_aaaa.jsonl";
  const run = (state, sessionFile, updatedAt = 1_000_000) => ({
    id: "r", state, mode: "single", startedAt: updatedAt, lastUpdate: updatedAt,
    steps: [{ index: 0, agent: "worker", status: state, sessionFile }],
  });
  // 三种子代理布局都算本会话名下
  assert.equal(hasActiveSubagentRunForSession([run("running", "/a/sessions/--repo--/2026-01-01T00-00-00-000Z_aaaa/12345678/run-0/session.jsonl")], parent, 1_000_100), true);
  assert.equal(hasActiveSubagentRunForSession([run("running", "/a/sessions/--repo--/2026-01-01T00-00-00-000Z_aaaa/async-46d5cf17-e060-4a2b-84f9-22ad398f6ace/x.jsonl")], parent, 1_000_100), true);
  assert.equal(hasActiveSubagentRunForSession([run("queued", "/a/sessions/--repo--/2026-01-01T00-00-00-000Z_aaaa/forks/2026-09-20T03-46-40-737Z_bbbb.jsonl")], parent, 1_000_100), true);
  // 已结束的状态不算
  for (const state of ["complete", "failed", "stopped", "paused-unknown"]) {
    assert.equal(hasActiveSubagentRunForSession([run(state, "/a/sessions/--repo--/2026-01-01T00-00-00-000Z_aaaa/forks/x.jsonl")], parent, 1_000_100), false, state);
  }
  // 别的会话（前缀相似但要按分隔符判定：`…aaaa-other` 不是本会话）不算
  assert.equal(hasActiveSubagentRunForSession([run("running", "/a/sessions/--repo--/2026-01-01T00-00-00-000Z_aaaa-other/forks/x.jsonl")], parent, 1_000_100), false);
  assert.equal(hasActiveSubagentRunForSession([run("running", "/b/other/forks/x.jsonl")], parent, 1_000_100), false);
  // 记录长时间没更新（进程被杀/残留）不再保活
  assert.equal(hasActiveSubagentRunForSession([run("running", "/a/sessions/--repo--/2026-01-01T00-00-00-000Z_aaaa/forks/x.jsonl")], parent, 1_000_000 + SUBAGENT_RUN_STALE_MS + 1), false);
  // 非会话文件 / 空输入
  assert.equal(hasActiveSubagentRunForSession([run("running", "/a/sessions/--repo--/2026-01-01T00-00-00-000Z_aaaa/forks/x.jsonl")], null, 1_000_100), false);
  assert.equal(hasActiveSubagentRunForSession(null, parent, 1_000_100), false);
});

test("attachDiscoveredSessionIds: 只读 child 附加 id；可写不附加", async () => {
  const { attachDiscoveredSessionIds } = await load();
  const sessionFile = "/home/u/.pi/agent/sessions/enc/sub-abc.jsonl";
  const response = {
    generatedAt: 1,
    rootAvailable: true,
    runs: [
      {
        id: "r1",
        state: "complete",
        mode: "single",
        startedAt: 1,
        steps: [
          { index: 0, agent: "a", status: "complete", sessionFile },
          { index: 1, agent: "b", status: "complete", sessionFile: "/other/path.jsonl" },
        ],
        recentEvents: [],
      },
    ],
  };
  const sessions = [
    { id: "sid-ro", path: sessionFile, readOnly: true },
    { id: "sid-rw", path: "/other/path.jsonl" }, // 无 readOnly，不附加
  ];
  const out = attachDiscoveredSessionIds(response, sessions);
  assert.equal(out.runs[0].steps[0].sessionId, "sid-ro");
  assert.equal(out.runs[0].steps[1].sessionId, undefined);
  // 可写即使 path 相同也不附加
  const onlyWritable = attachDiscoveredSessionIds(response, [
    { id: "sid-rw2", path: sessionFile },
  ]);
  assert.equal(onlyWritable.runs[0].steps[0].sessionId, undefined);
});

test("attachDiscoveredSessionIds: 路径规范化（Windows 大小写/分隔符）", async () => {
  const { attachDiscoveredSessionIds, normalizeSessionFilePath } = await load();
  assert.equal(
    normalizeSessionFilePath("C:\\Users\\A\\x.jsonl"),
    normalizeSessionFilePath("c:/Users/A/x.jsonl"),
  );
  assert.equal(
    normalizeSessionFilePath("/home/u/./a/../b.jsonl"),
    normalizeSessionFilePath("/home/u/b.jsonl"),
  );

  const response = {
    generatedAt: 1,
    rootAvailable: true,
    runs: [
      {
        id: "r1",
        state: "complete",
        mode: "single",
        startedAt: 1,
        steps: [
          {
            index: 0,
            agent: "a",
            status: "complete",
            sessionFile: "C:/Users/A/sub.jsonl",
          },
        ],
        recentEvents: [],
      },
    ],
  };
  const out = attachDiscoveredSessionIds(response, [
    { id: "win-id", path: "c:\\Users\\A\\sub.jsonl", readOnly: true },
  ]);
  assert.equal(out.runs[0].steps[0].sessionId, "win-id");
});

test("attachDiscoveredSessionIds: 不变异原 response / run / step", async () => {
  const { attachDiscoveredSessionIds } = await load();
  const step = {
    index: 0,
    agent: "a",
    status: "complete",
    sessionFile: "/path/to/s.jsonl",
  };
  const run = {
    id: "r1",
    state: "complete",
    mode: "single",
    startedAt: 1,
    steps: [step],
    recentEvents: [],
  };
  const response = { generatedAt: 1, rootAvailable: true, runs: [run] };
  const freezeStep = Object.freeze({ ...step });
  const freezeRun = Object.freeze({ ...run, steps: Object.freeze([freezeStep]) });
  const freezeRes = Object.freeze({
    generatedAt: 1,
    rootAvailable: true,
    runs: Object.freeze([freezeRun]),
  });

  const out = attachDiscoveredSessionIds(freezeRes, [
    { id: "id1", path: "/path/to/s.jsonl", readOnly: true },
  ]);
  assert.equal(out.runs[0].steps[0].sessionId, "id1");
  assert.equal(freezeStep.sessionId, undefined);
  assert.notEqual(out, freezeRes);
  assert.notEqual(out.runs[0], freezeRun);
  assert.notEqual(out.runs[0].steps[0], freezeStep);

  // 无匹配时返回同一引用
  const same = attachDiscoveredSessionIds(response, []);
  assert.equal(same, response);
  assert.equal(step.sessionId, undefined);
});

test("attachDiscoveredSessionIds: 无匹配 / 空列表不写 sessionId；清除误传 sessionId", async () => {
  const { attachDiscoveredSessionIds } = await load();
  const response = {
    generatedAt: 1,
    rootAvailable: true,
    runs: [
      {
        id: "r1",
        state: "complete",
        mode: "single",
        startedAt: 1,
        steps: [
          {
            index: 0,
            agent: "a",
            status: "complete",
            sessionFile: "/missing.jsonl",
            sessionId: "stale",
          },
          { index: 1, agent: "b", status: "complete" },
        ],
        recentEvents: [],
      },
    ],
  };
  const out = attachDiscoveredSessionIds(response, [
    { id: "other", path: "/other.jsonl", readOnly: true },
  ]);
  assert.equal(out.runs[0].steps[0].sessionId, undefined);
  assert.equal(out.runs[0].steps[0].sessionFile, "/missing.jsonl");
  assert.equal(out.runs[0].steps[1].sessionId, undefined);
});
