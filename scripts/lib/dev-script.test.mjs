/**
 * Issue #38：`npm run dev` 的端口与产物约定（静态门禁）。
 *
 * 背景：脚本曾硬编码 `-p 31415`，而 31415 保留给稳定安装版；文档只说
 * 「不要这样用」，脚本本身未改，形成文档与实际不一致。
 *
 * 不启动服务器：本机 31415/31416 常被在跑的服务占用，起服务会 EADDRINUSE。
 * 因此这里固定脚本契约本身（端口 / 绑定地址 / 不写 .next-public），
 * 并校验文档与脚本一致。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, root)), "utf8");

test("#38 dev 脚本：工作区端口 + 显式回环 + 不占用 .next-public", () => {
  const pkg = JSON.parse(read("package.json"));
  const dev = pkg.scripts?.dev ?? "";

  assert.match(dev, /-p\s+31416\b/, "dev 必须使用工作区端口 31416");
  assert.doesNotMatch(dev, /31415/, "dev 不得再占用稳定安装版的 31415");
  assert.match(dev, /-H\s+127\.0\.0\.1\b/, "dev 未设密码，必须显式只绑回环");
  assert.doesNotMatch(
    dev,
    /PIDANCE_DIST_DIR/,
    "dev 输出应留在 .next，不得写持续部署用的 .next-public",
  );
});

test("#38 dev 的 distDir 回落 .next（不污染持续测试产物）", () => {
  const cfg = read("next.config.ts");
  assert.match(
    cfg,
    /distDir:\s*process\.env\.PIDANCE_DIST_DIR\s*\|\|\s*"\.next"/,
    "未设 PIDANCE_DIST_DIR 时必须回落 .next",
  );
});

test("#38 文档与脚本一致：不再声称 dev 使用 31415", () => {
  // docs/ 目前是本地未提交文档；存在才校验（避免在缺少该文件的环境下误失败）。
  const files = ["README.md", "README.en.md", "docs/development.md"]
    .filter((rel) => existsSync(fileURLToPath(new URL(rel, root))));
  assert.ok(files.includes("README.md"), "至少应校验 README.md");

  for (const rel of files) {
    const text = read(rel);
    assert.doesNotMatch(
      text,
      /仍硬编码 31415|still hardcodes 31415/,
      `${rel} 仍有「dev 硬编码 31415」的过时说明`,
    );
    if (text.includes("npm run dev")) {
      assert.match(
        text,
        /npm run dev[\s\S]{0,120}31416/,
        `${rel} 中 npm run dev 的说明应指向 31416`,
      );
    }
  }
});
