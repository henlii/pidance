/**
 * 主题副本一致性：`lib/pi-themes/dark.json` 必须与当前 pi SDK 的主题同形。
 *
 * 为什么要有这条测试：副本是**手抄**的（发布审计红线不允许直接引用 SDK 包内文件），
 * 抄漏键不会抛错——构造器对未知颜色有回退，于是漂的是**颜色值**
 * （实测：SDK 的 scrollbarTrack 是 darkGray，缺键时回退成 muted）。
 * 所以副本落后必须在测试里红，而不是等用户看出状态条/widget 颜色不对。
 *
 * 更新流程：升 SDK 时先跑这条，按失败的键把副本补齐（值照抄 SDK，不要手改）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ourCopyPath = fileURLToPath(new URL("./pi-themes/dark.json", import.meta.url));
const sdkThemePath = fileURLToPath(new URL(
	"../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json",
	import.meta.url,
));

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

test("dark.json 副本与 SDK 主题同键同值", () => {
	assert.ok(existsSync(sdkThemePath), `SDK 主题文件不存在：${sdkThemePath}`);
	const ours = readJson(ourCopyPath);
	const sdk = readJson(sdkThemePath);

	const missing = Object.keys(sdk.colors).filter((key) => !(key in ours.colors));
	assert.deepEqual(missing, [], "副本缺少 SDK 的颜色键（按 SDK 值补齐后再发版）");
	const extra = Object.keys(ours.colors).filter((key) => !(key in sdk.colors));
	assert.deepEqual(extra, [], "副本多出 SDK 没有的颜色键");

	const drifted = Object.entries(sdk.colors)
		.filter(([key, value]) => ours.colors[key] !== value)
		.map(([key]) => key);
	assert.deepEqual(drifted, [], "颜色值与 SDK 不一致（值会直接决定渲染颜色）");

	assert.deepEqual(ours.vars, sdk.vars, "vars 必须与 SDK 完全一致");
	assert.deepEqual(ours.export, sdk.export, "export 必须与 SDK 完全一致");
});

test("副本的每个颜色值都能在 vars 或合法颜色字面量里解析", () => {
	const ours = readJson(ourCopyPath);
	const varNames = new Set(Object.keys(ours.vars));
	const unresolved = Object.entries(ours.colors)
		.filter(([, value]) => !varNames.has(value) && !/^#[0-9a-fA-F]{3,8}$/.test(value) && !/^(rgb|hsl)\(/.test(value))
		.map(([key, value]) => `${key}=${value}`);
	assert.deepEqual(unresolved, [], "颜色值必须是 vars 里的变量名或颜色字面量");
});
