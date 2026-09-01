import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("./npm-bin.ts");

test("resolveNpmBin：node 同目录存在 npm 时用绝对路径", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-npm-bin-"));
  try {
    writeFileSync(join(dir, "npm"), "");
    assert.equal(mod.resolveNpmBin({}, join(dir, "node")), join(dir, "npm"));
    assert.equal(mod.resolveNpmBin({}, join(tmpdir(), "no-such-node-bin", "node")), "npm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveNpmBin：优先 npm_execpath", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-npm-execpath-"));
  try {
    const custom = join(dir, "custom-npm");
    writeFileSync(custom, "");
    writeFileSync(join(dir, "npm"), "");
    assert.equal(mod.resolveNpmBin({ npm_execpath: custom }, join(dir, "node")), custom);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("envWithNpmPath：把 npm 所在目录 prepend 进 PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidance-npm-path-"));
  try {
    const npmBin = join(dir, "npm");
    writeFileSync(npmBin, "");
    const env = mod.envWithNpmPath({ PATH: "/usr/bin" }, npmBin);
    assert.equal(env.PATH?.startsWith(`${dirname(npmBin)}${delimiter}`), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
