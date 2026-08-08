import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	listRuntimeSlots,
	resolveUpgradePolicy,
	buildUpgradeSnapshot,
	resolveSlotBinary,
} = await jiti.import("./runtime-upgrade.ts");

test("31415 默认禁自动升级", () => {
	const p = resolveUpgradePolicy({ PORT: "31415" });
	assert.equal(p.allowAutoUpgrade, false);
});

test("31416 默认可显式、禁自动", () => {
	const p = resolveUpgradePolicy({ PORT: "31416", PIDANCE_PI_RUNTIME_AUTO_UPGRADE: "0" });
	assert.equal(p.allowAutoUpgrade, false);
	assert.equal(p.allowExplicitUpgrade, true);
});

test("listRuntimeSlots 枚举 version 目录与 current", () => {
	const root = mkdtempSync(join(tmpdir(), "pidance-slots-"));
	try {
		mkdirSync(join(root, "0.81.1"), { recursive: true });
		mkdirSync(join(root, "0.84.1"), { recursive: true });
		writeFileSync(join(root, "0.84.1", "pi"), "#!/bin/sh\necho 0.84.1\n", { mode: 0o755 });
		symlinkSync(join(root, "0.81.1"), join(root, "current"));
		const { slots, current } = listRuntimeSlots(root);
		assert.equal(slots.length, 2);
		assert.equal(current?.version, "0.81.1");
		assert.equal(slots.find((s) => s.version === "0.81.1")?.isCurrent, true);
		const bin = resolveSlotBinary(join(root, "0.84.1"));
		assert.ok(bin && bin.endsWith(`${join("0.84.1", "pi")}`) || bin?.includes("0.84.1"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("buildUpgradeSnapshot：有更新 slot 时 recommendation=available", () => {
	const root = mkdtempSync(join(tmpdir(), "pidance-slots-"));
	try {
		mkdirSync(join(root, "0.81.1"), { recursive: true });
		mkdirSync(join(root, "0.84.1"), { recursive: true });
		symlinkSync(join(root, "0.81.1"), join(root, "current"));
		const snap = buildUpgradeSnapshot(
			{ PORT: "31416", PIDANCE_PI_RUNTIME_SLOTS_DIR: root },
			"0.81.1",
		);
		assert.equal(snap.recommendation, "available");
		assert.equal(snap.current?.version, "0.81.1");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
