#!/usr/bin/env node
/**
 * Pidance 持续测试版（31416）systemd 持久守护安装/卸载脚本。
 *
 * 背景：local-deploy.mjs 用 systemd-run 创建 transient unit（Restart=no），
 * 系统重启后不会自启、/tmp 状态与日志一并丢失。本脚本把 31416 测试版
 * 升级为持久 unit（Restart=always + enable），使工作区测试服务常驻：
 * 开机自启、崩溃自动拉起，且 local-deploy.mjs 的 restart/status 继续可用。
 *
 * 硬边界（与 AGENTS.md 一致）：
 * - 只操作 unit pidance-local-31416-<uid>.service；永不触碰 30141（上游
 *   pi-web）与 31415 正式版（pidance.service）。
 * - 同名 transient unit 接管前必须指纹校验（WorkingDirectory=仓库）；
 *   指纹不符拒绝操作。
 * - ExecStart 使用标准 nvm Node 绝对路径（/root/.nvm/versions/node/v24.18.0/bin，不写版本化软连接）
 *   与仓库内 Next CLI 绝对路径；日志独立于正式版（/var/log）。
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repository = realpathSync(
	resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const host = "0.0.0.0";
const port = 31416;
const healthUrl = "http://127.0.0.1:31416/api/home";
const uid = process.getuid?.() ?? "user";
const unitName = `pidance-local-31416-${uid}.service`;
const unitFile = `/etc/systemd/system/${unitName}`;
const logFile = `/var/log/${unitName}.log`;
const memoryHigh = "3G";
const memoryMax = "4G";
// 机器级密钥文件约定（与 31415 正式版 pidance.service.d/security.conf 一致）
const secretEnvFile = "/etc/pidance/secret.env";

// 回环判定（与 bin/pidance-auth-gate.js / lib/request-guard.ts 语义一致）：
// host 为回环地址时才允许无密码；否则必须提供认证密码，否则拒绝部署（fail-closed）。
function isLoopbackHostname(hostname) {
	if (typeof hostname !== "string" || hostname.length === 0) return false;
	let h = hostname.toLowerCase().replace(/\.$/, "");
	if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	const ip = isIP(h);
	if (ip === 4) return h.startsWith("127.");
	if (ip === 6) return h === "::1" || h === "0:0:0:0:0:0:0:1";
	return false;
}

// 密码来源：环境变量 PIDANCE_PASSWORD（优先，兼容 PI_WEB_PASSWORD）→ Environment=；
// 否则机器级 /etc/pidance/secret.env → EnvironmentFile=（600 权限，不落明文到 unit 文件）；
// 都没有 → null（非回环监听时 install 拒绝部署）。
function resolvePasswordSource(env) {
	const p = env?.PIDANCE_PASSWORD ?? env?.PI_WEB_PASSWORD;
	if (typeof p === "string" && p.length > 0) return { kind: "env", value: p };
	if (existsSync(secretEnvFile)) return { kind: "envfile", path: secretEnvFile };
	return null;
}

// systemd Environment="K=V" 引号值转义（反斜杠/双引号）。
function escapeSystemdValue(value) {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// 稳定 Node 入口：直接使用标准 nvm node 绝对路径（2026-08-03 起统一，
// 不再经 /root/.local/bin 软连接、不再指向 hermes 私有运行时）。
// 若与当前 execPath 指向同一文件则使用之，否则退回 process.execPath。
function resolveStableNode() {
	const candidates = ["/root/.nvm/versions/node/v24.18.0/bin/node"];
	for (const candidate of candidates) {
		try {
			if (realpathSync(candidate) === realpathSync(process.execPath))
				return candidate;
		} catch {
			/* 候选不存在，继续 */
		}
	}
	return process.execPath;
}

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	return {
		status: result.status ?? -1,
		stdout: result.stdout || "",
		stderr: result.stderr || "",
	};
}

function unitShow() {
	const result = run("systemctl", [
		"show",
		unitName,
		"--property=ActiveState,SubState,MainPID,WorkingDirectory,FragmentPath,LoadState",
		"--no-pager",
	]);
	if (result.status !== 0) return null;
	const props = {};
	for (const line of (result.stdout || "").split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return props.LoadState ? props : null;
}

function fail(message) {
	throw new Error(message);
}

function assertOwnedTransient(props) {
	if (
		!props ||
		props.LoadState === "not-found" ||
		props.FragmentPath?.startsWith("/run/systemd/transient/")
	) {
		if (props?.WorkingDirectory && props.WorkingDirectory !== repository) {
			fail(
				`拒绝接管：同名 unit ${unitName} 的 WorkingDirectory=${props.WorkingDirectory} 非本仓库`,
			);
		}
		return;
	}
	if (props.FragmentPath?.startsWith("/etc/systemd/system/")) return; // 已是持久 unit
	fail(`拒绝操作：unit ${unitName} 来源未知（${props?.FragmentPath ?? "?"}）`);
}

function buildUnitContent(nodeBin, nextCli, passwordSource) {
	const lines = [
		"# Pidance 持续测试版（31416）systemd 守护单元（由 scripts/install-31416-daemon.mjs 生成）",
		"# 仅此单元：pidance-local-31416-<uid>.service；31415 正式版见 pidance.service；30141 归上游 pi-web，永不操作",
		"",
		"[Unit]",
		"Description=Pidance continuous test deploy (workspace, 31416)",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		"User=root",
		"Group=root",
		`Environment=HOME=/root`,
		`Environment=PI_CODING_AGENT_DIR=/root/.pi/agent`,
		`Environment=PATH=/root/.nvm/versions/node/v24.18.0/bin:/root/.pi/agent/bin:/root/.local/bin:/usr/local/bin:/usr/bin:/bin`,
		`Environment=NODE_OPTIONS=--max-old-space-size=3072`,
		`Environment=PIDANCE_DIST_DIR=.next-public`,
		// 默认只用外部 pi（rpc）；仅显式 inprocess 才写回进程内
		`Environment=PIDANCE_AGENT_RUNTIME=${process.env.PIDANCE_AGENT_RUNTIME === "inprocess" ? "inprocess" : "rpc"}`,
	];
	if (process.env.PIDANCE_PI_RUNTIME) {
		lines.push(`Environment=PIDANCE_PI_RUNTIME=${process.env.PIDANCE_PI_RUNTIME}`);
	}
	// 默认不启用 bundled fallback；只有显式 =1 才写入
	if (process.env.PIDANCE_PI_RUNTIME_FALLBACK_BUNDLED === "1") {
		lines.push(`Environment=PIDANCE_PI_RUNTIME_FALLBACK_BUNDLED=1`);
	}
	if (process.env.PI_SUBAGENT_PI_BINARY) {
		lines.push(`Environment=PI_SUBAGENT_PI_BINARY=${process.env.PI_SUBAGENT_PI_BINARY}`);
	}
	// 非回环监听必须带认证密码（P0 fail-closed：0.0.0.0 无密码拒绝部署/启动）
	if (!isLoopbackHostname(host)) {
		if (passwordSource?.kind === "env") {
			lines.push(
				`Environment="PI_WEB_PASSWORD=${escapeSystemdValue(passwordSource.value)}"`,
			);
		} else if (passwordSource?.kind === "envfile") {
			lines.push(`EnvironmentFile=${passwordSource.path}`);
		}
	}
	lines.push(
		`WorkingDirectory=${repository}`,
		// 绝对稳定路径：仓库内 Next CLI；生产模式（next start）避免 dev 按需
		// 编译抖动与 V8 堆膨胀；PIDANCE_DIST_DIR 隔离产物，不污染 dev 的 .next
		//
		// 故意不在 ExecStartPre 里 next build：
		// - 代码更新由 local-deploy.mjs 先 build 一次再 systemctl restart（单次构建）
		// - 崩溃/开机自启直接复用已有 .next-public，秒级起来；避免与 local-deploy 叠成双 build（~10min）
		`ExecStart=${nodeBin} ${nextCli} start -H ${host} -p ${String(port)}`,
		// 崩溃自动拉起；systemctl stop 正常停止不触发重启
		"Restart=always",
		"RestartSec=3",
		"KillMode=control-group",
		// 无 ExecStartPre build，启动只需 next start（秒级）
		"TimeoutStartSec=60",
		"TimeoutStopSec=30",
		"LimitNOFILE=65536",
		`MemoryHigh=${memoryHigh}`,
		`MemoryMax=${memoryMax}`,
		// 日志独立于正式版（journal），进持久文件
		`StandardOutput=append:${logFile}`,
		`StandardError=append:${logFile}`,
		"StandardInput=null",
		"SyslogIdentifier=pidance-local-31416",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	);
	return lines.join("\n");
}

async function waitForHealth() {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(healthUrl);
			// 启用 PI_WEB_PASSWORD 时，中间件会在应用路由前返回 401；这同样证明
			// 本仓 Next 服务已监听。unit 来源与工作目录仍由安装流程校验。
			if ((response.status >= 200 && response.status < 300) || response.status === 401) return true;
		} catch {
			/* 等待监听 */
		}
		await new Promise((done) => setTimeout(done, 500));
	}
	return false;
}

async function install() {
	const nodeBin = resolveStableNode();
	// 非回环监听（0.0.0.0）必须携带认证密码（P0 fail-closed）：环境变量或机器级 secret.env 二选一
	const passwordSource = resolvePasswordSource(process.env);
	if (!isLoopbackHostname(host) && !passwordSource) {
		fail(
			`拒绝部署：监听地址 ${host} 非回环且未设置认证密码（发布阻断 P0）。` +
				`请设置环境变量 PIDANCE_PASSWORD（兼容 PI_WEB_PASSWORD）后重试，` +
				`或先创建 ${secretEnvFile}（含 PI_WEB_PASSWORD=...，权限 600）。`,
		);
	}
	const nextCli = join(
		repository,
		"node_modules",
		"next",
		"dist",
		"bin",
		"next",
	);
	if (!existsSync(nextCli)) fail(`Next CLI 不存在：${nextCli}`);
	if (!existsSync(unitFile)) {
		// 接管同名残留 unit（local-deploy 遗留）：先停（含指纹校验）；not-found 残留直接覆盖
		const props = unitShow();
		if (props && props.LoadState !== "not-found") {
			assertOwnedTransient(props);
			if (
				props.ActiveState === "active" ||
				props.ActiveState === "activating"
			) {
				const stop = run("systemctl", ["stop", unitName]);
				if (stop.status !== 0)
					fail(
						`停止遗留 transient unit 失败：${(stop.stderr || stop.stdout || "").trim()}`,
					);
			}
		}
	} else {
		const props = unitShow();
		if (props && !props.FragmentPath?.startsWith("/etc/systemd/system/")) {
			fail(
				`unit ${unitName} 已存在但来源异常（${props.FragmentPath}），拒绝覆盖`,
			);
		}
	}
	writeFileSync(unitFile, buildUnitContent(nodeBin, nextCli, passwordSource), { mode: 0o644 });
	chmodSync(unitFile, 0o644);
	const reload = run("systemctl", ["daemon-reload"]);
	if (reload.status !== 0)
		fail(`daemon-reload 失败：${(reload.stderr || "").trim()}`);
	const enable = run("systemctl", ["enable", unitName]);
	if (enable.status !== 0)
		fail(`enable 失败：${(enable.stderr || enable.stdout || "").trim()}`);
	const start = run("systemctl", ["restart", unitName]);
	if (start.status !== 0)
		fail(`start 失败：${(start.stderr || start.stdout || "").trim()}`);
	if (!(await waitForHealth())) {
		fail(`部署未通过健康检查；日志：${logFile}`);
	}
	const props = unitShow();
	console.log(
		JSON.stringify(
			{
				unit: unitName,
				file: unitFile,
				logFile,
				pid: Number(props?.MainPID || 0),
				active: props?.ActiveState === "active",
				enabled: true,
				url: healthUrl,
			},
			null,
			2,
		),
	);
}

function uninstall() {
	const props = unitShow();
	if (!props) fail(`unit ${unitName} 不存在`);
	assertOwnedTransient(props);
	if (!props.FragmentPath?.startsWith("/etc/systemd/system/")) {
		fail(
			`unit ${unitName} 不是持久 unit（${props.FragmentPath}），拒绝卸载；请用 local-deploy.mjs stop`,
		);
	}
	const disable = run("systemctl", ["disable", unitName]);
	if (disable.status !== 0)
		fail(`disable 失败：${(disable.stderr || "").trim()}`);
	const stop = run("systemctl", ["stop", unitName]);
	if (stop.status !== 0) fail(`stop 失败：${(stop.stderr || "").trim()}`);
	rmSync(unitFile, { force: true });
	run("systemctl", ["daemon-reload"]);
	console.log(`已卸载 ${unitName}（31416 已释放；30141/31415 未被操作）`);
}

function status() {
	const props = unitShow();
	if (!props) return console.log(`unit ${unitName} 未安装`);
	console.log(
		JSON.stringify(
			{
				unit: unitName,
				file: props.FragmentPath,
				active: props.ActiveState === "active",
				state: props.ActiveState,
				subState: props.SubState,
				pid: Number(props.MainPID || 0),
				logFile,
				persistent: Boolean(
					props.FragmentPath?.startsWith("/etc/systemd/system/"),
				),
			},
			null,
			2,
		),
	);
}

function help() {
	console.log(
		[
			"用法：node scripts/install-31416-daemon.mjs <install|uninstall|status|help>",
			`install：把 31416 测试版部署为持久 systemd unit ${unitName}（Restart=always + enable 自启），`,
			"         接管同名 transient unit（指纹校验后），健康检查通过后输出状态。",
			`         监听 ${host} 非回环时必须携带认证密码：环境变量 PIDANCE_PASSWORD（兼容`,
			`         PI_WEB_PASSWORD）或 ${secretEnvFile}（EnvironmentFile），否则拒绝部署。`,
			"uninstall：disable + stop + 删除 unit 文件，恢复由 local-deploy.mjs 管理。",
			"永不操作 30141（上游 pi-web）与 31415 正式版（pidance.service）。",
		].join("\n"),
	);
}

const command = process.argv[2] ?? "help";
try {
	if (command === "install") install();
	else if (command === "uninstall") uninstall();
	else if (command === "status") status();
	else if (command === "help") help();
	else fail(`未知命令：${command}`);
} catch (error) {
	console.error(`错误：${error instanceof Error ? error.message : "操作失败"}`);
	process.exitCode = 1;
}
