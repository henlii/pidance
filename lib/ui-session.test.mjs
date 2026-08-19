import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const load = () => jiti.import("./ui-session.ts");

test("JWT 签发与校验：有效 / 过期 / 篡改", async () => {
  const {
    signUiSessionJwt,
    verifyUiSessionJwt,
    UI_SESSION_TTL_MS,
  } = await load();
  const secret = "test-secret-key-32bytes-minimum!!";
  const now = 1_700_000_000_000;
  const token = signUiSessionJwt(secret, UI_SESSION_TTL_MS, now);
  assert.equal(verifyUiSessionJwt(token, secret, now + 1000), true);
  assert.equal(verifyUiSessionJwt(token, secret, now + UI_SESSION_TTL_MS + 1000), false);
  assert.equal(verifyUiSessionJwt(token + "x", secret, now + 1000), false);
  assert.equal(verifyUiSessionJwt(token, "other-secret", now + 1000), false);
});

test("TTL：trustDevice 为 7d，默认 12h", async () => {
  const { resolveSessionTtlMs, UI_SESSION_TTL_MS, UI_TRUSTED_DEVICE_TTL_MS } = await load();
  assert.equal(resolveSessionTtlMs(false), UI_SESSION_TTL_MS);
  assert.equal(resolveSessionTtlMs(true), UI_TRUSTED_DEVICE_TTL_MS);
});

test("Cookie 解析与 Set-Cookie 头", async () => {
  const { parseCookieValue, buildSetCookieHeader, UI_SESSION_COOKIE_NAME } = await load();
  assert.equal(
    parseCookieValue(`a=1; ${UI_SESSION_COOKIE_NAME}=abc%2Edef; b=2`, UI_SESSION_COOKIE_NAME),
    "abc.def",
  );
  const header = buildSetCookieHeader({
    name: UI_SESSION_COOKIE_NAME,
    value: "tok",
    maxAgeSeconds: 3600,
    secure: true,
  });
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Max-Age=3600/);
  assert.match(header, /Secure/);
});

test("密钥落盘与 env 优先", async () => {
  const { getOrCreateJwtSecret } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ui-jwt-"));
  const file = path.join(dir, "secret");
  try {
    const mem = {
      map: new Map(),
      readFileSync(p) { return this.map.get(p); },
      writeFileSync(p, data) { this.map.set(p, data); },
      mkdirSync() {},
      existsSync(p) { return this.map.has(p); },
    };
    const a = getOrCreateJwtSecret({}, file, mem);
    const b = getOrCreateJwtSecret({}, file, mem);
    assert.equal(a, b);
    assert.equal(getOrCreateJwtSecret({ PIDANCE_UI_JWT_SECRET: "from-env" }, file, mem), "from-env");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("登录限流：超限锁定后拒绝", async () => {
  const {
    checkLoginRateLimit,
    recordLoginFailure,
    clearLoginFailures,
    resetLoginRateLimitForTests,
    UI_LOGIN_RATE_MAX,
  } = await load();
  resetLoginRateLimitForTests();
  const key = "ip:1.2.3.4";
  for (let i = 0; i < UI_LOGIN_RATE_MAX; i += 1) recordLoginFailure(key, 1000 + i);
  const blocked = checkLoginRateLimit(key, 1000 + UI_LOGIN_RATE_MAX);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  clearLoginFailures(key);
  assert.equal(checkLoginRateLimit(key, 2000).allowed, true);
});

test("verifyPassword 恒定时间比较", async () => {
  const { verifyPassword } = await load();
  assert.equal(verifyPassword("secret", "secret"), true);
  assert.equal(verifyPassword("secret", "wrong"), false);
  assert.equal(verifyPassword("", "secret"), false);
});
test("JWT jti：签发带设备 id，readUiSessionJwt 可读回", async () => {
  const { signUiSessionJwt, readUiSessionJwt, verifyUiSessionJwt, UI_SESSION_TTL_MS } = await load();
  const secret = "test-secret-key-32bytes-minimum!!";
  const now = 1_700_000_000_000;
  const jti = "device-abc123";
  const token = signUiSessionJwt(secret, UI_SESSION_TTL_MS, now, jti);
  assert.equal(verifyUiSessionJwt(token, secret, now + 1000), true);
  assert.deepEqual(readUiSessionJwt(token, secret, now + 1000), { valid: true, jti });
  // 旧 token（无 jti）兼容
  const legacy = signUiSessionJwt(secret, UI_SESSION_TTL_MS, now);
  assert.deepEqual(readUiSessionJwt(legacy, secret, now + 1000), { valid: true, jti: null });
  // 无效/过期
  assert.deepEqual(readUiSessionJwt(token + "x", secret, now + 1000), { valid: false, jti: null });
  assert.deepEqual(readUiSessionJwt(token, secret, now + UI_SESSION_TTL_MS + 1000), { valid: false, jti: null });
  assert.deepEqual(readUiSessionJwt(null, secret, now), { valid: false, jti: null });
});

test("设备注册表：save / read / remove / has / 过期过滤 / 损坏降级", async () => {
  const { saveUiSessionDevice, readUiSessionDevices, removeUiSessionDevice, hasUiSessionDevice } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-ui-sessions-"));
  const file = path.join(dir, "pidance-ui-sessions.json");
  const now = 1_700_000_000_000;
  const dev1 = { id: "d1", label: "Chrome · Windows", createdAt: now, expiresAt: now + 1000 };
  const dev2 = { id: "d2", label: "Firefox · Linux", createdAt: now, expiresAt: now + 2000 };
  // 初始为空
  assert.deepEqual(readUiSessionDevices(file, undefined, now), []);
  saveUiSessionDevice(dev1, file, undefined, now);
  saveUiSessionDevice(dev2, file, undefined, now);
  assert.deepEqual(readUiSessionDevices(file, undefined, now), [dev1, dev2]);
  assert.equal(hasUiSessionDevice("d1", file, undefined, now), true);
  assert.equal(hasUiSessionDevice("nope", file, undefined, now), false);
  // 权限 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // 过期过滤
  assert.deepEqual(readUiSessionDevices(file, undefined, now + 1500), [dev2]);
  assert.equal(hasUiSessionDevice("d1", file, undefined, now + 1500), false);
  // 删除
  removeUiSessionDevice("d2", file, undefined, now);
  assert.deepEqual(readUiSessionDevices(file, undefined, now), [dev1]);
  removeUiSessionDevice("d1", file, undefined, now);
  assert.deepEqual(readUiSessionDevices(file, undefined, now), []);
  // 损坏降级
  fs.writeFileSync(file, "{ broken", "utf8");
  assert.deepEqual(readUiSessionDevices(file, undefined, now), []);
});

test("deviceLabelFromUserAgent：浏览器 + 系统标签", async () => {
  const { deviceLabelFromUserAgent } = await load();
  assert.equal(deviceLabelFromUserAgent(null), "Unknown device");
  assert.equal(deviceLabelFromUserAgent(""), "Unknown device");
  assert.equal(
    deviceLabelFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Chrome · Windows",
  );
  assert.equal(
    deviceLabelFromUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"),
    "Firefox · Linux",
  );
  assert.equal(
    deviceLabelFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"),
    "Safari · macOS",
  );
  assert.equal(deviceLabelFromUserAgent("curl/8.0"), "Browser");
});

test("isUiSessionActive：验签 + 设备注册校验；删除设备后失效", async () => {
  const { signUiSessionJwt, isUiSessionActive, saveUiSessionDevice, removeUiSessionDevice, UI_SESSION_TTL_MS } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pidance-ui-sessions-active-"));
  const secret = "test-secret-key-32bytes-minimum!!";
  const now = 1_700_000_000_000;
  const jti = "dev-active";
  const token = signUiSessionJwt(secret, UI_SESSION_TTL_MS, now, jti);
  const cookie = `pidance_ui_session=${encodeURIComponent(token)}`;
  const file = path.join(dir, "pidance-ui-sessions.json");
  // 未注册 → 无效
  assert.equal(isUiSessionActive(cookie, secret, now, file), false);
  saveUiSessionDevice({ id: jti, label: "Chrome", createdAt: now, expiresAt: now + UI_SESSION_TTL_MS }, file, undefined, now);
  // 注册后 → 有效
  assert.equal(isUiSessionActive(cookie, secret, now + 1000, file), true);
  // 删除设备 → 立即失效
  removeUiSessionDevice(jti, file);
  assert.equal(isUiSessionActive(cookie, secret, now + 1000, file), false);
  // 无 jti 的旧 cookie 兼容放行（不查注册表）
  const legacy = signUiSessionJwt(secret, UI_SESSION_TTL_MS, now);
  const legacyCookie = `pidance_ui_session=${encodeURIComponent(legacy)}`;
  assert.equal(isUiSessionActive(legacyCookie, secret, now + 1000, file), true);
  // 无 cookie → 无效
  assert.equal(isUiSessionActive(null, secret, now, file), false);
});
