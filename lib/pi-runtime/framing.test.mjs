import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { serializeJsonLine, JsonlLineBuffer } = await jiti.import("./framing.ts");

test("serializeJsonLine 以 LF 结尾且可 JSON.parse", () => {
	const line = serializeJsonLine({ type: "prompt", message: "hi" });
	assert.equal(line.endsWith("\n"), true);
	assert.equal(line.endsWith("\r\n"), false);
	assert.deepEqual(JSON.parse(line.trimEnd()), { type: "prompt", message: "hi" });
});

test("JsonlLineBuffer 仅按 LF 分帧，保留 U+2028 在 JSON 内", () => {
	const buf = new JsonlLineBuffer();
	const payload = { type: "event", text: "a\u2028b\u2029c" };
	const wire = `${JSON.stringify(payload)}\n`;
	// 分两半喂入
	const mid = Math.floor(wire.length / 2);
	assert.deepEqual(buf.push(wire.slice(0, mid)), []);
	const lines = buf.push(wire.slice(mid));
	assert.equal(lines.length, 1);
	assert.deepEqual(JSON.parse(lines[0]), payload);
});

test("JsonlLineBuffer 剥掉 CRLF 的 CR", () => {
	const buf = new JsonlLineBuffer();
	const lines = buf.push('{"a":1}\r\n{"b":2}\n');
	assert.equal(lines.length, 2);
	assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
	assert.deepEqual(JSON.parse(lines[1]), { b: 2 });
});

test("JsonlLineBuffer flush 残余无尾换行", () => {
	const buf = new JsonlLineBuffer();
	assert.deepEqual(buf.push('{"x":1}'), []);
	assert.deepEqual(JSON.parse(buf.flush()), { x: 1 });
	assert.equal(buf.flush(), null);
});
