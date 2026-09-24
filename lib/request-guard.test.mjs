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
	primeAuthPassword,
	rescrabAuthPassword,
	clearAuthPasswordCache,
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
const {
	getAuthRetryAfterMs,
	resetAuthThrottle,
} = await jiti.import("../lib/auth-throttle.ts");

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
		peerAddress: null,
		xForwardedFor: null,
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

// ---------------------------------------------------------------------------
// Issue #37 D1：把「无密码回环兜底」的真实边界固定下来。
//
// 该兜底依据的是请求 Host 头（请求方可自行提供），**不是** TCP 来源地址；
// Next.js middleware 拿不到对端地址，因此它只能作为纵深防御，不能替代
// bin/pidance.js 的启动门禁（非回环监听且无密码时拒绝启动）。
// 这两条断言是该语义的显式记录，防止有人误以为它是来源地址校验。
// ---------------------------------------------------------------------------
test("#37 无密码回环兜底的边界：Host 可被伪造，故不能当作来源校验", () => {
	// 攻击者自行把 Host 写成回环名 → 兜底判定为 ok（这正是它的局限）
	assert.equal(
		guardRequest(h({ host: "localhost:31415", origin: "http://localhost:31415" }), EMPTY_ENV),
		"ok",
		"Host 由请求方提供，兜底无法识别真实来源",
	);
	// 但 Host 白名单仍然生效：伪造/未知域名在更前面就被拒
	assert.equal(guardRequest(h({ host: "evil.example.com" }), EMPTY_ENV), "untrusted-host");
	// 已设置密码时，回环也不再免认证（兜底不参与）
	const env = { PI_WEB_PASSWORD: "pw" };
	assert.equal(guardRequest(h({ host: "localhost:31415" }), env), "auth-required");
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

// ── 认证限流（Basic 与登录表单共用桶）────────────────────────────────────────

const BASIC_ENV = { PIDANCE_PASSWORD: "pw" };
const PEER_A = "192.168.1.10";
const PEER_B = "192.168.1.11";

function basic(password) {
	return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}

test("Basic 尝试计入限流：失败一次后即使密码正确也被退避拦下", () => {
	resetAuthThrottle();
	const wrong = h({ peerAddress: PEER_A, authorization: basic("guess") });
	assert.equal(guardRequest(wrong, BASIC_ENV), "auth-required");
	assert.ok(getAuthRetryAfterMs(PEER_A) > 0, "失败应立刻产生退避");

	// 封锁期内即便密码正确也返回 throttled（否则响应本身就是密码预言机）
	const right = h({ peerAddress: PEER_A, authorization: basic("pw") });
	assert.equal(guardRequest(right, BASIC_ENV), "throttled");
});

test("x-forwarded-for 变化不能重置计数（默认不信任该头）", () => {
	resetAuthThrottle();
	assert.equal(
		guardRequest(h({ peerAddress: PEER_A, xForwardedFor: "1.1.1.1", authorization: basic("guess") }), BASIC_ENV),
		"auth-required",
	);
	assert.equal(
		guardRequest(h({ peerAddress: PEER_A, xForwardedFor: "2.2.2.2", authorization: basic("pw") }), BASIC_ENV),
		"throttled",
	);
});

test("按对端分桶：一个地址被封锁不影响另一个地址", () => {
	resetAuthThrottle();
	guardRequest(h({ peerAddress: PEER_A, authorization: basic("guess") }), BASIC_ENV);
	assert.equal(guardRequest(h({ peerAddress: PEER_B, authorization: basic("guess") }), BASIC_ENV), "auth-required");
	assert.equal(getAuthRetryAfterMs(PEER_B) > 0, true);
});

test("无对端地址时退固定全局桶（宁可误伤也不放行）", () => {
	resetAuthThrottle();
	guardRequest(h({ authorization: basic("guess") }), BASIC_ENV);
	assert.equal(guardRequest(h({ authorization: basic("pw") }), BASIC_ENV), "throttled");
});

test("PIDANCE_TRUST_PROXY=1 时才按 x-forwarded-for 分桶", () => {
	resetAuthThrottle();
	const env = { ...BASIC_ENV, PIDANCE_TRUST_PROXY: "1" };
	guardRequest(h({ xForwardedFor: "203.0.113.7", authorization: basic("guess") }), env);
	assert.equal(
		guardRequest(h({ xForwardedFor: "203.0.113.7", authorization: basic("pw") }), env),
		"throttled",
	);
	assert.equal(
		guardRequest(h({ xForwardedFor: "203.0.113.8", authorization: basic("guess") }), env),
		"auth-required",
		"不同代理来源互不影响",
	);
});

test("合法会话 Cookie 不受封锁影响", () => {
	resetAuthThrottle();
	const env = { ...BASIC_ENV, PIDANCE_UI_JWT_SECRET: "unit-test-secret-key-32bytes!!" };
	const secret = "unit-test-secret-key-32bytes!!";
	guardRequest(h({ peerAddress: PEER_A, authorization: basic("guess") }), env);
	token: {
		const token = signUiSessionJwt(secret, UI_SESSION_TTL_MS);
		const cookie = `${UI_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
		assert.equal(
			guardRequest(h({ peerAddress: PEER_A, cookie, authorization: basic("pw") }), env, { jwtSecret: secret }),
			"ok",
		);
	}
});

test("非 Basic 的 Authorization 不算密码尝试", () => {
	resetAuthThrottle();
	const verdict = guardRequest(h({ peerAddress: PEER_A, authorization: "Bearer something" }), BASIC_ENV);
	assert.equal(verdict, "auth-required");
	assert.equal(getAuthRetryAfterMs(PEER_A), 0, "不得记账");
});

test("公开认证 API 也受限流约束（不是不限速的密码预言机）", () => {
	resetAuthThrottle();
	const path = "/api/auth/ui-session";
	const url = "http://127.0.0.1:31415/api/auth/ui-session";
	assert.equal(
		guardRequest(h({ peerAddress: PEER_A, pathname: path, url, authorization: basic("guess") }), BASIC_ENV),
		"auth-required",
	);
	assert.equal(
		guardRequest(h({ peerAddress: PEER_A, pathname: path, url, authorization: basic("pw") }), BASIC_ENV),
		"throttled",
	);
});

test("无密码时 Basic 头不记账（没有可猜的密码）", () => {
	resetAuthThrottle();
	assert.equal(guardRequest(h({ peerAddress: PEER_A, authorization: basic("guess") }), EMPTY_ENV), "ok");
	assert.equal(getAuthRetryAfterMs(PEER_A), 0);
});

// ── 密码搬进缓存 + Next 载入 `.env*` 之后重新净化 ──────────────────────

test("rescrabAuthPassword：缓存为空时采纳 .env 写回的密码，再删掉环境变量", () => {
	clearAuthPasswordCache();
	const env = {};
	// 启动时 env 里没有密码（只有 .env 提供）→ 缓存是 { value: null }
	primeAuthPassword(env);
	assert.equal(resolvePassword(env), null);
	// 模拟 @next/env 的 loadEnvConfig 把 `.env` 里的密码写回 process.env
	env.PIDANCE_PASSWORD = "from-dotenv";
	assert.equal(rescrabAuthPassword(env), "from-dotenv", "必须采纳 .env 的值，否则认证 fail-open");
	assert.equal(env.PIDANCE_PASSWORD, undefined, "采纳后必须从 process.env 删掉");
	assert.equal(env.PI_WEB_PASSWORD, undefined);
	assert.equal(resolvePassword({}), "from-dotenv", "缓存仍是权威来源");
	clearAuthPasswordCache();
});

test("rescrabAuthPassword：缓存已有值时不被 .env 覆盖，且两个变量名都删", () => {
	clearAuthPasswordCache();
	const env = { PIDANCE_PASSWORD: "from-cli" };
	primeAuthPassword(env);
	delete env.PIDANCE_PASSWORD;
	env.PI_WEB_PASSWORD = "from-dotenv";
	assert.equal(rescrabAuthPassword(env), "from-cli", "启动时定过的优先级不被覆盖");
	assert.equal(env.PI_WEB_PASSWORD, undefined);
	assert.equal(env.PIDANCE_PASSWORD, undefined);
	clearAuthPasswordCache();
});

test("rescrabAuthPassword：env 里没有密码时保持未设置（不把 null 当成有密码）", () => {
	clearAuthPasswordCache();
	primeAuthPassword({});
	const env = {};
	assert.equal(rescrabAuthPassword(env), null);
	assert.equal(passwordEnabled(env), false);
	clearAuthPasswordCache();
});

test("未搬过缓存时 resolvePassword 仍读 env（CLI / 测试直接调用路径）", () => {
	clearAuthPasswordCache();
	assert.equal(resolvePassword({ PIDANCE_PASSWORD: "plain" }), "plain");
	assert.equal(resolvePassword({ PI_WEB_PASSWORD: "legacy" }), "legacy");
});
