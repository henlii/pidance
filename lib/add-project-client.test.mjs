/**
 * 添加项目弹窗的客户端逻辑（lib/add-project-client.ts）：
 * - 目录浏览结果分类：不存在/不可读 → ok=false（UI 显示「目录不存在」，不弹窗）
 * - 路径校验结果分类：只有服务端 NOT_FOUND 才进入「是否创建」确认
 * - 创建结果分类：失败文案保留（确认框可读可重试）
 * 每个动作只发一次请求（重复点击/取消不产生额外写入）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  browseProjectDirectory,
  createProjectPath,
  validateProjectPath,
} = await jiti.import("./add-project-client.ts");

/** 记录调用的假 fetch：按 URL 命中返回预置响应。 */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url] ?? routes.default;
    if (typeof route === "function") return route();
    if (route === undefined) throw new Error("network down");
    return { ok: route.status < 400, status: route.status, json: async () => route.body };
  };
  return { calls, fetchImpl };
}

test("browseProjectDirectory：成功时返回规范化路径与子目录", async () => {
  const { calls, fetchImpl } = fakeFetch({
    "/api/cwd/browse?path=%2Fhome%2Fmo": {
      status: 200,
      body: {
        path: "/home/mo",
        parentPath: "/home",
        entries: [{ name: "a", path: "/home/mo/a" }, { name: 3 }, null],
        git: { isRepo: true, branch: "main" },
      },
    },
  });
  const listing = await browseProjectDirectory("/home/mo", fetchImpl);
  assert.equal(calls.length, 1);
  assert.deepEqual(listing, {
    ok: true,
    path: "/home/mo",
    parentPath: "/home",
    entries: [{ name: "a", path: "/home/mo/a" }],
    git: { isRepo: true, branch: "main" },
  });
});

test("browseProjectDirectory：不存在（404）与网络失败都是 ok=false，不抛异常", async () => {
  const missing = await browseProjectDirectory("/nope", fakeFetch({
    default: { status: 404, body: { error: "Directory does not exist: /nope" } },
  }).fetchImpl);
  assert.deepEqual(missing, { ok: false, path: null, parentPath: null, entries: [], git: null });

  const broken = await browseProjectDirectory("/nope", fakeFetch({ default: undefined }).fetchImpl);
  assert.equal(broken.ok, false);
});

test("validateProjectPath：成功返回服务端规范化 cwd", async () => {
  const { fetchImpl } = fakeFetch({
    default: () => ({ ok: true, status: 200, json: async () => ({ success: true, cwd: "/real" }) }),
  });
  assert.deepEqual(await validateProjectPath("~/real", fetchImpl), { kind: "ok", cwd: "/real" });
});

test("validateProjectPath：NOT_FOUND 归为 notFound 并带出待创建路径", async () => {
  const withCwd = fakeFetch({
    default: () => ({ ok: false, status: 400, json: async () => ({ code: "NOT_FOUND", error: "Directory does not exist: /new", cwd: "/new" }) }),
  });
  assert.deepEqual(await validateProjectPath("/new", withCwd.fetchImpl), { kind: "notFound", cwd: "/new" });

  // 服务端未回 cwd（旧响应）时回退请求路径，不丢失待创建目标
  const withoutCwd = fakeFetch({
    default: () => ({ ok: false, status: 400, json: async () => ({ code: "NOT_FOUND", error: "nope" }) }),
  });
  assert.deepEqual(await validateProjectPath("~", withoutCwd.fetchImpl), { kind: "notFound", cwd: "~" });
});

test("validateProjectPath：非目录/权限等失败是 error，绝不提供创建入口", async () => {
  for (const code of ["NOT_A_DIRECTORY", "PERMISSION_DENIED", "INVALID_PATH", "INTERNAL"]) {
    const { fetchImpl } = fakeFetch({
      default: () => ({ ok: false, status: 400, json: async () => ({ code, error: `failed: ${code}` }) }),
    });
    const result = await validateProjectPath("/x", fetchImpl);
    assert.equal(result.kind, "error", `${code} 不得进入创建确认`);
    assert.equal(result.message, `failed: ${code}`);
  }
  const network = await validateProjectPath("/x", fakeFetch({ default: undefined }).fetchImpl);
  assert.equal(network.kind, "error");
});

test("createProjectPath：成功返回创建后的 cwd；失败保留文案", async () => {
  const ok = fakeFetch({ default: () => ({ ok: true, status: 200, json: async () => ({ success: true, cwd: "/made" }) }) });
  assert.deepEqual(await createProjectPath("/made", ok.fetchImpl), { ok: true, cwd: "/made" });

  const failed = fakeFetch({
    default: () => ({ ok: false, status: 400, json: async () => ({ code: "CREATE_FAILED", error: "EACCES: permission denied" }) }),
  });
  assert.deepEqual(await createProjectPath("/made", failed.fetchImpl), { ok: false, message: "EACCES: permission denied" });
});

test("每个动作只发一次请求（重复派发由调用方 submitting 闸门拦下）", async () => {
  const { calls, fetchImpl } = fakeFetch({
    default: () => ({ ok: true, status: 200, json: async () => ({ success: true, cwd: "/made" }) }),
  });
  await validateProjectPath("/made", fetchImpl);
  await createProjectPath("/made", fetchImpl);
  assert.equal(calls.length, 2);
});
