import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isLoopbackHost,
	resolvePassword,
	shouldRequireAuth,
	describeHost,
} from "./pidance-auth-gate.js";

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
