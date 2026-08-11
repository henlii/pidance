/**
 * SDK 依赖 allowlist 静态门禁。
 *
 * P2 起 @earendil-works/pi-coding-agent 为必需运行依赖（0.83.0）。
 * 生产 import 边界仍为：
 * 1. OAuth 登录路由的动态 import（既有例外，静态 allowlist 固定）
 * 2. 后续 P3 server-only runtime/manager adapter 静态 import（尚未落地）
 * client/shared browser 与测试文件一律不得 import SDK 包。
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

/** OAuth 登录路由是唯一允许动态 import SDK 的生产文件。 */
const OAUTH_ROUTE = join(ROOT, "app", "api", "auth", "login", "[provider]", "route.ts");

test("生产代码 import @earendil-works/* 仅允许 OAuth 登录路由的动态 import", () => {
  const dirs = ["app", "lib", "hooks", "components"].map((d) => join(ROOT, d));
  const violations = [];
  for (const dir of dirs) {
    for (const file of listTsFiles(dir)) {
      if (file === OAUTH_ROUTE) continue;
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
