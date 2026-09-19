/**
 * /api/auth/ui-session 路由测试：同一浏览器重复登录只占一条设备记录；登出删除该记录。
 * 隔离 agentDir（设备注册表 + JWT 密钥都落在这个临时目录里）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
});
const { POST, DELETE } = await jiti.import("../app/api/auth/ui-session/route.ts");
const { readUiSessionDevices, UI_DEVICE_COOKIE_NAME, UI_SESSION_COOKIE_NAME } = await jiti.import("./ui-session.ts");

const PASSWORD = "correct horse battery";
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function withAgentEnv(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ui-session-route-"));
  const saved = {
    PIDANCE_PASSWORD: process.env.PIDANCE_PASSWORD,
    PIDANCE_UI_JWT_SECRET: process.env.PIDANCE_UI_JWT_SECRET,
    OPENCODE_JWT_SECRET: process.env.OPENCODE_JWT_SECRET,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
  process.env.PIDANCE_PASSWORD = PASSWORD;
  delete process.env.PIDANCE_UI_JWT_SECRET;
  delete process.env.OPENCODE_JWT_SECRET;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function loginRequest(cookieHeader) {
  return new Request("http://localhost/api/auth/ui-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": UA,
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
    body: JSON.stringify({ password: PASSWORD, trustDevice: true }),
  });
}

/** 从 Set-Cookie 列表里取出某个 Cookie 的值（未解码）。 */
function cookieValue(setCookies, name) {
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0 && pair.slice(0, idx).trim() === name) return pair.slice(idx + 1);
  }
  return null;
}

test("同一浏览器重复登录只占一条设备记录，登出后删除该记录", async () => {
  await withAgentEnv(async () => {
    // 首次登录：注册一条设备记录，并下发会话 + 设备 id 两个 Cookie
    const first = await POST(loginRequest(null));
    assert.equal(first.status, 200);
    const firstCookies = first.headers.getSetCookie();
    const sessionToken = cookieValue(firstCookies, UI_SESSION_COOKIE_NAME);
    const deviceId = cookieValue(firstCookies, UI_DEVICE_COOKIE_NAME);
    assert.ok(sessionToken);
    assert.match(deviceId ?? "", /^[0-9a-f]{32}$/);

    let devices = readUiSessionDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].id, deviceId);
    assert.equal(devices[0].label, "Chrome · Linux");

    // 同一浏览器再登录（带设备 id Cookie）：仍是一条，id 不变（此前每次登录新增一行）
    const again = await POST(loginRequest(`${UI_DEVICE_COOKIE_NAME}=${deviceId}`));
    assert.equal(again.status, 200);
    devices = readUiSessionDevices();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].id, deviceId);

    // 另一个浏览器（无设备 id Cookie）：另占一行
    const other = await POST(loginRequest(null));
    const otherCookies = other.headers.getSetCookie();
    const otherDeviceId = cookieValue(otherCookies, UI_DEVICE_COOKIE_NAME);
    assert.notEqual(otherDeviceId, deviceId);
    assert.equal(readUiSessionDevices().length, 2);

    // 伪造设备 id（非 32 位十六进制）不被采信：另建一行
    const forged = await POST(loginRequest(`${UI_DEVICE_COOKIE_NAME}=../../etc/passwd`));
    const forgedId = cookieValue(forged.headers.getSetCookie(), UI_DEVICE_COOKIE_NAME);
    assert.match(forgedId ?? "", /^[0-9a-f]{32}$/);
    assert.notEqual(forgedId, deviceId);
    assert.equal(readUiSessionDevices().length, 3);

    // 登出：当前设备记录被删除（不再残留到 10 年），设备 id Cookie 保留以便下次登录仍归同一行
    const logout = await DELETE(new Request("http://localhost/api/auth/ui-session", {
      method: "DELETE",
      headers: { cookie: `${UI_SESSION_COOKIE_NAME}=${sessionToken}` },
    }));
    assert.equal(logout.status, 200);
    const logoutCookies = logout.headers.getSetCookie();
    assert.equal(cookieValue(logoutCookies, UI_DEVICE_COOKIE_NAME), null);
    const remaining = readUiSessionDevices().map((d) => d.id);
    assert.equal(remaining.length, 2);
    assert.ok(!remaining.includes(deviceId));

    // 再次登录复用同一设备 id → 仍不新增行（回到 3 条）
    await POST(loginRequest(`${UI_DEVICE_COOKIE_NAME}=${deviceId}`));
    const after = readUiSessionDevices();
    assert.equal(after.length, 3);
    assert.equal(after.filter((d) => d.id === deviceId).length, 1);
  });
});

test("登录失败不注册设备记录", async () => {
  await withAgentEnv(async () => {
    const bad = await POST(new Request("http://localhost/api/auth/ui-session", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ password: "wrong password", trustDevice: true }),
    }));
    assert.equal(bad.status, 401);
    assert.deepEqual(readUiSessionDevices(), []);
  });
});
