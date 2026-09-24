import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import {
  AUTH_THROTTLE_BASE_DELAY_MS,
  AUTH_THROTTLE_MAX_DELAY_MS,
  AUTH_THROTTLE_RESET_AFTER_MS,
  backoffDelayMs,
  getAuthRetryAfterMs,
  recordAuthFailure,
  recordAuthSuccess,
  resetAuthThrottle,
  retryAfterSeconds,
} from "./auth-throttle.ts";

beforeEach(() => resetAuthThrottle());

test("backoffDelayMs：1s 起步、每次翻倍、60s 封顶", () => {
  assert.equal(backoffDelayMs(0), 0);
  assert.equal(backoffDelayMs(1), AUTH_THROTTLE_BASE_DELAY_MS);
  assert.equal(backoffDelayMs(2), 2 * AUTH_THROTTLE_BASE_DELAY_MS);
  assert.equal(backoffDelayMs(3), 4 * AUTH_THROTTLE_BASE_DELAY_MS);
  assert.equal(backoffDelayMs(64), AUTH_THROTTLE_MAX_DELAY_MS);
  assert.equal(backoffDelayMs(1e6), AUTH_THROTTLE_MAX_DELAY_MS);
});

test("失败累加退避，等待结束后可再尝试", () => {
  const key = "10.0.0.5";
  assert.equal(getAuthRetryAfterMs(key, 1_000), 0);

  assert.equal(recordAuthFailure(key, 1_000), 1_000);
  assert.equal(getAuthRetryAfterMs(key, 1_500), 500);
  assert.equal(getAuthRetryAfterMs(key, 2_000), 0);

  assert.equal(recordAuthFailure(key, 2_000), 2_000);
  assert.equal(getAuthRetryAfterMs(key, 3_000), 1_000);
});

test("空闲 5 分钟复位：复位窗口必须长于最大退避", () => {
  assert.ok(AUTH_THROTTLE_RESET_AFTER_MS > AUTH_THROTTLE_MAX_DELAY_MS);
  const key = "10.0.0.6";
  recordAuthFailure(key, 0);
  recordAuthFailure(key, 1_000);
  assert.equal(backoffDelayMs(2), 2_000);

  const later = 1_000 + AUTH_THROTTLE_RESET_AFTER_MS + 1;
  assert.equal(getAuthRetryAfterMs(key, later), 0);
  assert.equal(recordAuthFailure(key, later), AUTH_THROTTLE_BASE_DELAY_MS, "复位后退避回到基准");
});

test("按桶隔离：一个地址被封锁不影响另一个地址", () => {
  recordAuthFailure("10.0.0.7", 1_000);
  assert.ok(getAuthRetryAfterMs("10.0.0.7", 1_000) > 0);
  assert.equal(getAuthRetryAfterMs("10.0.0.8", 1_000), 0);
});

test("表单登录成功复位本桶；桶不存在时读取安全", () => {
  const key = "10.0.0.9";
  recordAuthFailure(key, 1_000);
  recordAuthSuccess(key);
  assert.equal(getAuthRetryAfterMs(key, 1_000), 0);
  assert.equal(getAuthRetryAfterMs("never-seen", 1_000), 0);
});

test("retryAfterSeconds：被封锁时至少 1 秒", () => {
  assert.equal(retryAfterSeconds(0), 1);
  assert.equal(retryAfterSeconds(1), 1);
  assert.equal(retryAfterSeconds(1_001), 2);
});

test("桶数超上限时清理已过期桶，不无界增长", () => {
  const now = 1_000_000;
  for (let i = 0; i < 300; i += 1) recordAuthFailure(`peer-${i}`, now);
  const stale = now + AUTH_THROTTLE_RESET_AFTER_MS + 1;
  // 过期后再写入一次，触发清理
  recordAuthFailure("fresh-peer", stale);
  assert.equal(getAuthRetryAfterMs("peer-0", stale), 0, "过期桶已被清理");
  assert.ok(getAuthRetryAfterMs("fresh-peer", stale) > 0);
});
