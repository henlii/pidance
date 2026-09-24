import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  isEditToolName,
  isWriteToolName,
  isApplyPatchToolName,
  isFileWritingToolName,
} = await jiti.import("./tool-names.ts");

test("edit 系判定：内置与常见扩展变体", () => {
  for (const name of ["edit", "Edit", "edit_file", "file.edit", "str_replace_editor", "replace_editor"]) {
    assert.equal(isEditToolName(name), true, `${name} 应算 edit 系`);
  }
  for (const name of ["bash", "read", "write", "apply_patch", "ask_user_question"]) {
    assert.equal(isEditToolName(name), false, `${name} 不应算 edit 系`);
  }
});

test("write 系判定：内置与常见变体", () => {
  for (const name of ["write", "write_file", "file.write", "create_file"]) {
    assert.equal(isWriteToolName(name), true, `${name} 应算 write 系`);
  }
  for (const name of ["edit", "bash", "read", "apply_patch"]) {
    assert.equal(isWriteToolName(name), false, `${name} 不应算 write 系`);
  }
});

test("apply_patch 判定带前缀也算，写入类只认这三个工具", () => {
  assert.equal(isApplyPatchToolName("apply_patch"), true);
  assert.equal(isApplyPatchToolName("pi-apply_patch"), true);
  assert.equal(isApplyPatchToolName("patch"), false);

  assert.equal(isFileWritingToolName("edit"), true);
  assert.equal(isFileWritingToolName("write"), true);
  assert.equal(isFileWritingToolName("apply_patch"), true);
  // bash 里的重定向/就地编辑不在列：从命令文本猜写入目标不可靠
  assert.equal(isFileWritingToolName("bash"), false);
  assert.equal(isFileWritingToolName("read"), false);
  assert.equal(isFileWritingToolName("subagent"), false);
});
