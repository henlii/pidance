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
