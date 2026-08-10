import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const m = await jiti.import("./pidance-runtime-config.ts");

test("normalize/validate runtimeDir：空合法；相对路径拒绝；绝对目录通过", () => {
  assert.equal(m.normalizeRuntimeDir("  "), "");
  assert.equal(m.validateRuntimeDir("").ok, true);
  assert.equal(m.validateRuntimeDir("relative/path").ok, false);
  const root = mkdtempSync(join(tmpdir(), "pidance-rtdir-"));
  try {
    const v = m.validateRuntimeDir(root);
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.runtimeDir, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("read/write runtime config 往返", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-rtcfg-"));
  try {
    const written = m.writeRuntimeConfig({ version: 1, runtimeDir: root }, root);
    assert.equal(written.runtimeDir, root);
    const read = m.readRuntimeConfig(root);
    assert.equal(read.runtimeDir, root);
    assert.ok(existsSync(m.runtimeConfigPath(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findPiBinaryInDir 找到 dist/cli.js", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-rtbin-"));
  try {
    const cli = join(root, "dist", "cli.js");
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(cli, "#!/usr/bin/env node\n", "utf8");
    const found = m.findPiBinaryInDir(root, (p) => existsSync(p));
    assert.ok(found && found.endsWith("cli.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
