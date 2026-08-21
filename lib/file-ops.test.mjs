import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const load = () => jiti.import("./file-ops.ts");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-ops-"));
  return {
    root,
    clean: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("validateEntryName 拒绝路径分隔；不再限制受保护名/环境文件", async () => {
  const { validateEntryName } = await load();
  assert.match(validateEntryName(""), /Invalid/);
  assert.match(validateEntryName(".."), /Invalid/);
  assert.match(validateEntryName("a/b"), /path/);
  assert.equal(validateEntryName("node_modules"), null);
  assert.equal(validateEntryName(".env"), null);
  assert.equal(validateEntryName("note.txt"), null);
  assert.equal(validateEntryName(".env.example"), null);
});

test("createEmptyFile / createDirectory 成功并拒绝覆盖；访问范围已放开，越权不再拒绝", async () => {
  const {
    createEmptyFile,
    createDirectory,
    FileOpsError,
  } = await load();
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-ops-out-"));
  try {
    const file = createEmptyFile(f.root, "a.txt", new Set([f.root]));
    assert.equal(fs.readFileSync(file.path, "utf8"), "");
    assert.throws(
      () => createEmptyFile(f.root, "a.txt", new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "conflict",
    );

    const dir = createDirectory(f.root, "subdir", new Set([f.root]));
    assert.equal(fs.statSync(dir.path).isDirectory(), true);
    assert.throws(
      () => createDirectory(f.root, "subdir", new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "conflict",
    );

    // 访问范围已放开：目标目录不在 allow-list 也允许创建
    const outsideFile = createEmptyFile(outside, "x.txt", new Set([f.root]));
    assert.equal(fs.existsSync(outsideFile.path), true);
  } finally {
    f.clean();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("renameEntry 同目录改名并拒绝冲突/symlink", async () => {
  const { renameEntry, FileOpsError } = await load();
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-ops-out2-"));
  try {
    const src = path.join(f.root, "old.txt");
    fs.writeFileSync(src, "hi");
    const renamed = renameEntry(src, "new.txt", new Set([f.root]));
    assert.equal(path.basename(renamed.path), "new.txt");
    assert.equal(fs.readFileSync(renamed.path, "utf8"), "hi");
    assert.equal(fs.existsSync(src), false);

    fs.writeFileSync(path.join(f.root, "taken.txt"), "x");
    assert.throws(
      () => renameEntry(renamed.path, "taken.txt", new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "conflict",
    );

    fs.symlinkSync(outside, path.join(f.root, "link"));
    assert.throws(
      () => renameEntry(path.join(f.root, "link"), "link2", new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "forbidden",
    );
  } finally {
    f.clean();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("moveEntry 跨目录移动文件/目录并拒绝冲突/自嵌套/symlink", async () => {
  const { moveEntry, FileOpsError } = await load();
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-ops-move-"));
  try {
    const dirA = path.join(f.root, "a");
    const dirB = path.join(f.root, "b");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.writeFileSync(path.join(dirA, "f.txt"), "content");

    const moved = moveEntry(path.join(dirA, "f.txt"), dirB, new Set([f.root]));
    assert.equal(path.join(dirB, "f.txt"), moved.path);
    assert.equal(fs.existsSync(path.join(dirA, "f.txt")), false);
    assert.equal(fs.readFileSync(moved.path, "utf8"), "content");

    // 目录移动
    fs.mkdirSync(path.join(f.root, "sub"));
    fs.writeFileSync(path.join(f.root, "sub", "x.txt"), "x");
    moveEntry(path.join(f.root, "sub"), dirB, new Set([f.root]));
    assert.equal(fs.existsSync(path.join(dirB, "sub", "x.txt")), true);

    // 目标已存在 → conflict
    fs.writeFileSync(path.join(dirB, "taken.txt"), "t");
    fs.writeFileSync(path.join(dirA, "taken.txt"), "s");
    assert.throws(
      () => moveEntry(path.join(dirA, "taken.txt"), dirB, new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "conflict",
    );

    // 目录不可移入自身
    fs.mkdirSync(path.join(f.root, "self"));
    fs.mkdirSync(path.join(f.root, "self", "inner"));
    assert.throws(
      () => moveEntry(path.join(f.root, "self"), path.join(f.root, "self", "inner"), new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "bad-request",
    );

    // symlink 源拒绝
    fs.symlinkSync(outside, path.join(f.root, "slink"));
    assert.throws(
      () => moveEntry(path.join(f.root, "slink"), dirB, new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "forbidden",
    );
  } finally {
    f.clean();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("copyEntry 复制文件/目录并保留源、拒绝冲突；访问范围已放开，越权目标不再拒绝", async () => {
  const { copyEntry, FileOpsError } = await load();
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-ops-copy-"));
  try {
    const dirA = path.join(f.root, "a");
    const dirB = path.join(f.root, "b");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.writeFileSync(path.join(dirA, "f.txt"), "content");
    fs.mkdirSync(path.join(dirA, "nested"));
    fs.writeFileSync(path.join(dirA, "nested", "deep.txt"), "deep");

    const copied = copyEntry(path.join(dirA, "f.txt"), dirB, new Set([f.root]));
    assert.equal(path.join(dirB, "f.txt"), copied.path);
    assert.equal(fs.readFileSync(copied.path, "utf8"), "content");
    assert.equal(fs.existsSync(path.join(dirA, "f.txt")), true); // 源保留

    const dirCopied = copyEntry(dirA, dirB, new Set([f.root]));
    assert.equal(path.join(dirB, "a", "nested", "deep.txt"), dirCopied.path.replace(/a$/, "a") + "/nested/deep.txt");
    assert.equal(fs.readFileSync(path.join(dirB, "a", "nested", "deep.txt"), "utf8"), "deep");

    // 目标已存在 → conflict
    fs.writeFileSync(path.join(dirB, "again.txt"), "t");
    fs.writeFileSync(path.join(dirA, "again.txt"), "s");
    assert.throws(
      () => copyEntry(path.join(dirA, "again.txt"), dirB, new Set([f.root])),
      (e) => e instanceof FileOpsError && e.code === "conflict",
    );

    // 访问范围已放开：目标目录不在 allow-list 也允许复制
    const outsideCopied = copyEntry(path.join(dirA, "f.txt"), outside, new Set([f.root]));
    assert.equal(fs.existsSync(outsideCopied.path), true);
    assert.equal(fs.readFileSync(outsideCopied.path, "utf8"), "content");
  } finally {
    f.clean();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
