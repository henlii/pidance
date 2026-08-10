import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const cfg = await jiti.import("../pidance-runtime-config.ts");
const res = await jiti.import("./resolve-binary.ts");

test("resolveRuntimeBinary：用户 runtimeDir 命中 config-dir", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-res-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const rt = join(root, "runtime");
    mkdirSync(join(rt, "dist"), { recursive: true });
    writeFileSync(join(rt, "dist", "cli.js"), "export {}\n", "utf8");
    cfg.writeRuntimeConfig({ version: 1, runtimeDir: rt }, agentDir);

    const env = {
      PI_CODING_AGENT_DIR: agentDir,
      PIDANCE_PI_RUNTIME: "",
      PATH: join(root, "no-path"),
      HOME: root,
      PIDANCE_PI_RUNTIME_SLOTS_DIR: join(root, "slots-empty"),
      PIDANCE_PI_RUNTIME_FALLBACK_BUNDLED: "0",
    };
    const resolved = res.resolveRuntimeBinary(env);
    assert.equal(resolved.source, "config-dir");
    assert.ok(resolved.path && resolved.path.includes("cli.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveRuntimeBinary：无 pi 时 source=none 不抛", () => {
  const root = mkdtempSync(join(tmpdir(), "pidance-none-"));
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    const env = {
      PI_CODING_AGENT_DIR: agentDir,
      PIDANCE_PI_RUNTIME: "",
      PATH: join(root, "no-path"),
      HOME: root,
      PIDANCE_PI_RUNTIME_SLOTS_DIR: join(root, "slots-empty"),
      PIDANCE_PI_RUNTIME_FALLBACK_BUNDLED: "0",
    };
    const resolved = res.resolveRuntimeBinary(env);
    assert.equal(resolved.source, "none");
    assert.equal(resolved.path, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
