import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  projectTreeForResponse,
  hasBookmarkLabel,
  resolveNavigationLeafId,
  stripMetadataNodes,
} = await jiti.import("./session-reader.ts");

function node(id, children = [], label, type = "message") {
  return {
    entry: { id, type },
    children,
    ...(label !== undefined ? { label } : {}),
  };
}

test("hasBookmarkLabel 仅在非空字符串 label 时为真", () => {
  assert.equal(hasBookmarkLabel({ label: "bookmark" }), true);
  assert.equal(hasBookmarkLabel({ label: "" }), false);
  assert.equal(hasBookmarkLabel({}), false);
  assert.equal(hasBookmarkLabel({ label: undefined }), false);
});

test("resolveNavigationLeafId 上溯尾部 label 元数据到非 label 祖先", () => {
  const entries = [
    { id: "u1", type: "message", parentId: null },
    { id: "a1", type: "message", parentId: "u1" },
    { id: "lbl1", type: "label", parentId: "a1" },
    { id: "lbl2", type: "label", parentId: "lbl1" },
  ];
  assert.equal(resolveNavigationLeafId(entries, "lbl2"), "a1");
  assert.equal(resolveNavigationLeafId(entries, "a1"), "a1");
  assert.equal(resolveNavigationLeafId(entries, null), null);
  assert.equal(resolveNavigationLeafId(entries, "missing"), "missing");
});

test("stripMetadataNodes 提升 label 子节点并保留目标 node.label", () => {
  // a1(label=书签) → lbl → u2
  const u2 = node("u2");
  const lbl = node("lbl", [u2], undefined, "label");
  const a1 = node("a1", [lbl], "书签");
  const root = node("root", [a1]);

  const stripped = stripMetadataNodes([root]);
  assert.equal(stripped[0].children[0].entry.id, "a1");
  assert.equal(stripped[0].children[0].label, "书签");
  assert.equal(stripped[0].children[0].children.length, 1);
  assert.equal(stripped[0].children[0].children[0].entry.id, "u2");
  assert.equal(
    stripped[0].children[0].children.some((c) => c.entry.type === "label"),
    false,
  );
});

test("projectTreeForResponse 压缩无 label 的单链，保留有 label 的书签节点", () => {
  const leaf = node("leaf");
  const midLabeled = node("mid", [leaf], "重要分叉");
  const root = node("root", [midLabeled]);

  const projected = projectTreeForResponse([root]);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].entry.id, "root");
  assert.equal(projected[0].children.length, 1);
  assert.equal(projected[0].children[0].entry.id, "mid");
  assert.equal(projected[0].children[0].label, "重要分叉");
  assert.equal(projected[0].children[0].children.length, 1);
  assert.equal(projected[0].children[0].children[0].entry.id, "leaf");
});

test("projectTreeForResponse 无 label 时仍压缩单子链", () => {
  const leaf = node("leaf");
  const mid = node("mid", [leaf]);
  const root = node("root", [mid]);

  const projected = projectTreeForResponse([root]);
  assert.equal(projected[0].children.length, 1);
  const child = projected[0].children[0];
  assert.equal(child.entry.id, "leaf");
  assert.deepEqual(child.compressedEntryIds, ["mid"]);
});

test("projectTreeForResponse 保留分支点与叶子", () => {
  const a = node("a");
  const b = node("b");
  const root = node("root", [a, b]);
  const projected = projectTreeForResponse([root]);
  assert.equal(projected[0].children.map((c) => c.entry.id).sort().join(","), "a,b");
});
