/**
 * 主题副本一致性：`lib/pi-themes/*.json` 必须与当前 pi SDK 的主题同形。
 *
 * 为什么要有这条测试：副本是**手抄**的（发布审计红线不允许直接引用 SDK 包内文件），
 * 抄漏键不会抛错——SDK 的 Theme 构造器对缺失颜色有回退，于是漂的是**颜色值**
 * （实测：SDK 的 scrollbarTrack 是 darkGray，缺键时回退成 muted）。
 * 所以副本落后必须在测试里红，而不是等用户看出状态条/widget 颜色不对。
 *
 * 更新流程：升 SDK 时先跑这条，按失败的键把副本补齐（值照抄 SDK，不要手改）。
 * 新增内置主题时同步这里与 lib/tui-render-bridge.ts 的 BUILTIN_THEME_JSON。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

/** 内置主题名（dark/light 与 SDK 的 BUILTIN_THEMES 一致）。 */
const THEME_NAMES = ["dark", "light"];

function ourCopyPath(name) {
	return fileURLToPath(new URL(`./pi-themes/${name}.json`, import.meta.url));
}

function sdkThemePath(name) {
	return fileURLToPath(new URL(
		`../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/${name}.json`,
		import.meta.url,
	));
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

for (const name of THEME_NAMES) {
	test(`${name}.json 副本与 SDK 主题同键同值`, () => {
		assert.ok(existsSync(sdkThemePath(name)), `SDK 主题文件不存在：${sdkThemePath(name)}`);
		const ours = readJson(ourCopyPath(name));
		const sdk = readJson(sdkThemePath(name));

		assert.equal(ours.name, sdk.name, "主题名必须与 SDK 一致（插件按 name 识别主题）");
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

	test(`${name}.json 副本的每个颜色值都能在 vars 或合法颜色字面量里解析`, () => {
		const ours = readJson(ourCopyPath(name));
		const varNames = new Set(Object.keys(ours.vars));
		const unresolved = Object.entries(ours.colors)
			.filter(([, value]) => !varNames.has(value) && !/^#[0-9a-fA-F]{3,8}$/.test(value) && !/^(rgb|hsl)\(/.test(value))
			.map(([key, value]) => `${key}=${value}`);
		assert.deepEqual(unresolved, [], "颜色值必须是 vars 里的变量名或颜色字面量");
	});
}
