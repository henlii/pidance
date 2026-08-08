/**
 * 分支标签导航投影（不依赖 @earendil-works/pi-coding-agent）。
 *
 * 用自有 SessionFile 构造与 Pi 等价的树语义（label entry 推进 leaf、open 后
 * leaf = 文件最后一条、append 挂当前 leaf），验证 session-reader 的导航投影：
 * resolveNavigationLeafId / stripLabelMetadataNodes / projectTreeForResponse。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionFile, openSessionFile } = await jiti.import("./session-file.ts");
const {
  resolveNavigationLeafId,
  stripLabelMetadataNodes,
  projectTreeForResponse,
} = await jiti.import("./session-reader.ts");

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

/** 从 entries 建树（对齐 SDK getTree 形状：label 附着到 target 节点）。 */
function buildTree(entries) {
  const nodes = new Map();
  for (const e of entries) {
    if (e.type === "session") continue;
    nodes.set(e.id, { entry: e, children: [] });
  }
  const roots = [];
  for (const e of entries) {
    if (e.type === "session") continue;
    const node = nodes.get(e.id);
    const parentId = e.parentId;
    if (parentId && nodes.has(parentId)) nodes.get(parentId).children.push(node);
    else roots.push(node);
  }
  for (const e of entries) {
    if (e.type === "label" && typeof e.targetId === "string") {
      const target = nodes.get(e.targetId);
      if (target) target.label = e.label;
    }
  }
  return roots;
}

function collectIds(nodes, out = []) {
  for (const n of nodes) {
    out.push({ id: n.entry.id, type: n.entry.type, label: n.label });
    collectIds(n.children, out);
  }
  return out;
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.entry.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

/** 模拟 sessions GET 的导航投影：derived leaf + strip label + project */
function navigationView(sm) {
  const entries = sm.getEntries();
  const rawLeaf = sm.getLeafId();
  const leafId = resolveNavigationLeafId(entries, rawLeaf);
  const tree = projectTreeForResponse(stripLabelMetadataNodes(buildTree(entries)));
  return { entries, rawLeaf, leafId, tree };
}

test("SessionFile：set→modify→clear 后导航 leaf 稳定在 target，树无 label 假分支", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-label-nav-"));
  try {
    const sm = SessionFile.create("/tmp", dir);
    const u1 = sm.appendMessage({ role: "user", content: "start" });
    const a1 = sm.appendMessage(assistantMessage("reply"));
    sm.branch(a1); // 强制落盘

    // set
    const setId = sm.appendLabelChange(a1, "书签A");
    assert.equal(sm.getLeafId(), setId);
    assert.equal(sm.getEntry(setId)?.type, "label");
    assert.equal(sm.getLabel(a1), "书签A");

    let view = navigationView(sm);
    assert.equal(view.rawLeaf, setId);
    assert.equal(view.leafId, a1, "导航 leaf 应为被标记的 target，不是 label entry");
    assert.equal(findNode(view.tree, a1)?.label, "书签A");
    assert.equal(
      collectIds(view.tree).some((n) => n.type === "label"),
      false,
      "投影树不得含可点击 label 元数据节点",
    );
    assert.ok(findNode(view.tree, a1), "原 entry 仍在树中");
    assert.equal(findNode(view.tree, setId), null);

    // modify
    const modId = sm.appendLabelChange(a1, "书签B");
    view = navigationView(sm);
    assert.equal(sm.getLabel(a1), "书签B");
    assert.equal(view.rawLeaf, modId);
    assert.equal(view.leafId, a1);
    assert.equal(findNode(view.tree, a1)?.label, "书签B");
    assert.equal(collectIds(view.tree).some((n) => n.type === "label"), false);

    // clear
    const clearId = sm.appendLabelChange(a1, undefined);
    view = navigationView(sm);
    assert.equal(sm.getLabel(a1), undefined);
    assert.equal(view.rawLeaf, clearId);
    assert.equal(view.leafId, a1, "清除后仍以原 target 为当前点");
    assert.equal(findNode(view.tree, a1)?.label, undefined);
    assert.equal(collectIds(view.tree).some((n) => n.type === "label"), false);

    // JSONL 历史 label entry 仍保留
    const lines = readFileSync(sm.getSessionFile(), "utf8").trim().split("\n");
    const labelLines = lines.filter((line) => {
      try {
        return JSON.parse(line).type === "label";
      } catch {
        return false;
      }
    });
    assert.equal(labelLines.length, 3, "set/modify/clear 三条 label 历史保留");
    assert.ok(sm.getEntry(setId));
    assert.ok(sm.getEntry(modId));
    assert.ok(sm.getEntry(clearId));
    assert.ok(sm.getEntry(u1));
    assert.ok(sm.getEntry(a1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionFile：open 后 leaf 仍是 label entry，导航派生回 target", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-label-open-"));
  try {
    const sm = SessionFile.create("/tmp", dir);
    sm.appendMessage({ role: "user", content: "start" });
    const a1 = sm.appendMessage(assistantMessage("reply"));
    const labelId = sm.appendLabelChange(a1, "persist");
    const file = sm.getSessionFile();

    const reopened = openSessionFile(file);
    assert.equal(reopened.getLeafId(), labelId);
    assert.equal(reopened.getEntry(reopened.getLeafId())?.type, "label");
    assert.equal(reopened.getLabel(a1), "persist");

    const view = navigationView(reopened);
    assert.equal(view.leafId, a1);
    assert.equal(findNode(view.tree, a1)?.label, "persist");
    assert.equal(collectIds(view.tree).some((n) => n.type === "label"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionFile：label 后追加消息时导航路径不丢真实 message", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-label-msg-"));
  try {
    const sm = SessionFile.create("/tmp", dir);
    sm.appendMessage({ role: "user", content: "start" });
    const a1 = sm.appendMessage(assistantMessage("reply"));
    const labelId = sm.appendLabelChange(a1, "bm");
    // 与 Pi 语义一致：下一条消息挂在 label entry 下
    const u2 = sm.appendMessage({ role: "user", content: "continue after label" });
    assert.equal(sm.getEntry(u2)?.parentId, labelId);

    const view = navigationView(sm);
    assert.equal(view.leafId, u2, "当前消息 leaf 保持为真实 user message");
    assert.ok(findNode(view.tree, a1), "target 仍在");
    assert.ok(findNode(view.tree, u2), "后续消息不得被 strip 掉");
    assert.equal(findNode(view.tree, a1)?.label, "bm");
    // a1 的子节点应直接是 u2（label 被提升）
    const a1Node = findNode(view.tree, a1);
    assert.ok(a1Node.children.some((c) => c.entry.id === u2));
    assert.equal(collectIds(view.tree).some((n) => n.type === "label"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
