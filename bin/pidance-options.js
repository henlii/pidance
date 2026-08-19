"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseArgs } = require("util");

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function isEnabled(value) {
  return typeof value === "string" && TRUE_VALUES.has(value.trim().toLowerCase());
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const { values: cliArgs } = parseArgs({
    args,
    options: {
      port:      { type: "string", short: "p" },
      hostname:  { type: "string", short: "H" },
      "no-open": { type: "boolean" },
    },
    strict: false,
  });

  return {
    // 显式端口（-p / PORT env）；未指定时由 pidance.js 回退到配置文件 port，再回退产品默认 31415。
    // 30141 留给上游 pi-web，避免同机抢端口。
    port: cliArgs.port ?? env.PORT ?? null,
    hostname: cliArgs.hostname ?? env.HOSTNAME ?? null,
    // PIDANCE_NO_OPEN 为产品正式变量。
    openBrowser:
      !cliArgs["no-open"] &&
      !isEnabled(env.PIDANCE_NO_OPEN),
  };
}

module.exports = { parseLaunchOptions };
