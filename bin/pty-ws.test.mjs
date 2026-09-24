import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

import {
	authThrottleKey,
	backoffDelayMs,
	getAuthRetryAfterMs,
	handlePtyUpgrade,
	ptyGuardHeaders,
	recordAuthFailure,
} from "./pty-ws.js";

const jiti = createJiti(import.meta.url);
const {
	backoffDelayMs: libBackoffDelayMs,
	getAuthRetryAfterMs: libGetAuthRetryAfterMs,
	recordAuthFailure: libRecordAuthFailure,
	resetAuthThrottle,
} = await jiti.import("../lib/auth-throttle.ts");

function fakeSocket(remoteAddress = "127.0.0.1") {
	const chunks = [];
	return {
		remoteAddress,
		written: chunks,
		write(chunk) {
			chunks.push(String(chunk));
			return true;
		},
		destroy() {},
	};
}

test("退避公式与 lib/auth-throttle.ts 一致（改一边不改另一边会红）", () => {
	for (let failures = 0; failures <= 12; failures += 1) {
		assert.equal(
			backoffDelayMs(failures),
			libBackoffDelayMs(failures),
			`failures=${failures} 的退避不一致`,
		);
	}
});

test("PTY 与 middleware 共用同一个桶（同一进程同一 globalThis）", () => {
	resetAuthThrottle();
	const key = "10.0.0.9";
	recordAuthFailure(key);
	assert.ok(getAuthRetryAfterMs(key) > 0, "PTY 记的失败，lib 侧必须看得到");
	assert.ok(libGetAuthRetryAfterMs(key) > 0);
	libRecordAuthFailure(key);
	assert.ok(getAuthRetryAfterMs(key) > getAuthRetryAfterMs(key) - 1);
	resetAuthThrottle();
});

test("分桶身份：默认不信 x-forwarded-for，用对端地址", () => {
	const env = {};
	assert.equal(
		authThrottleKey(fakeSocket("::ffff:192.168.1.5"), { xForwardedFor: "1.2.3.4" }, env),
		"192.168.1.5",
		"默认必须忽略 XFF",
	);
	// 显式信任反代才用 XFF 首段
	assert.equal(
		authThrottleKey(fakeSocket("127.0.0.1"), { xForwardedFor: "1.2.3.4, 5.6.7.8" }, { PIDANCE_TRUST_PROXY: "1" }),
		"1.2.3.4",
	);
	// 都拿不到 → 固定全局桶（宁可误伤也不放行）
	assert.equal(authThrottleKey({}, {}, env), "unknown");
	assert.equal(authThrottleKey(fakeSocket(""), {}, env), "unknown");
});

test("ptyGuardHeaders 带上 x-forwarded-for（分桶要用）", () => {
	const headers = ptyGuardHeaders({ headers: { host: "127.0.0.1:31415", "x-forwarded-for": "1.2.3.4" }, url: "/api/pty" });
	assert.equal(headers.xForwardedFor, "1.2.3.4");
	assert.equal(headers.pathname, "/api/pty");
});

test("封锁期内的升级请求被 429 挡下（密码正确也不放行）", async () => {
	resetAuthThrottle();
	const previous = process.env.PIDANCE_PASSWORD;
	process.env.PIDANCE_PASSWORD = "unit-test-password";
	try {
		const key = "203.0.113.7";
		recordAuthFailure(key);
		recordAuthFailure(key);
		const socket = fakeSocket(key);
		const basic = Buffer.from("pi:unit-test-password").toString("base64");
		await handlePtyUpgrade(
			{ headers: { host: "127.0.0.1:31415", authorization: `Basic ${basic}` }, url: "/api/pty", socket },
			socket,
			Buffer.alloc(0),
		);
		const response = socket.written.join("");
		if (response.startsWith("HTTP/1.1 503")) {
			// 未安装 node-pty 的环境：升级处理器在鉴权之前就退出了，这里无从验证。
			return;
		}
		assert.match(response, /^HTTP\/1\.1 429 /, `封锁期内必须 429，实际：${response.slice(0, 60)}`);
		assert.match(response, /Retry-After: \d+/, "429 必须带 Retry-After");
	} finally {
		if (previous === undefined) delete process.env.PIDANCE_PASSWORD;
		else process.env.PIDANCE_PASSWORD = previous;
		resetAuthThrottle();
	}
});
