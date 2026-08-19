import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { parseLaunchOptions } = require("../bin/pidance-options.js");

test("opens the browser by default；未显式 -p/PORT 时 port 为 null（由 pidance.js 回退配置/默认）", () => {
  assert.deepEqual(parseLaunchOptions([], {}), {
    port: null,
    hostname: null,
    openBrowser: true,
  });
});

test("supports the no-open CLI option", () => {
  assert.equal(parseLaunchOptions(["--no-open"], {}).openBrowser, false);
});

test("supports truthy PIDANCE_NO_OPEN values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(parseLaunchOptions([], { PIDANCE_NO_OPEN: value }).openBrowser, false);
  }
});



test("does not disable browser opening for false PIDANCE_NO_OPEN values", () => {
  for (const value of ["0", "false", "off", ""]) {
    assert.equal(parseLaunchOptions([], { PIDANCE_NO_OPEN: value }).openBrowser, true);
  }
});



test("preserves port and hostname options", () => {
  assert.deepEqual(
    parseLaunchOptions(["-p", "8080", "-H", "127.0.0.1"], {}),
    {
      port: "8080",
      hostname: "127.0.0.1",
      openBrowser: true,
    },
  );
});
