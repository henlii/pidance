/**
 * SDK 依赖 allowlist 静态门禁。
 *
 * 生产 import 边界：
 * 1. server-only adapter：sdk-session-host / web-extension-ui 静态 import
 * 2. OAuth 登录路由动态 import
 * client/shared browser 与测试文件不得 import SDK。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;

function listTsFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "node_modules" || name === ".next" || name === ".next-public") continue;
    if (statSync(full).isDirectory()) {
      listTsFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const OAUTH_ROUTE = join(ROOT, "app", "api", "auth", "login", "[provider]", "route.ts");
const SDK_ALLOWLIST = new Set([
  join(ROOT, "lib", "sdk-session-host.ts"),
  join(ROOT, "lib", "web-extension-ui.ts"),
  join(ROOT, "lib", "pi-session-io.ts"),
]);

test("生产代码 import @earendil-works/* 仅允许 server-only adapter 与 OAuth 动态 import", () => {
  const dirs = ["app", "lib", "hooks", "components"].map((d) => join(ROOT, d));
  const violations = [];
  for (const dir of dirs) {
    for (const file of listTsFiles(dir)) {
      if (file === OAUTH_ROUTE) continue;
      if (SDK_ALLOWLIST.has(file)) continue;
      const content = readFileSync(file, "utf8");
      const m = content.match(/^\s*import\s+.*?["']@earendil-works\/[^"']+["']/m);
      if (m) violations.push(`${file}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("OAuth 路由仅以动态 import 引用 SDK（无静态 import）", () => {
  const content = readFileSync(OAUTH_ROUTE, "utf8");
  assert.doesNotMatch(content, /^\s*import\s+.*?["']@earendil-works\//m);
  assert.match(content, /await\s+import\(["']@earendil-works\/pi-coding-agent["']\)/);
});

test("server-only adapter 静态 import SDK", () => {
  for (const file of SDK_ALLOWLIST) {
    const content = readFileSync(file, "utf8");
    assert.match(content, /@earendil-works\/pi-coding-agent/);
  }
});

test("测试文件（*.test.mjs）不得 import @earendil-works/*", () => {
  const dirs = ["app", "lib", "hooks", "components", "bin", "scripts"].map((d) => join(ROOT, d));
  const violations = [];
  for (const dir of dirs) {
    if (!statSync(dir, { throwIfNoEntry: false })) continue;
    for (const name of readdirSync(dir)) {
      if (!/\.test\.mjs$/.test(name)) continue;
      const content = readFileSync(join(dir, name), "utf8");
      const m = content.match(/^\s*import\s+.*?["']@earendil-works\/[^"']+["']/m);
      if (m) violations.push(`${name}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(violations, []);
});


// ---------------------------------------------------------------------------
// Issue #36：SDK 私有写入入口的升级自检
//
// pi-session-io 的落盘/reparent 依赖 SDK 内部 _rewriteFile 与 flushed（已核实
// 无公开替代：isPersisted() 表示「启用持久化」，_persist() 在无 assistant 时
// 不建文件）。SDK 升级导致其改名/消失时，行为测试会先失败；这里补一条**直接**
// 门禁，在升级改动落地的当下就点明原因，而不是等到某个会话不出现在列表里。
// ---------------------------------------------------------------------------

test("#36 SDK session-manager 仍提供 _rewriteFile 与 flushed（升级门禁）", () => {
  const dts = join(
    ROOT,
    "node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts",
  );
  if (!statSync(dts, { throwIfNoEntry: false })) {
    // 依赖未安装时跳过（CI 会先 npm ci；此处不制造假失败）
    return;
  }
  const content = readFileSync(dts, "utf8");
  assert.match(
    content,
    /_rewriteFile/,
    "SDK 不再暴露 _rewriteFile：pi-session-io 的 materialize/reparent 必须改走公开 API",
  );
  assert.match(
    content,
    /\bflushed\b/,
    "SDK 不再暴露 flushed：延迟落盘标志的语义可能已变，请重新核对 pi-session-io",
  );
  // 记录事实：尚无公开的 flush/materialize 入口（若新增，应改用它并删除适配层）
  assert.doesNotMatch(
    content,
    /^\s{4}(flush|materialize|save)\s*\(/m,
    "SDK 似乎新增了公开落盘入口：请改用公开 API 并收敛 pi-session-io 的私有适配",
  );
});
