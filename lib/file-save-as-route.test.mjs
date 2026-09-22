/**
 * 「另存为」：源文件必须存在且是普通文件，目标目录必须存在且是目录；
 * 同名**不覆盖**（自动加 ` (n)` 后缀），源文件保持不动。
 *
 * 这层的价值在于「拷贝一份」这条语义：既不能变成移动，也不能悄悄盖掉别人的同名文件。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { POST: saveAs } = await jiti.import("../app/api/files/save-as/route.ts");
const { saveFileAs, uniqueCopyName, FileOpsError } = await jiti.import("./file-ops.ts");

function post(body) {
  return saveAs(new Request("http://localhost/api/files/save-as", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pidance-save-as-"));
  const sourceDir = join(root, "src");
  const targetDir = join(root, "dst");
  for (const dir of [sourceDir, targetDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    root,
    sourceDir,
    targetDir,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("uniqueCopyName：优先原名，其次 name (1).ext；已带序号的名字继续往后编号", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-name-"));
  try {
    assert.equal(uniqueCopyName(root, "pic.png"), "pic.png");
    writeFileSync(join(root, "pic.png"), "a");
    assert.equal(uniqueCopyName(root, "pic.png"), "pic (1).png");
    writeFileSync(join(root, "pic (1).png"), "b");
    assert.equal(uniqueCopyName(root, "pic.png"), "pic (2).png");
    // 已带序号的输入不再叠加：pic (1).png → pic (2).png 而不是 pic (1) (1).png
    assert.equal(uniqueCopyName(root, "pic (1).png"), "pic (2).png");
    // 无扩展名：序号接在末尾
    writeFileSync(join(root, "note"), "c");
    assert.equal(uniqueCopyName(root, "note"), "note (1)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("saveFileAs：复制一份到目标目录，原文件保留、内容一致", () => {
  const f = fixture();
  try {
    const source = join(f.sourceDir, "pic.png");
    writeFileSync(source, "PNGDATA");
    const result = saveFileAs(source, f.targetDir);
    assert.equal(result.name, "pic.png");
    assert.equal(result.path, join(f.targetDir, "pic.png"));
    assert.equal(readFileSync(result.path, "utf8"), "PNGDATA");
    // 原文件仍在原位
    assert.equal(existsSync(source), true);
    assert.equal(readFileSync(source, "utf8"), "PNGDATA");
  } finally {
    f.clean();
  }
});

test("saveFileAs：同名不覆盖，第二次存成 pic (1).png", () => {
  const f = fixture();
  try {
    const source = join(f.sourceDir, "pic.png");
    writeFileSync(source, "FIRST");
    saveFileAs(source, f.targetDir);
    writeFileSync(source, "SECOND");
    const second = saveFileAs(source, f.targetDir);
    assert.equal(second.name, "pic (1).png");
    // 第一份没被改写
    assert.equal(readFileSync(join(f.targetDir, "pic.png"), "utf8"), "FIRST");
    assert.equal(readFileSync(second.path, "utf8"), "SECOND");
  } finally {
    f.clean();
  }
});

test("saveFileAs：目录不能另存（只接受普通文件），符号链接源被拒绝", () => {
  const f = fixture();
  try {
    assert.throws(
      () => saveFileAs(f.sourceDir, f.targetDir),
      (e) => e instanceof FileOpsError && e.code === "bad-request",
    );
    const source = join(f.sourceDir, "pic.png");
    writeFileSync(source, "X");
    const link = join(f.sourceDir, "link.png");
    symlinkSync(source, link);
    assert.throws(
      () => saveFileAs(link, f.targetDir),
      (e) => e instanceof FileOpsError && e.code === "forbidden",
    );
  } finally {
    f.clean();
  }
});

test("saveFileAs：目标必须是存在的目录；源必须存在", () => {
  const f = fixture();
  try {
    const source = join(f.sourceDir, "pic.png");
    writeFileSync(source, "X");
    const fileTarget = join(f.root, "not-a-dir.txt");
    writeFileSync(fileTarget, "t");
    assert.throws(
      () => saveFileAs(source, fileTarget),
      (e) => e instanceof FileOpsError && e.code === "bad-request",
    );
    assert.throws(
      () => saveFileAs(source, join(f.root, "missing-dir")),
      (e) => e instanceof FileOpsError && e.code === "not-found",
    );
    assert.throws(
      () => saveFileAs(join(f.sourceDir, "missing.png"), f.targetDir),
      (e) => e instanceof FileOpsError && e.code === "not-found",
    );
  } finally {
    f.clean();
  }
});

test("路由：成功返回落盘路径；缺参 400、源不存在 404、源是目录 400", async () => {
  const f = fixture();
  try {
    const source = join(f.sourceDir, "pic.png");
    writeFileSync(source, "ROUTE");
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ path: source })).status, 400);
    assert.equal((await post({ path: source, targetDirectory: join(f.root, "nope") })).status, 404);
    assert.equal((await post({ path: f.sourceDir, targetDirectory: f.targetDir })).status, 400);

    const ok = await post({ path: source, targetDirectory: f.targetDir });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.path, join(f.targetDir, "pic.png"));
    assert.equal(body.name, "pic.png");
    assert.equal(statSync(body.path).isFile(), true);
  } finally {
    f.clean();
  }
});

test("路由：目标目录可以用 ~ 前缀（与目录浏览同一口径）", async () => {
  const f = fixture();
  try {
    const source = join(f.sourceDir, "pic.png");
    writeFileSync(source, "TILDE");
    // 用 HOME 指向临时目录，验证 ~ 与浏览接口同一套 expandHome 语义
    const previous = process.env.HOME;
    const homeDir = join(f.root, "home");
    mkdirSync(homeDir, { recursive: true });
    process.env.HOME = homeDir;
    try {
      const response = await post({ path: source, targetDirectory: "~" });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.path, join(homeDir, "pic.png"));
      assert.equal(existsSync(body.path), true);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  } finally {
    f.clean();
  }
});
