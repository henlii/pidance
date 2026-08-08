import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { switchRuntimeSlot } = await jiti.import("./runtime-switch.ts");

test("forbidden：31415 默认拒绝切换", () => {
	const r = switchRuntimeSlot("0.84.1", { PORT: "31415" });
	assert.equal(r.ok, false);
	if (!r.ok) assert.equal(r.code, "forbidden");
});

test("not_found：无 slot", () => {
	const root = mkdtempSync(join(tmpdir(), "pidance-sw-"));
	try {
		const r = switchRuntimeSlot("0.84.1", {
			PORT: "31416",
			PIDANCE_PI_RUNTIME_EXPLICIT_UPGRADE: "1",
			PIDANCE_PI_RUNTIME_SLOTS_DIR: root,
		});
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.code, "not_found");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("成功切换 current 符号链接", () => {
	const root = mkdtempSync(join(tmpdir(), "pidance-sw-"));
	try {
		mkdirSync(join(root, "0.81.1"), { recursive: true });
		mkdirSync(join(root, "0.84.1"), { recursive: true });
		// 可执行假 pi：--version 输出
		const piPath = join(root, "0.84.1", "pi");
		writeFileSync(
			piPath,
			"#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 0.84.1; exit 0; fi\nexit 0\n",
			{ mode: 0o755 },
		);
		const r = switchRuntimeSlot("0.84.1", {
			PORT: "31416",
			PIDANCE_PI_RUNTIME_EXPLICIT_UPGRADE: "1",
			PIDANCE_PI_RUNTIME_SLOTS_DIR: root,
		});
		assert.equal(r.ok, true);
		if (r.ok) {
			assert.equal(r.version, "0.84.1");
			assert.equal(readlinkSync(join(root, "current")), join(root, "0.84.1"));
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
