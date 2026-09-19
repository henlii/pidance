/**
 * /api/cwd/validate 与 /api/cwd/create 的真实文件系统语义：
 * - 校验失败必须带机器可读 code（UI 只在 NOT_FOUND 上提供创建入口）
 * - 校验通过 = 可创建：两处路径语义一致（绝对路径 / ~ 前缀，拒绝相对路径）
 * - 创建递归建目录、对已存在目录幂等、遇到同名文件不覆盖
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { POST: validate } = await jiti.import("../app/api/cwd/validate/route.ts");
const { POST: create } = await jiti.import("../app/api/cwd/create/route.ts");

function post(handler, body) {
  return handler(new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pidance-cwd-"));
  return (async () => fn(dir))().finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("validate：不存在的路径回 NOT_FOUND 且带出规范化候选路径", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "missing");
    const res = await post(validate, { cwd: target });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "NOT_FOUND");
    assert.equal(body.cwd, target, "创建确认要用的规范化路径必须回传");
  });
});

test("validate：已存在目录通过；同名文件回 NOT_A_DIRECTORY（不提供创建）", async () => {
  await withTempDir(async (dir) => {
    const okRes = await post(validate, { cwd: dir });
    assert.equal(okRes.status, 200);
    assert.deepEqual(await okRes.json(), { success: true, cwd: dir });

    const file = join(dir, "not-a-dir");
    writeFileSync(file, "x");
    const fileRes = await post(validate, { cwd: file });
    assert.equal(fileRes.status, 400);
    const body = await fileRes.json();
    assert.equal(body.code, "NOT_A_DIRECTORY");
    assert.equal("cwd" in body, false, "非目录不得进入创建确认流程");
  });
});

test("validate：相对路径与空路径被拒（不按服务进程 cwd 解析）", async () => {
  const relative = await post(validate, { cwd: "some/relative" });
  assert.equal(relative.status, 400);
  assert.equal((await relative.json()).code, "INVALID_PATH");

  const empty = await post(validate, { cwd: "   " });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, "PATH_REQUIRED");
});

test("create：递归创建目录并返回规范化路径；再调用幂等", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "a", "b", "c");
    const res = await post(create, { cwd: target });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true, cwd: target });
    assert.ok(existsSync(target), "目录必须真的被创建");

    const again = await post(create, { cwd: target });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).cwd, target);
  });
});

test("create：同名文件不覆盖、相对路径与空路径被拒", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "taken");
    writeFileSync(file, "keep me");
    const fileRes = await post(create, { cwd: file });
    assert.equal(fileRes.status, 400);
    assert.equal((await fileRes.json()).code, "NOT_A_DIRECTORY");
    assert.ok(existsSync(file), "既有文件必须原样保留");

    const relative = await post(create, { cwd: "relative/dir" });
    assert.equal(relative.status, 400);
    assert.equal((await relative.json()).code, "INVALID_PATH");

    const empty = await post(create, { cwd: "" });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, "PATH_REQUIRED");
  });
});

test("create：父路径是文件时回 CREATE_FAILED（不静默成功）", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "blocker");
    writeFileSync(file, "x");
    const res = await post(create, { cwd: join(file, "child") });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "CREATE_FAILED");
    assert.ok(body.error, "失败原因必须可展示");
  });
});

test("validate / create：~ 前缀展开到同一个家目录路径", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  const target = join(dir, "probe");
  return (async () => {
    const validated = await post(validate, { cwd: "~/probe" });
    assert.equal(validated.status, 400, "尚未创建时 validate 回 NOT_FOUND");
    assert.equal((await validated.json()).cwd, target);
    const created = await post(create, { cwd: "~/probe" });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).cwd, target);
    assert.ok(existsSync(target));
  })().finally(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });
});

test("validate：父路径是文件时是 NOT_A_DIRECTORY，不是可创建的 NOT_FOUND", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "parent-file");
    writeFileSync(file, "x");
    const res = await post(validate, { cwd: join(file, "child") });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "NOT_A_DIRECTORY");
  });
});

test("validate：已存在的嵌套目录正常通过", async () => {
  await withTempDir(async (dir) => {
    const nested = join(dir, "nested");
    mkdirSync(nested);
    const res = await post(validate, { cwd: nested });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).cwd, nested);
  });
});
