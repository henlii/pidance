import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const jiti = createJiti(import.meta.url);
const {
  SERVER_CONFIG_FILE_NAME,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyConfigPassword,
  passwordHashConfigured,
  readServerConfig,
  writeServerConfig,
  defaultServerConfigPath,
  passwordConfigured,
  applyServerConfigChange,
} = await jiti.import("../lib/pidance-server-config.ts");

const DEFAULT_CONFIG = { passwordHash: null, remoteEnabled: false, port: null };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pidance-server-config-"));
}

test("hashPassword / verifyConfigPassword：scrypt 往返", () => {
  const stored = hashPassword("s3cret");
  assert.equal(typeof stored.salt, "string");
  assert.equal(typeof stored.hash, "string");
  assert.ok(stored.hash.length > 0);
  assert.equal(verifyConfigPassword("s3cret", stored), true);
  assert.equal(verifyConfigPassword("wrong", stored), false);
  assert.equal(verifyConfigPassword("", stored), false);
  assert.equal(verifyConfigPassword("s3cret", { salt: "zz", hash: "not-hex" }), false);
  // 空白归一化与 ui-session 一致
  assert.equal(verifyConfigPassword("  s3cret  ", stored), true);
});

test("readServerConfig：缺失/损坏/半写形状一律降级为默认", () => {
  const dir = tmpDir();
  const file = path.join(dir, SERVER_CONFIG_FILE_NAME);
  // 不存在
  assert.deepEqual(readServerConfig(file), DEFAULT_CONFIG);
  // 损坏 JSON
  fs.writeFileSync(file, "{ not json", "utf8");
  assert.deepEqual(readServerConfig(file), DEFAULT_CONFIG);
  // 半写形状
  fs.writeFileSync(file, JSON.stringify({ passwordHash: { salt: "x" }, remoteEnabled: true }), "utf8");
  assert.deepEqual(readServerConfig(file), { passwordHash: null, remoteEnabled: true, port: null });
  // 正常
  const stored = hashPassword("s3cret");
  fs.writeFileSync(
    file,
    JSON.stringify({ passwordHash: stored, remoteEnabled: true, port: 8080 }),
    "utf8",
  );
  assert.deepEqual(readServerConfig(file), { passwordHash: stored, remoteEnabled: true, port: 8080 });
});

test("writeServerConfig：原子写 + 0600 + 读回一致", () => {
  const dir = tmpDir();
  const file = path.join(dir, "nested", SERVER_CONFIG_FILE_NAME);
  const stored = hashPassword("s3cret");
  writeServerConfig({ passwordHash: stored, remoteEnabled: true, port: 8080 }, file);
  assert.deepEqual(readServerConfig(file), { passwordHash: stored, remoteEnabled: true, port: 8080 });
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.tmp-`), false);
});

test("passwordConfigured / passwordHashConfigured：env 明文或文件哈希任一即已配置", () => {
  assert.equal(passwordConfigured(null, null), false);
  assert.equal(passwordConfigured("", null), false);
  assert.equal(passwordConfigured("pw", null), true);
  assert.equal(passwordConfigured(null, { passwordHash: null, remoteEnabled: false }), false);
  assert.equal(
    passwordConfigured(null, { passwordHash: hashPassword("pw"), remoteEnabled: false }),
    true,
  );
  assert.equal(passwordHashConfigured(null), false);
  assert.equal(passwordHashConfigured({ passwordHash: null, remoteEnabled: false }), false);
});

test("applyServerConfigChange：未设密码时直接设置，长度下限", () => {
  const res = applyServerConfigChange(
    { ...DEFAULT_CONFIG },
    { password: "a".repeat(MIN_PASSWORD_LENGTH - 1) },
    null,
  );
  assert.deepEqual(res, { error: "password_too_short" });

  const ok = applyServerConfigChange({ ...DEFAULT_CONFIG }, { password: "s3cret" }, null);
  assert.ok("config" in ok);
  assert.equal(ok.config.passwordHash !== null, true);
  assert.equal(ok.changedPassword, true);
  assert.equal(verifyConfigPassword("s3cret", ok.config.passwordHash), true);
  assert.equal(ok.config.remoteEnabled, false);
});

test("applyServerConfigChange：已设密码时直接修改，无需旧密码", () => {
  const current = { passwordHash: hashPassword("old-pass"), remoteEnabled: false, port: null };
  const ok = applyServerConfigChange(current, { password: "new-pass" }, null);
  assert.ok("config" in ok);
  assert.equal(verifyConfigPassword("new-pass", ok.config.passwordHash), true);
  assert.equal(ok.changedPassword, true);
  // env 密码存在也不影响（设置页自身受认证门禁保护）
  const ok2 = applyServerConfigChange(current, { password: "new-pass" }, "env-pass");
  assert.ok("config" in ok2);
  assert.equal(verifyConfigPassword("new-pass", ok2.config.passwordHash), true);
});

test("applyServerConfigChange：清除密码（无需旧密码）", () => {
  // 未设密码：幂等成功
  const noop = applyServerConfigChange({ ...DEFAULT_CONFIG }, { clearPassword: true }, null);
  assert.ok("config" in noop);
  assert.equal(noop.config.passwordHash, null);
  assert.equal(noop.changedPassword, false);

  const current = { passwordHash: hashPassword("old-pass"), remoteEnabled: false, port: null };
  const ok = applyServerConfigChange(current, { clearPassword: true }, null);
  assert.ok("config" in ok);
  assert.equal(ok.config.passwordHash, null);
  assert.equal(ok.changedPassword, true);
});

test("applyServerConfigChange：远程开关与密码的依赖规则", () => {
  // 开远程但无密码 → 拒绝
  assert.deepEqual(
    applyServerConfigChange({ ...DEFAULT_CONFIG }, { remoteEnabled: true }, null),
    { error: "remote_requires_password" },
  );
  // 先设密码再开远程 → 允许
  const withPw = applyServerConfigChange({ ...DEFAULT_CONFIG }, { password: "s3cret" }, null);
  assert.ok("config" in withPw);
  const on = applyServerConfigChange(withPw.config, { remoteEnabled: true }, null);
  assert.ok("config" in on);
  assert.equal(on.config.remoteEnabled, true);
  assert.equal(on.changedPassword, false);
  // 远程开着时清密码 → 拒绝
  const off = applyServerConfigChange(
    on.config,
    { clearPassword: true },
    null,
  );
  assert.deepEqual(off, { error: "remote_requires_password" });
  // 先关远程再清密码 → 允许
  const offFirst = applyServerConfigChange(on.config, { remoteEnabled: false }, null);
  assert.ok("config" in offFirst);
  const cleared = applyServerConfigChange(
    offFirst.config,
    { clearPassword: true },
    null,
  );
  assert.ok("config" in cleared);
  assert.equal(cleared.config.passwordHash, null);
  // env 密码存在时开远程 → 允许（无需文件哈希）
  const envOk = applyServerConfigChange({ ...DEFAULT_CONFIG }, { remoteEnabled: true }, "env-pass");
  assert.ok("config" in envOk);
  assert.equal(envOk.config.remoteEnabled, true);
});

test("applyServerConfigChange：password 与 clearPassword 同时提供 → bad_request", () => {
  assert.deepEqual(
    applyServerConfigChange({ ...DEFAULT_CONFIG }, { password: "s3cret", clearPassword: true }, null),
    { error: "bad_request" },
  );
});

test("readServerConfig：port 字段解析（仅 1-65535 整数有效）", () => {
  const dir = tmpDir();
  const file = path.join(dir, SERVER_CONFIG_FILE_NAME);
  fs.writeFileSync(file, JSON.stringify({ port: 8080 }), "utf8");
  assert.equal(readServerConfig(file).port, 8080);
  for (const bad of [0, -1, 65536, 70000, 3.5]) {
    fs.writeFileSync(file, JSON.stringify({ port: bad }), "utf8");
    assert.equal(readServerConfig(file).port, null, `port=${bad}`);
  }
  fs.writeFileSync(file, JSON.stringify({ port: "31415" }), "utf8");
  assert.equal(readServerConfig(file).port, null);
  fs.writeFileSync(file, JSON.stringify({}), "utf8");
  assert.equal(readServerConfig(file).port, null);
});

test("applyServerConfigChange：port 设置/重置/无效值", () => {
  const ok = applyServerConfigChange({ ...DEFAULT_CONFIG }, { port: 8080 }, null);
  assert.ok("config" in ok);
  assert.equal(ok.config.port, 8080);
  assert.equal(ok.config.remoteEnabled, false);
  assert.equal(ok.changedPassword, false);
  // 未提供 → 保持
  const keep = applyServerConfigChange(ok.config, { remoteEnabled: true }, "env-pass");
  assert.ok("config" in keep);
  assert.equal(keep.config.port, 8080);
  // null → 重置默认
  const reset = applyServerConfigChange(keep.config, { port: null }, "env-pass");
  assert.ok("config" in reset);
  assert.equal(reset.config.port, null);
  // 无效值
  for (const bad of [0, 65536, 1.5, -1]) {
    assert.deepEqual(applyServerConfigChange({ ...DEFAULT_CONFIG }, { port: bad }, null), { error: "port_invalid" });
  }
});

test("defaultServerConfigPath：agentDir 覆盖、默认 ~/.pi/agent", () => {
  assert.equal(defaultServerConfigPath("/tmp/x"), path.join("/tmp/x", SERVER_CONFIG_FILE_NAME));
  const p = defaultServerConfigPath();
  assert.ok(p.endsWith(path.join(".pi", "agent", SERVER_CONFIG_FILE_NAME)));
});
