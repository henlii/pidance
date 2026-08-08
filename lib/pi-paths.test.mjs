import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { homedir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const { getAgentDir, encodeCwdForSessionDir, getDefaultSessionDir } = await jiti.import("./pi-paths.ts");

test("getAgentDir 默认 ~/.pi/agent", () => {
	assert.equal(getAgentDir({}), join(homedir(), ".pi", "agent"));
});

test("getAgentDir 尊重 PI_CODING_AGENT_DIR", () => {
	assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: "/tmp/my-agent" }), "/tmp/my-agent");
});

test("encodeCwdForSessionDir", () => {
	assert.equal(encodeCwdForSessionDir("/root/works/open/pidance"), "--root-works-open-pidance--");
});

test("getDefaultSessionDir", () => {
	const d = getDefaultSessionDir("/root/works", { PI_CODING_AGENT_DIR: "/tmp/agent" });
	assert.equal(d, join("/tmp/agent", "sessions", "--root-works--"));
});
