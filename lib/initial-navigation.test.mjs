import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// 该模块现在依赖 lib/tab-session-memory（本标签会话记忆），所以走 jiti 解析，
// 与 lib/ 其他测试一致；裸 import("./x.ts") 解析不了无扩展名的相对导入。
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const loadSubject = () => jiti.import("./initial-navigation.ts");

test("uses cwd instead of session when both parameters are present", async () => {
  const { getInitialNavigation } = await loadSubject();
  const result = getInitialNavigation(new URLSearchParams({
    cwd: " /work/project ",
    session: "saved-session",
  }));

  assert.deepEqual(result, {
    requestedCwd: "/work/project",
    sessionId: null,
    rememberedSessionId: null,
  });
});

test("restores session when cwd is absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session", rememberedSessionId: null },
  );
});

test("treats an empty cwd as absent", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams({ cwd: "  ", session: "saved-session" })),
    { requestedCwd: null, sessionId: "saved-session", rememberedSessionId: null },
  );
});

test("preserves a URL-encoded Windows path", async () => {
  const { getInitialNavigation } = await loadSubject();

  assert.deepEqual(
    getInitialNavigation(new URLSearchParams("cwd=C%3A%5CProjects%5Cpi-web")),
    { requestedCwd: "C:\\Projects\\pi-web", sessionId: null, rememberedSessionId: null },
  );
});

test("客户端首帧以浏览器地址为准（水合首帧参数为空时仍认 ?session=）", async () => {
  const { getInitialNavigation } = await loadSubject();
  globalThis.window = { location: { search: "?session=from-address-bar" } };
  try {
    assert.deepEqual(
      getInitialNavigation(new URLSearchParams("")),
      { requestedCwd: null, sessionId: "from-address-bar", rememberedSessionId: null },
    );
  } finally {
    delete globalThis.window;
  }
});

test("地址栏无会话时回退到本标签记忆（软提示）", async () => {
  const { getInitialNavigation } = await loadSubject();
  globalThis.window = {
    location: { search: "" },
    sessionStorage: { getItem: () => "remembered-session", setItem: () => {}, removeItem: () => {} },
  };
  try {
    assert.deepEqual(
      getInitialNavigation(new URLSearchParams("")),
      { requestedCwd: null, sessionId: null, rememberedSessionId: "remembered-session" },
    );
  } finally {
    delete globalThis.window;
  }
});

test("明确意图优先于记忆：?session= 与 ?cwd= 都不看记忆", async () => {
  const { getInitialNavigation } = await loadSubject();
  const withAddress = (search) => {
    globalThis.window = {
      location: { search },
      sessionStorage: { getItem: () => "remembered-session", setItem: () => {}, removeItem: () => {} },
    };
  };
  try {
    // 客户端以浏览器实际地址为准（见实现注释），所以这里设地址栏而不是入参。
    withAddress("?session=explicit");
    assert.deepEqual(
      getInitialNavigation(new URLSearchParams("")),
      { requestedCwd: null, sessionId: "explicit", rememberedSessionId: null },
    );
    withAddress("?cwd=/work");
    assert.deepEqual(
      getInitialNavigation(new URLSearchParams("")),
      { requestedCwd: "/work", sessionId: null, rememberedSessionId: null },
    );
  } finally {
    delete globalThis.window;
  }
});
