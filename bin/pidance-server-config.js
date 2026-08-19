"use strict";

// 读取 ~/.pi/agent/pidance-server.json（设置 → 通用 保存的服务端配置：密码哈希 + 远程开关）。
// JSON 形状与 lib/pidance-server-config.ts 兼容；bin 侧（启动门禁/默认绑定）只需布尔投影。
// 缺失/损坏一律降级为 { passwordSet: false, remoteEnabled: false }（fail-safe：默认仅本机）。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");

const SERVER_CONFIG_FILE_NAME = "pidance-server.json";

function configFilePath(agentDir) {
  const root =
    agentDir || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.join(root, SERVER_CONFIG_FILE_NAME);
}

function loadServerConfig(agentDir) {
  const fallback = { passwordSet: false, remoteEnabled: false, port: null };
  try {
    const filePath = configFilePath(agentDir);
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const hash = parsed && parsed.passwordHash;
    const port =
      parsed && typeof parsed.port === "number" &&
      Number.isInteger(parsed.port) && parsed.port >= 1 && parsed.port <= 65535
        ? parsed.port
        : null;
    return {
      passwordSet: Boolean(
        hash && typeof hash.salt === "string" && typeof hash.hash === "string",
      ),
      remoteEnabled: Boolean(parsed && parsed.remoteEnabled === true),
      port,
    };
  } catch {
    return fallback;
  }
}

module.exports = { loadServerConfig, configFilePath };
