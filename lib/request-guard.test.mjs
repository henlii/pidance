import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	hostnameFromHostHeader,
	isTrustedHost,
	checkCsrf,
	checkBasicAuth,
	checkUiSessionCookie,
	checkAuthenticated,
	passwordEnabled,
	isLoopbackHost,
	resolvePassword,
	guardRequest,
	isPublicAuthApi,
} = await jiti.import("../lib/request-guard.ts");
const {
	signUiSessionJwt,
	UI_SESSION_COOKIE_NAME,
	UI_SESSION_TTL_MS,
} = await jiti.import("../lib/ui-session.ts");
const {
	hashPassword: makeStoredHash,
} = await jiti.import("../lib/pidance-server-config.ts");

const EMPTY_ENV = {};

function h(over = {}) {
	return {
		host: "127.0.0.1:31415",
		origin: null,
		secFetchSite: null,
		secFetchMode: null,
		secFetchDest: null,
		secFetchUser: null,
		authorization: null,
		cookie: null,
		method: "GET",
		url: "http://127.0.0.1:31415/api/sessions",
		pathname: "/api/sessions",
		...over,
	};
}

test("hostnameFromHostHeader 提取 hostname", () => {
	assert.equal(hostnameFromHostHeader("127.0.0.1:31415"), "127.0.0.1");
	assert.equal(hostnameFromHostHeader("localhost"), "localhost");
	assert.equal(hostnameFromHostHeader("[::1]:31415"), "::1");
	assert.equal(hostnameFromHostHeader("user:pass@evil.com"), null);
	assert.equal(hostnameFromHostHeader(""), null);
});

test("isTrustedHost：localhost/IP 放行，未知域名拒绝，白名单放行", () => {
	assert.equal(isTrustedHost("localhost:31415", EMPTY_ENV), true);
	assert.equal(isTrustedHost("127.0.0.1:31415", EMPTY_ENV), true);
	assert.equal(isTrustedHost("[::1]", EMPTY_ENV), true);
	assert.equal(isTrustedHost("evil.example.com", EMPTY_ENV), false);
	assert.equal(isTrustedHost("pidance.example.com", { PI_WEB_HOSTNAME: "pidance.example.com" }), true);
	assert.equal(isTrustedHost("a.example.com", { PI_WEB_ALLOWED_HOSTS: " a.example.com, b.example.com " }), true);
	assert.equal(isTrustedHost("c.example.com", { PI_WEB_ALLOWED_HOSTS: "a.example.com" }), false);
	assert.equal(isTrustedHost(null, EMPTY_ENV), false);
});

test("checkCsrf：无跨站信号放行；cross-site 拒绝；origin 同源校验", () => {
	assert.equal(checkCsrf(h()), true); // curl 无头
	assert.equal(checkCsrf(h({ secFetchSite: "same-origin", origin: "http://127.0.0.1:31415" })), true);
	assert.equal(checkCsrf(h({ secFetchSite: "cross-site" })), false);
	assert.equal(checkCsrf(h({ origin: "http://evil.com", secFetchSite: "same-site" })), false);
	assert.equal(checkCsrf(h({ origin: "http://127.0.0.1:31416", secFetchSite: "same-origin" })), false); // 端口不同
	// export navigate 豁免
	const exportReq = h({
		pathname: "/api/sessions/abc123/export",
		url: "http://127.0.0.1:31415/api/sessions/abc123/export",
		method: "GET",
		secFetchMode: "navigate",
		secFetchDest: "document",
		secFetchUser: "?1",
		secFetchSite: "cross-site",
		origin: "http://other.example.com",
	});
	assert.equal(checkCsrf(exportReq), true);
});

test("passwordEnabled / checkBasicAuth：PI_WEB_PASSWORD 可选 Basic Auth", () => {
	assert.equal(passwordEnabled({}), false);
	assert.equal(passwordEnabled({ PI_WEB_PASSWORD: "" }), false);
	assert.equal(passwordEnabled({ PI_WEB_PASSWORD: "s3cret" }), true);

	const env = { PI_WEB_PASSWORD: "s3cret" };
	// 未启用时不拦
	assert.equal(checkBasicAuth(h(), {}), false);
	// 启用后无 Authorization → false
	assert.equal(checkBasicAuth(h(), env), false);
	// 正确凭据 pi:s3cret
	const ok = Buffer.from("pi:s3cret").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${ok}` }), env), true);
	// 错误密码 / 错误用户 / 非 Basic
	const bad = Buffer.from("pi:wrong").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${bad}` }), env), false);
	const badUser = Buffer.from("root:s3cret").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${badUser}` }), env), false);
	assert.equal(checkBasicAuth(h({ authorization: "Bearer xyz" }), env), false);
	// 非法 base64
	assert.equal(checkBasicAuth(h({ authorization: "Basic !!!" }), env), false);
});

test("isLoopbackHost：localhost / 127.x / ::1 放行，其它拒绝", () => {
	assert.equal(isLoopbackHost("127.0.0.1:31415"), true);
	assert.equal(isLoopbackHost("127.8.9.10:31415"), true);
	assert.equal(isLoopbackHost("localhost:31415"), true);
	assert.equal(isLoopbackHost("api.localhost:31415"), true);
	assert.equal(isLoopbackHost("[::1]:31415"), true);
	assert.equal(isLoopbackHost("[0:0:0:0:0:0:0:1]:31415"), true);
	assert.equal(isLoopbackHost("192.168.1.5:31415"), false);
	assert.equal(isLoopbackHost("10.0.0.1"), false);
	assert.equal(isLoopbackHost("myhost:31415"), false);
	assert.equal(isLoopbackHost("fe80::1"), false);
	assert.equal(isLoopbackHost(null), false);
	assert.equal(isLoopbackHost(""), false);
});

test("resolvePassword / passwordEnabled：PIDANCE_PASSWORD 优先，兼容 PI_WEB_PASSWORD", () => {
	assert.equal(passwordEnabled({}), false);
	assert.equal(passwordEnabled({ PI_WEB_PASSWORD: "" }), false);
	assert.equal(passwordEnabled({ PIDANCE_PASSWORD: "s3cret" }), true);
	assert.equal(passwordEnabled({ PI_WEB_PASSWORD: "s3cret" }), true);
	assert.equal(passwordEnabled({ PIDANCE_PASSWORD: "", PI_WEB_PASSWORD: "s3cret" }), true);
	assert.equal(resolvePassword({ PIDANCE_PASSWORD: "a", PI_WEB_PASSWORD: "b" }), "a");
	assert.equal(resolvePassword({ PI_WEB_PASSWORD: "b" }), "b");
	assert.equal(resolvePassword({}), null);
	// 新变量优先：旧值不生效
	const envNew = { PIDANCE_PASSWORD: "new", PI_WEB_PASSWORD: "old" };
	const okNew = Buffer.from("pi:new").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${okNew}` }), envNew), true);
	const okOld = Buffer.from("pi:old").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${okOld}` }), envNew), false);
});

test("guardRequest：无密码时非回环请求 auth-required（fail-closed 兜底）", () => {
	// 回环 + 无密码 → ok（本地开发便利）
	assert.equal(guardRequest(h({ host: "127.0.0.1:31415" }), EMPTY_ENV), "ok");
	assert.equal(guardRequest(h({ host: "localhost:31415" }), EMPTY_ENV), "ok");
	// 非回环 + 无密码 → auth-required（兜底；即使 CLI 门禁被绕过也保护）
	assert.equal(guardRequest(h({ host: "192.168.1.5:31415" }), EMPTY_ENV), "auth-required");
	assert.equal(guardRequest(h({ host: "10.0.0.7:31415" }), EMPTY_ENV), "auth-required");
	// 非回环 + 已设密码 → 未认证 auth-required，认证 ok
	const env = { PI_WEB_PASSWORD: "pw" };
	assert.equal(guardRequest(h({ host: "192.168.1.5:31415" }), env), "auth-required");
	const ok = Buffer.from("pi:pw").toString("base64");
	assert.equal(
		guardRequest(h({ host: "192.168.1.5:31415", authorization: `Basic ${ok}` }), env),
		"ok",
	);
	// 回环 + 已设密码 + 未认证 → auth-required（原语义保持）
	assert.equal(guardRequest(h({ host: "127.0.0.1:31415" }), env), "auth-required");
	// 未设置密码且 Host 为未知域名 → 仍是 untrusted-host（Host 白名单优先）
	assert.equal(guardRequest(h({ host: "evil.example.com" }), EMPTY_ENV), "untrusted-host");
});

test("guardRequest 完整判定", () => {
	assert.equal(guardRequest(h(), EMPTY_ENV), "ok");
	assert.equal(guardRequest(h({ host: "evil.com" }), EMPTY_ENV), "untrusted-host");
	assert.equal(guardRequest(h({ secFetchSite: "cross-site" }), EMPTY_ENV), "csrf");
	const env = { PI_WEB_PASSWORD: "pw" };
	assert.equal(guardRequest(h(), env), "auth-required");
	const ok = Buffer.from("pi:pw").toString("base64");
	assert.equal(guardRequest(h({ authorization: `Basic ${ok}` }), env), "ok");
});

test("UI 会话 Cookie 或 Basic 均可认证（#18）", () => {
	const env = { PI_WEB_PASSWORD: "pw", PIDANCE_UI_JWT_SECRET: "unit-test-secret-key-32bytes!!" };
	const secret = "unit-test-secret-key-32bytes!!";
	const token = signUiSessionJwt(secret, UI_SESSION_TTL_MS);
	const cookie = `${UI_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
	assert.equal(checkUiSessionCookie(h({ cookie }), env, secret), true);
	assert.equal(checkAuthenticated(h({ cookie }), env, secret), true);
	assert.equal(guardRequest(h({ cookie }), env, { jwtSecret: secret }), "ok");
	// 无效 cookie 仍可走 Basic
	const ok = Buffer.from("pi:pw").toString("base64");
	assert.equal(
		guardRequest(h({ cookie: `${UI_SESSION_COOKIE_NAME}=bad`, authorization: `Basic ${ok}` }), env, { jwtSecret: secret }),
		"ok",
	);
	// 公开登录 API 放行
	assert.equal(isPublicAuthApi("/api/auth/ui-session"), true);
	assert.equal(
		guardRequest(h({ pathname: "/api/auth/ui-session", url: "http://127.0.0.1:31415/api/auth/ui-session" }), env),
		"ok",
	);
});
test("passwordEnabled / checkBasicAuth：配置文件 scrypt 哈希（设置 → 通用 保存的密码）", () => {
	const config = { passwordHash: makeStoredHash("cfg-pass"), remoteEnabled: false };
	assert.equal(passwordEnabled({}), false);
	assert.equal(passwordEnabled({}, config), true);
	// env 密码优先于配置哈希
	const env = { PI_WEB_PASSWORD: "env-pass" };
	assert.equal(passwordEnabled(env, config), true);
	const okEnv = Buffer.from("pi:env-pass").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${okEnv}` }), env, config), true);
	const okCfg = Buffer.from("pi:cfg-pass").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${okCfg}` }), env, config), false);
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${okCfg}` }), {}, config), true);
	const bad = Buffer.from("pi:wrong").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${bad}` }), {}, config), false);
	const badUser = Buffer.from("root:cfg-pass").toString("base64");
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${badUser}` }), {}, config), false);
	// 无配置且无 env → false
	assert.equal(checkBasicAuth(h({ authorization: `Basic ${okCfg}` }), {}), false);
});

test("guardRequest：配置文件密码同样启用认证与 Basic 放行", () => {
	const config = { passwordHash: makeStoredHash("cfg-pass"), remoteEnabled: false };
	const ok = Buffer.from("pi:cfg-pass").toString("base64");
	// 回环 + 配置密码 + 未认证 → auth-required
	assert.equal(guardRequest(h({ host: "127.0.0.1:31415" }), EMPTY_ENV, { config }), "auth-required");
	// 回环 + Basic → ok
	assert.equal(
		guardRequest(h({ host: "127.0.0.1:31415", authorization: `Basic ${ok}` }), EMPTY_ENV, { config }),
		"ok",
	);
	// 非回环 + 配置密码 + 未认证 → auth-required
	assert.equal(guardRequest(h({ host: "192.168.1.5:31415" }), EMPTY_ENV, { config }), "auth-required");
	assert.equal(
		guardRequest(h({ host: "192.168.1.5:31415", authorization: `Basic ${ok}` }), EMPTY_ENV, { config }),
		"ok",
	);
	// 无密码配置时非回环仍 fail-closed
	const empty = { passwordHash: null, remoteEnabled: false };
	assert.equal(guardRequest(h({ host: "192.168.1.5:31415" }), EMPTY_ENV, { config: empty }), "auth-required");
	// 配置密码 + UI 会话 Cookie 同样通过
	const env = { PIDANCE_UI_JWT_SECRET: "unit-test-secret-key-32bytes!!" };
	const secret = "unit-test-secret-key-32bytes!!";
	const token = signUiSessionJwt(secret, UI_SESSION_TTL_MS);
	const cookie = `${UI_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
	assert.equal(
		guardRequest(h({ host: "127.0.0.1:31415", cookie }), env, { jwtSecret: secret, config }),
		"ok",
	);
});
test("UI 会话设备校验：删除设备后 cookie 失效（deviceStore 注入）", () => {
	const env = { PI_WEB_PASSWORD: "pw", PIDANCE_UI_JWT_SECRET: "unit-test-secret-key-32bytes!!" };
	const secret = "unit-test-secret-key-32bytes!!";
	const jti = "device-xyz";
	const token = signUiSessionJwt(secret, UI_SESSION_TTL_MS, Date.now(), jti);
	const cookie = `${UI_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
	// 设备存在 → cookie 认证通过
	const storeWithDevice = { has: (id) => id === jti };
	assert.equal(checkUiSessionCookie(h({ cookie }), env, secret, null, storeWithDevice), true);
	assert.equal(guardRequest(h({ cookie }), env, { jwtSecret: secret, deviceStore: storeWithDevice }), "ok");
	// 设备被删除 → cookie 认证失败（需 Basic 才能通过）
	const emptyStore = { has: () => false };
	assert.equal(checkUiSessionCookie(h({ cookie }), env, secret, null, emptyStore), false);
	assert.equal(guardRequest(h({ cookie }), env, { jwtSecret: secret, deviceStore: emptyStore }), "auth-required");
	const ok = Buffer.from("pi:pw").toString("base64");
	assert.equal(
		guardRequest(h({ cookie, authorization: `Basic ${ok}` }), env, { jwtSecret: secret, deviceStore: emptyStore }),
		"ok",
	);
	// 无 jti 的旧 cookie：不查设备注册表，仅验签
	const legacy = signUiSessionJwt(secret, UI_SESSION_TTL_MS);
	const legacyCookie = `${UI_SESSION_COOKIE_NAME}=${encodeURIComponent(legacy)}`;
	assert.equal(checkUiSessionCookie(h({ cookie: legacyCookie }), env, secret, null, emptyStore), true);
});
