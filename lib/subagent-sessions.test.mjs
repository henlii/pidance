import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  discoverSubagentSessions,
  collectSubagentTree,
  deleteValidatedSubagents,
  SUBAGENT_DISCOVERY_LIMITS,
} = await jiti.import("./subagent-sessions.ts");

const header = (id) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/tmp" });
async function child(root, id, index, parentId) {
  await mkdir(join(root, `${parentId}`, "12345678", `run-${index}`), { recursive: true });
  const path = join(root, `${parentId}`, "12345678", `run-${index}`, "session.jsonl");
  await writeFile(path, `${header(id)}\n`, "utf8");
  return path;
}

function toolResult(results, details = {}) {
  return JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { ...details, results } } });
}

async function metadataChild(root, parentId, id, index, runId = "12345678") {
  const path = join(root, parentId, runId, `run-${index}`, "session.jsonl");
  await mkdir(join(root, parentId, runId, `run-${index}`), { recursive: true });
  await writeFile(path, `${header(id)}\n`, "utf8");
  return path;
}

test("只发现严格布局的直接子代理并递归挂接孙代理", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    await writeFile(parent, `${header("parent")}\n`, "utf8");
    const first = await child(root, "child", 2, "parent");
    const childRoot = first.slice(0, -"/session.jsonl".length);
    const nestedParent = join(childRoot, "session.jsonl");
    const grandRoot = join(childRoot, "session");
    await writeFile(nestedParent, `${header("child")}\n${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: [{ sessionFile: join(grandRoot, "87654321", "run-0", "session.jsonl") }] } } })}\n`, "utf8");
    await mkdir(join(grandRoot, "87654321", "run-0"), { recursive: true });
    await writeFile(join(grandRoot, "87654321", "run-0", "session.jsonl"), `${header("grand")}\n`, "utf8");
    await writeFile(parent, `${header("parent")}\n${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: [{ sessionFile: first }] } } })}\n`, "utf8");
    assert.deepEqual(collectSubagentTree(parent, "parent").map((x) => x.header.id), ["child", "grand"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("路径越界、symlink 和损坏 header 安全忽略", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    await writeFile(parent, `${header("parent")}\n`, "utf8");
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, `${header("outside")}\n`, "utf8");
    await mkdir(join(root, "parent", "12345678", "run-0"), { recursive: true });
    await symlink(outside, join(root, "parent", "12345678", "run-0", "session.jsonl"));
    await writeFile(parent, `${header("parent")}\n${JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "subagent", details: { results: [{ sessionFile: outside }] } } })}\n`, "utf8");
    assert.equal(discoverSubagentSessions(parent, "parent").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("并行 child 使用物理 run-N，管理空结果和缺失 sessionFile 会忽略", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    const one = await metadataChild(root, "parent", "one", 7);
    const two = await metadataChild(root, "parent", "two", 1, "abcdef12");
    await writeFile(parent, `${header("parent")}\n${toolResult([])}\n${toolResult([{ nope: true }, { sessionFile: one }])}\n${toolResult([{ sessionFile: two }])}\n`, "utf8");
    const found = discoverSubagentSessions(parent, "parent");
    assert.deepEqual(found.map((x) => [x.header.id, x.runIndex]), [["one", 7], ["two", 1]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("损坏 metadata 回退严格扫描，普通 fork 不会伪装 subagent", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    const path = await metadataChild(root, "parent", "fallback", 0);
    await writeFile(parent, `${header("parent")}\nnot-json\n`, "utf8");
    assert.equal(discoverSubagentSessions(parent, "parent")[0].header.id, "fallback");
    await writeFile(join(root, "fork.jsonl"), `${JSON.stringify({ ...JSON.parse(header("fork")), parentSession: parent })}\n`, "utf8");
    assert.equal(discoverSubagentSessions(join(root, "fork.jsonl"), "fork").length, 0);
    assert.match(path, /run-0[\\/]session\.jsonl$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("重复 path/id、跨父根 id 和祖先循环只保留安全直接关系", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    const other = join(root, "other.jsonl");
    const same = await metadataChild(root, "parent", "same", 0);
    await writeFile(parent, `${header("parent")}\n${toolResult([{ sessionFile: same }, { sessionFile: same }])}\n`, "utf8");
    await writeFile(other, `${header("other")}\n${toolResult([{ sessionFile: same }])}\n`, "utf8");
    assert.equal(discoverSubagentSessions(parent, "parent").length, 1);
    assert.equal(discoverSubagentSessions(other, "other").length, 0);
    await writeFile(same, `${JSON.stringify({ ...JSON.parse(header("parent")), parentSession: parent })}\n`, "utf8");
    assert.equal(collectSubagentTree(parent, "parent").length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("删除 helper 只删除再次验证的 child，保留未知文件和 symlink，并统计跳过", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parentRoot = join(root, "parent");
    const valid = await metadataChild(root, "parent", "valid", 0);
    const changed = await metadataChild(root, "parent", "changed", 1);
    const unknown = join(root, "parent", "12345678", "unknown.txt");
    await writeFile(unknown, "keep", "utf8");
    await writeFile(changed, `${header("other")}\n`, "utf8");
    const invalidated = [];
    const invalidatedFiles = [];
    const children = [{ path: valid, header: JSON.parse(header("valid")), runIndex: 0, parentSessionId: "parent", runId: "12345678" }, { path: changed, header: JSON.parse(header("changed")), runIndex: 1, parentSessionId: "parent", runId: "12345678" }];
    const skipped = deleteValidatedSubagents(children, parentRoot, (id) => invalidated.push(id), (file) => invalidatedFiles.push(file));
    assert.equal(skipped, 1);
    assert.deepEqual(invalidated, ["valid"]);
    assert.deepEqual(invalidatedFiles, [valid], "只读视图缓存按文件路径失效，删掉的文件不留已解析视图");
    await mkdir(join(root, "parent", "12345678", "run-0"), { recursive: true });
    await writeFile(valid, `${header("valid")}\n`, "utf8");
    const link = join(root, "parent", "abcdef12", "run-2", "session.jsonl");
    await mkdir(join(root, "parent", "abcdef12", "run-2"), { recursive: true });
    await symlink(valid, link);
    const skippedLink = deleteValidatedSubagents([{ ...children[0], path: link }], parentRoot, () => {});
    assert.equal(skippedLink, 1);
    await access(unknown);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("发现上限公开为测试可验证的固定边界", () => {
  assert.equal(SUBAGENT_DISCOVERY_LIMITS.maxChildren, 256);
  assert.equal(SUBAGENT_DISCOVERY_LIMITS.maxDepth, 16);
  assert.equal(SUBAGENT_DISCOVERY_LIMITS.maxScanEntries, 2048);
  assert.equal(SUBAGENT_DISCOVERY_LIMITS.maxMetadataCandidates, 512);
});


test("async 布局（<parentRoot>/async-<uuid>/*.jsonl 扁平）被发现且 runId 取自目录名", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    const asyncId = "46d5cf17-e060-4a2b-84f9-22ad398f6ace";
    const asyncRoot = join(root, "parent", `async-${asyncId}`);
    await mkdir(asyncRoot, { recursive: true });
    const first = join(asyncRoot, "2026-07-31T09-15-04-651Z_019fb774-ac4b-75bf-9e0c-3fb4b546dcd4.jsonl");
    const second = join(asyncRoot, "2026-07-31T09-16-00-000Z_019fb774-ac4b-75bf-9e0c-3fb4b546dcd5.jsonl");
    await writeFile(first, `${header("first")}\n`, "utf8");
    await writeFile(second, `${header("second")}\n`, "utf8");
    await writeFile(parent, `${header("parent")}\n`, "utf8");
    const found = discoverSubagentSessions(parent, "parent");
    assert.deepEqual(found.map((x) => [x.header.id, x.runId, x.runIndex]), [
      ["first", asyncId, 0],
      ["second", asyncId, 0],
    ]);
    assert.match(found[0].path, /async-46d5cf17-e060-4a2b-84f9-22ad398f6ace[\\/]2026-07-31T09-15-04/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fork 上下文布局（<parentRoot>/forks/<时间戳>_<id>.jsonl）被发现", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    // pi-subagents 把 context: fork 的子会话写在这里；父会话 JSONL 没有 sessionFile 元数据，
    // 只能靠目录扫描发现（回归：曾经完全发现不到 → 子会话不在谱系下拉里、也没有运行状态）
    const forksRoot = join(root, "parent", "forks");
    await mkdir(forksRoot, { recursive: true });
    const first = join(forksRoot, "2026-09-20T03-46-40-737Z_01a0bcec-57e1-752c-bc8c-75835cee6a83.jsonl");
    const second = join(forksRoot, "2026-09-20T07-03-22-409Z_01a0bda0-6c28-752c-bc8c-7585e68314b0.jsonl");
    await writeFile(first, `${header("fork-a")}\n`, "utf8");
    await writeFile(second, `${header("fork-b")}\n`, "utf8");
    await writeFile(parent, `${header("parent")}\n`, "utf8");

    const found = discoverSubagentSessions(parent, "parent");
    assert.deepEqual(found.map((x) => [x.header.id, x.runIndex, x.parentSessionId]), [
      ["fork-a", 0, "parent"],
      ["fork-b", 0, "parent"],
    ]);
    // 扁平布局没有 run 目录：runId 用文件名（<时间戳>_<id>）标识
    assert.equal(found[0].runId, "2026-09-20T03-46-40-737Z_01a0bcec-57e1-752c-bc8c-75835cee6a83");
    assert.match(found[0].path, /forks[\\/]2026-09-20T03-46-40-737Z_/);

    // 用户自己在 Pidance 的 fork 是同级文件，不是子代理会话
    await writeFile(join(root, "user-fork.jsonl"), `${header("user-fork")}\n`, "utf8");
    assert.equal(discoverSubagentSessions(parent, "parent").some((x) => x.header.id === "user-fork"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("async 与 sync 混合发现，非 uuid 目录名与 symlink 安全忽略", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    const asyncId = "aa528b4d-ed67-4d52-910d-69a9908bdfd1";
    const asyncRoot = join(root, "parent", `async-${asyncId}`);
    await mkdir(asyncRoot, { recursive: true });
    const asyncFile = join(asyncRoot, "2026-07-31T10-00-00-000Z_019fb777-ac4b-75bf-9e0c-3fb4b546dcd6.jsonl");
    await writeFile(asyncFile, `${header("async-child")}\n`, "utf8");
    const sync = await metadataChild(root, "parent", "sync-child", 3);
    // 非 uuid 目录名（如 async-foo）不构成 async 布局
    await mkdir(join(root, "parent", "async-not-a-uuid"), { recursive: true });
    // 越界 symlink 在 async 布局下同样拒绝
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, `${header("outside")}\n`, "utf8");
    await symlink(outside, join(asyncRoot, "evil.jsonl"));
    await writeFile(parent, `${header("parent")}\n`, "utf8");
    const found = discoverSubagentSessions(parent, "parent");
    assert.deepEqual(found.map((x) => x.header.id).sort(), ["async-child", "sync-child"]);
    const asyncHit = found.find((x) => x.header.id === "async-child");
    assert.equal(asyncHit.runId, asyncId);
    assert.equal(asyncHit.runIndex, 0);
    assert.ok(found.every((x) => x.header.id !== "outside"));
    void sync;
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("collectSubagentTree 递归包含 async 孙代", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    const asyncId = "bb528b4d-ed67-4d52-910d-69a9908bdfd1";
    const childRoot = join(root, "parent", `async-${asyncId}`);
    await mkdir(childRoot, { recursive: true });
    const childFile = join(childRoot, "2026-07-31T11-00-00-000Z_019fb788-ac4b-75bf-9e0c-3fb4b546dcd7.jsonl");
    await writeFile(childFile, `${header("async-child")}\n`, "utf8");
    // 孙代用 async 布局挂在子会话文件同名目录（<childBasename>）下
    const grandAsyncId = "cc528b4d-ed67-4d52-910d-69a9908bdfd1";
    const grandRoot = join(childRoot, "2026-07-31T11-00-00-000Z_019fb788-ac4b-75bf-9e0c-3fb4b546dcd7", `async-${grandAsyncId}`);
    await mkdir(grandRoot, { recursive: true });
    await writeFile(join(grandRoot, "2026-07-31T11-30-00-000Z_019fb799-ac4b-75bf-9e0c-3fb4b546dcd8.jsonl"), `${header("grand")}\n`, "utf8");
    await writeFile(parent, `${header("parent")}\n`, "utf8");
    assert.deepEqual(collectSubagentTree(parent, "parent").map((x) => x.header.id), ["async-child", "grand"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("0.68.0 的 UUID run 目录（同步/异步共用布局）也能发现", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    await writeFile(parent, `${header("parent")}\n`, "utf8");
    const runId = "80f798cf-fc06-45bf-9c67-fb6750c50d42";
    await mkdir(join(root, "parent", runId, "run-0"), { recursive: true });
    await writeFile(join(root, "parent", runId, "run-0", "session.jsonl"), `${header("child-uuid")}\n`, "utf8");
    const found = discoverSubagentSessions(parent, "parent");
    assert.deepEqual(found.map((c) => [c.header.id, c.runId, c.runIndex]), [["child-uuid", runId, 0]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("0.68.0 同步 toolResult 缺少 sessionFile 时，用 details.runId 补 agent 标签", async () => {
  const root = await mkdtemp(join(tmpdir(), "pidance-subagent-"));
  try {
    const parent = join(root, "parent.jsonl");
    const runId = "80f798cf-fc06-45bf-9c67-fb6750c50d42";
    await writeFile(parent, `${header("parent")}\n${toolResult([{ index: 0, agent: "scout" }], { mode: "single", runId })}\n`, "utf8");
    await mkdir(join(root, "parent", runId, "run-0"), { recursive: true });
    await writeFile(join(root, "parent", runId, "run-0", "session.jsonl"), `${header("child-sync")}\n`, "utf8");
    const found = discoverSubagentSessions(parent, "parent");
    assert.deepEqual(found.map((c) => [c.header.id, c.agent]), [["child-sync", "scout"]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
