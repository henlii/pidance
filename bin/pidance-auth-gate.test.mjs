import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

import {
	isLoopbackHost,
	resolvePassword,
	primeAndScrubPassword,
	shouldRequireAuth,
	describeHost,
} from "./pidance-auth-gate.js";

const jiti = createJiti(import.meta.url);
const { resolvePassword: resolveGuardPassword, rescrabAuthPassword, clearAuthPasswordCache } =
	await jiti.import("../lib/request-guard.ts");

test("isLoopbackHost：回环地址放行，非回环/未指定拒绝", () => {
	// 回环 → true
	assert.equal(isLoopbackHost("127.0.0.1"), true);
	assert.equal(isLoopbackHost("127.8.9.10"), true);
	assert.equal(isLoopbackHost("localhost"), true);
	assert.equal(isLoopbackHost("api.localhost"), true);
	assert.equal(isLoopbackHost("::1"), true);
	assert.equal(isLoopbackHost("0:0:0:0:0:0:0:1"), true);
	assert.equal(isLoopbackHost("[::1]"), true);
	// 非回环 → false
	assert.equal(isLoopbackHost("0.0.0.0"), false);
	assert.equal(isLoopbackHost("::"), false);
	assert.equal(isLoopbackHost("203.0.113.5"), false);
	assert.equal(isLoopbackHost("10.0.0.1"), false);
	assert.equal(isLoopbackHost("myhost"), false); // 非回环主机名
	assert.equal(isLoopbackHost("fe80::1"), false);
	// 未指定 → false（Next 默认绑定 0.0.0.0）
	assert.equal(isLoopbackHost(null), false);
	assert.equal(isLoopbackHost(undefined), false);
	assert.equal(isLoopbackHost(""), false);
});

test("resolvePassword：PIDANCE_PASSWORD 优先，回退 PI_WEB_PASSWORD，空串视为未设置", () => {
	assert.equal(resolvePassword({}), null);
	assert.equal(resolvePassword(undefined), null);
	assert.equal(resolvePassword({ PIDANCE_PASSWORD: "" }), null);
	assert.equal(resolvePassword({ PI_WEB_PASSWORD: "" }), null);
	assert.equal(resolvePassword({ PIDANCE_PASSWORD: "a", PI_WEB_PASSWORD: "b" }), "a");
	assert.equal(resolvePassword({ PI_WEB_PASSWORD: "b" }), "b");
});

test("shouldRequireAuth：非回环 + 无密码 → 拒绝启动；有密码或回环 → 放行", () => {
	// 非回环 + 无密码 → 拒绝启动
	assert.equal(shouldRequireAuth("0.0.0.0", undefined), true);
	assert.equal(shouldRequireAuth("::", undefined), true);
	assert.equal(shouldRequireAuth("203.0.113.5", undefined), true);
	assert.equal(shouldRequireAuth("myhost", undefined), true);
	assert.equal(shouldRequireAuth(null, undefined), true); // 未指定 → Next 默认 0.0.0.0
	// 回环 + 无密码 → 正常启动（本地开发便利）
	assert.equal(shouldRequireAuth("127.0.0.1", undefined), false);
	assert.equal(shouldRequireAuth("localhost", undefined), false);
	assert.equal(shouldRequireAuth("::1", undefined), false);
	// 非回环 + 已设密码 → 正常启动
	assert.equal(shouldRequireAuth("0.0.0.0", "s3cret"), false);
	assert.equal(shouldRequireAuth("0.0.0.0", ""), true); // 空密码视为未设置
});

test("describeHost：未指定地址给出 Next 默认说明", () => {
	assert.equal(describeHost("0.0.0.0"), "0.0.0.0");
	assert.equal(describeHost(null).includes("127.0.0.1"), true);
	assert.equal(describeHost(undefined).includes("127.0.0.1"), true);
});

// ── 密码搬进进程内缓存 + 从 env 抹掉（agent bash 不得看到密码）──────────────

test("primeAndScrubPassword：两个变量名都从 env 删除，值进缓存", () => {
	const env = { PIDANCE_PASSWORD: "s3cret", PI_WEB_PASSWORD: "legacy", KEEP: "x" };
	const value = primeAndScrubPassword(env);
	assert.equal(value, "s3cret", "PIDANCE_PASSWORD 优先");
	assert.equal("PIDANCE_PASSWORD" in env, false);
	assert.equal("PI_WEB_PASSWORD" in env, false);
	assert.equal(env.KEEP, "x", "无关变量不动");
});

test("缓存跨模块图可读：服务端 request-guard 与 CLI 读到同一个密码", () => {
	// CLI（bin/pidance.js）启动时写入；middleware / route 是另一个 bundle，
	// 通过 globalThis 读同一个值（Next 的 Node middleware 是 require 进同进程的）。
	primeAndScrubPassword({ PIDANCE_PASSWORD: "s3cret" });
	assert.equal(resolveGuardPassword({}), "s3cret", "env 为空也要能读到缓存");
	assert.equal(resolvePassword({}), "s3cret", "CLI 侧同样读到缓存");
	clearAuthPasswordCache();
	assert.equal(resolveGuardPassword({}), null, "清缓存后回退读 env");
});

test("未设密码时缓存值为 null，不会误判为已启用认证", () => {
	primeAndScrubPassword({});
	assert.equal(resolvePassword({}), null);
	assert.equal(resolveGuardPassword({}), null);
	clearAuthPasswordCache();
});

test("只删不搬会 fail-open，所以搬运是必需的：env 删掉后缓存仍给出密码", () => {
	const env = { PI_WEB_PASSWORD: "legacy-only" };
	primeAndScrubPassword(env);
	assert.equal(env.PI_WEB_PASSWORD, undefined);
	assert.equal(resolveGuardPassword(env), "legacy-only");
	clearAuthPasswordCache();
});

test("SDK bash 工具的命令环境不含密码（净化后 process.env 已空）", async () => {
	// 行为断言：SDK 的 getShellEnv 返回 { ...process.env, PATH }，所以只要启动时
	// 把密码搬走，agent 的 bash 就拿不到它。
	const shellSource = readFileSync(
		new URL("../node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js", import.meta.url),
		"utf8",
	);
	// 静态门禁：SDK 若不再从 process.env 取命令环境，这条先红，提示重新评估净化点。
	assert.match(shellSource, /export function getShellEnv\(\)[^]*?\.\.\.process\.env/);

	process.env.PIDANCE_PASSWORD = "s3cret";
	process.env.PI_WEB_PASSWORD = "legacy";
	try {
		primeAndScrubPassword(process.env);
		// 这就是 SDK bash 工具构造命令环境的方式：{ ...process.env }
		const commandEnvironment = { ...process.env };
		assert.equal("PIDANCE_PASSWORD" in commandEnvironment, false);
		assert.equal("PI_WEB_PASSWORD" in commandEnvironment, false);
		// 而认证仍可用（缓存里还有值），不是 fail-open
		assert.equal(resolveGuardPassword(process.env), "s3cret");
	} finally {
		clearAuthPasswordCache();
		delete process.env.PIDANCE_PASSWORD;
		delete process.env.PI_WEB_PASSWORD;
	}
});

test("Next 载入 .env 写回密码后，重新净化仍让 shell 环境保持干净", () => {
	// @next/env 的 loadEnvConfig 会 replaceProcessEnv(初始快照) 并把 .env* 里
	// 快照没有的键并进来 —— 启动时删掉的密码键会被填回 process.env。
	const env = { PIDANCE_PASSWORD: "s3cret", KEEP: "x" };
	primeAndScrubPassword(env);
	env.PIDANCE_PASSWORD = "from-dotenv";
	assert.equal(rescrabAuthPassword(env), "s3cret", "启动时定过的优先级不被 .env 覆盖");
	const commandEnvironment = { ...env };
	assert.equal(commandEnvironment.PIDANCE_PASSWORD, undefined);
	assert.equal(JSON.stringify(commandEnvironment).includes("from-dotenv"), false);
	assert.equal(resolveGuardPassword(env), "s3cret", "认证不受影响");
	clearAuthPasswordCache();
});

test("只有 .env 提供密码时，重新净化采纳它而不是 fail-open", () => {
	const env = {};
	primeAndScrubPassword(env);
	assert.equal(resolveGuardPassword(env), null, "启动时确实没有密码");
	env.PIDANCE_PASSWORD = "from-dotenv";
	assert.equal(rescrabAuthPassword(env), "from-dotenv");
	assert.equal(resolveGuardPassword(env), "from-dotenv", "缓存建立后 env 已删，仍要能认证");
	assert.equal(JSON.stringify({ ...env }).includes("from-dotenv"), false);
	clearAuthPasswordCache();
});
