/**
 * Pidance 服务端配置（认证密码 + 远程服务开关）。
 *
 * - 文件：`~/.pi/agent/pidance-server.json`（与 pidance-ui-jwt-secret 同目录，agentDir 可用
 *   PI_CODING_AGENT_DIR 覆盖）
 * - 结构：`{ passwordHash: { salt, hash } | null, remoteEnabled: boolean }`
 * - 密码以 scrypt 哈希落盘（参数与 lib/ui-session 的 hashPasswordScrypt 一致），文件权限 0600、
 *   同目录临时文件 + rename 原子写；永不回写明文
 * - env 密码（PIDANCE_PASSWORD / PI_WEB_PASSWORD）在请求守卫中优先于文件哈希（见 request-guard）
 * - 损坏/缺失降级为默认 `{ passwordHash: null, remoteEnabled: false }`（fail-safe：默认仅本机）
 * - 变更规则（applyServerConfigChange）为纯函数，供路由与测试复用：远程开关开启必须已有密码，
 *   已设密码后修改/清除必须提供当前密码
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export const SERVER_CONFIG_FILE_NAME = "pidance-server.json";
export const MIN_PASSWORD_LENGTH = 6;

export type PasswordHash = { salt: string; hash: string };
export type ServerConfig = {
  passwordHash: PasswordHash | null;
  remoteEnabled: boolean;
  /** 监听端口；null = 产品默认 31415 */
  port: number | null;
};

export type ServerConfigStore = {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, enc: "utf8") => string;
  writeFileSync: (p: string, data: string, opts: { mode: number }) => void;
  renameSync: (from: string, to: string) => void;
  mkdirSync: (p: string, opts: { recursive: boolean }) => void;
};

const defaultStore: ServerConfigStore = {
  existsSync: (p) => fs.existsSync(p),
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
  renameSync: (from, to) => fs.renameSync(from, to),
  mkdirSync: (p, opts) => { fs.mkdirSync(p, opts); },
};

export function defaultServerConfigPath(agentDir?: string): string {
  const root = agentDir
    ?? process.env.PI_CODING_AGENT_DIR
    ?? path.join(homedir(), ".pi", "agent");
  return path.join(root, SERVER_CONFIG_FILE_NAME);
}

/** scrypt 哈希（与 ui-session.hashPasswordScrypt 同参数：normalize + trim + 64 字节派生）。 */
export function hashPassword(password: string): PasswordHash {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize().trim(), salt, 64);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

export function verifyConfigPassword(candidate: string, stored: PasswordHash): boolean {
  if (!candidate || !stored || !stored.salt || !stored.hash) return false;
  try {
    const expected = Buffer.from(stored.hash, "hex");
    const salt = Buffer.from(stored.salt, "hex");
    // 畸形哈希（hex 解码截断为空）直接拒绝，避免空 Buffer 比较通过
    if (expected.length === 0 || salt.length === 0) return false;
    const actual = scryptSync(candidate.normalize().trim(), salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function passwordHashConfigured(config: ServerConfig | null | undefined): boolean {
  return Boolean(config?.passwordHash);
}

/** 读取配置：缺失/损坏一律降级为默认（不抛错，调用方无需 try）。 */
export function readServerConfig(
  filePath = defaultServerConfigPath(),
  store: ServerConfigStore = defaultStore,
): ServerConfig {
  const fallback: ServerConfig = { passwordHash: null, remoteEnabled: false, port: null };
  try {
    if (!store.existsSync(filePath)) return fallback;
    const raw = store.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    const hash = parsed.passwordHash;
    const passwordHash =
      hash && typeof hash === "object"
      && typeof (hash as PasswordHash).salt === "string"
      && typeof (hash as PasswordHash).hash === "string"
        ? { salt: (hash as PasswordHash).salt, hash: (hash as PasswordHash).hash }
        : null;
    const port =
      typeof parsed.port === "number"
      && Number.isInteger(parsed.port)
      && parsed.port >= 1
      && parsed.port <= 65535
        ? parsed.port
        : null;
    return {
      passwordHash,
      remoteEnabled: parsed.remoteEnabled === true,
      port,
    };
  } catch {
    return fallback;
  }
}

/** 原子写（同目录临时文件 + rename），权限 0600。 */
export function writeServerConfig(
  config: ServerConfig,
  filePath = defaultServerConfigPath(),
  store: ServerConfigStore = defaultStore,
): void {
  store.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  store.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  store.renameSync(tmp, filePath);
}

/** env 密码（已解析明文）或文件哈希任一存在即视为已配置密码。 */
export function passwordConfigured(envPassword: string | null, config?: ServerConfig | null): boolean {
  return (typeof envPassword === "string" && envPassword.length > 0) || passwordHashConfigured(config);
}

export type ServerConfigChange = {
  /** 设置/更换密码（空串视为未提供） */
  password?: string;
  /** 清除密码 */
  clearPassword?: boolean;
  /** 远程服务开关（未提供则保持） */
  remoteEnabled?: boolean;
  /** 监听端口（1-65535 整数）；null = 重置为产品默认 31415；未提供则保持 */
  port?: number | null;
};

export type ServerConfigApplyResult =
  | { config: ServerConfig; changedPassword: boolean }
  | { error: string };

/**
 * 应用密码/远程开关变更（纯规则，route 与测试共用）。
 *
 * 规则：
 * - 设置密码：长度 >= MIN_PASSWORD_LENGTH；无需旧密码（设置页本身受认证门禁保护）
 * - 清除密码：幂等；远程开关开启时拒绝（见下）
 * - password 与 clearPassword 同时提供 → bad_request
 * - 最终状态校验：远程开关开启且无密码 → remote_requires_password
 * - changedPassword 标记密码哈希是否变化（route 据此轮换 UI 会话 JWT secret）
 */
export function applyServerConfigChange(
  current: ServerConfig,
  change: ServerConfigChange,
  envPassword: string | null,
): ServerConfigApplyResult {
  let nextHash = current.passwordHash;
  let changedPassword = false;

  const hasNewPassword = typeof change.password === "string" && change.password.length > 0;
  if (hasNewPassword && change.clearPassword === true) {
    return { error: "bad_request" };
  }
  if (hasNewPassword) {
    if (change.password!.length < MIN_PASSWORD_LENGTH) {
      return { error: "password_too_short" };
    }
    nextHash = hashPassword(change.password!);
    changedPassword = true;
  } else if (change.clearPassword === true) {
    nextHash = null;
    changedPassword = current.passwordHash !== null;
  }

  const remoteEnabled = change.remoteEnabled ?? current.remoteEnabled;
  let nextPort = current.port;
  if (change.port !== undefined) {
    if (change.port === null) {
      nextPort = null;
    } else if (
      typeof change.port === "number"
      && Number.isInteger(change.port)
      && change.port >= 1
      && change.port <= 65535
    ) {
      nextPort = change.port;
    } else {
      return { error: "port_invalid" };
    }
  }
  const nextPasswordSet = passwordConfigured(envPassword, {
    passwordHash: nextHash,
    remoteEnabled,
    port: nextPort,
  });
  if (remoteEnabled && !nextPasswordSet) {
    return { error: "remote_requires_password" };
  }

  return { config: { passwordHash: nextHash, remoteEnabled, port: nextPort }, changedPassword };
}
