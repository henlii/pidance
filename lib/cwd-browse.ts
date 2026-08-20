/**
 * 目录浏览（添加项目弹窗的目录预览，OpenChamber listLocalDirectory 语义）。
 * 只读：列出目录的子目录 + git 状态检测（仓库根 / 当前分支）。
 * 不做任何写入；越界/不存在路径由调用方（route）校验。
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const MAX_ENTRIES = 400;

/** 目录浏览已与 PTY 同等开放：不再隐藏 node_modules/dist/build 等目录。 */
export const BROWSE_IGNORED_NAMES = new Set<string>();

export type BrowseEntry = { name: string; path: string };

export type BrowseGitInfo = {
	isRepo: boolean;
	root: string | null;
	branch: string | null;
};

export type BrowseResult = {
	path: string;
	parentPath: string | null;
	entries: BrowseEntry[];
	git: BrowseGitInfo;
};

export function expandHome(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (trimmed === "~") return process.env.HOME ?? null;
	if (trimmed.startsWith("~/")) {
		const home = process.env.HOME;
		if (!home) return null;
		return path.join(home, trimmed.slice(2));
	}
	return path.isAbsolute(trimmed) ? trimmed : null;
}

/** 上级目录（根目录返回 null；上游 parentPath 语义）。 */
export function getBrowseParentPath(abs: string): string | null {
	const normalized = path.normalize(abs);
	const parent = path.dirname(normalized);
	return parent === normalized ? null : parent;
}

/** 输入路径的"浏览目录"：尾随 / 则本身，否则取父目录（OpenChamber getBrowseDirectoryPath）。 */
export function getBrowseDirectoryPath(input: string): string {
	const trimmed = input.trim();
	if (!trimmed || trimmed.endsWith("/")) return trimmed;
	const lastSep = trimmed.lastIndexOf("/");
	if (lastSep < 0) return trimmed;
	return trimmed.slice(0, lastSep + 1);
}

/** 输入路径的叶子段（过滤用；尾随 / 则无过滤）。 */
export function getBrowseLeafSegment(input: string): string {
	const trimmed = input.trim();
	if (trimmed.endsWith("/")) return "";
	const lastSep = trimmed.lastIndexOf("/");
	return lastSep < 0 ? trimmed : trimmed.slice(lastSep + 1);
}

async function detectGit(dir: string): Promise<BrowseGitInfo> {
	try {
		const { stdout: rootOut } = await execFileAsync(
			"git",
			["-C", dir, "rev-parse", "--show-toplevel"],
			{ timeout: GIT_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } },
		);
		const root = rootOut.trim() || null;
		if (!root) return { isRepo: false, root: null, branch: null };
		let branch: string | null = null;
		try {
			const { stdout: branchOut } = await execFileAsync(
				"git",
				["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"],
				{ timeout: GIT_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } },
			);
			const b = branchOut.trim();
			branch = b && b !== "HEAD" ? b : null;
		} catch {
			branch = null;
		}
		return { isRepo: true, root, branch };
	} catch {
		return { isRepo: false, root: null, branch: null };
	}
}

/**
 * 列出目录的子目录并检测 git 状态。
 * 输入可为绝对路径或 ~/ 前缀；返回 null 表示路径不存在/不是目录/非法。
 */
export async function browseDirectory(
	input: string,
): Promise<BrowseResult | null> {
	const abs = expandHome(input);
	if (!abs) return null;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(abs);
	} catch {
		return null;
	}
	if (!stat.isDirectory()) return null;

	let dirents: fs.Dirent[] = [];
	try {
		dirents = fs.readdirSync(abs, { withFileTypes: true });
	} catch {
		dirents = [];
	}

	const entries: BrowseEntry[] = [];
	for (const d of dirents) {
		if (BROWSE_IGNORED_NAMES.has(d.name)) continue;
		const full = path.join(abs, d.name);
		if (d.isDirectory()) {
			entries.push({ name: d.name, path: full });
		} else if (d.isSymbolicLink()) {
			// 对齐上游 0.8.6：符号链接目录经 realpath + stat 校验后跟随列出
			try {
				const real = fs.realpathSync(full);
				if (fs.statSync(real).isDirectory()) {
					entries.push({ name: d.name, path: full });
				}
			} catch {
				// broken symlink：跳过
			}
		}
		if (entries.length >= MAX_ENTRIES) break;
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const git = await detectGit(abs);
	return { path: abs, parentPath: getBrowseParentPath(abs), entries, git };
}
