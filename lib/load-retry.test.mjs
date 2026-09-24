/**
 * load-retry（#91）：超时算可重试失败、取消不算失败、重试用尽抛 LoadFailedError。
 *
 * 对应现场证据：连接被饿住时请求一个字节都收不到（既不 resolve 也不 reject），
 * 没有超时的加载路径会把界面永久留在 loading。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { LoadFailedError, isRetryableStatus, loadWithBoundedRetry } = await jiti.import("./load-retry.ts");

function response(status) {
  return { ok: status >= 200 && status < 300, status };
}

function abortLike() {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/** 永不返回、只在 abort 时才 reject 的 fetch（模拟被饿住的请求）。 */
function hangingFetch() {
  return (_url, options) =>
    new Promise((_resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) return reject(abortLike());
      signal?.addEventListener("abort", () => reject(abortLike()));
    });
}

/** 记录每次重试等待时长的注入定时器（立即执行，测试不等真实时间）。 */
function recordingSchedule() {
  const delays = [];
  return {
    delays,
    schedule(fn, ms) {
      delays.push(ms);
      fn();
    },
  };
}

test("首次成功：只请求一次，不重试", async () => {
  let calls = 0;
  const res = await loadWithBoundedRetry({
    url: "/api/x",
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    maxRetries: 2,
    retryDelayMs: 10,
    fetchImpl: async () => {
      calls += 1;
      return response(200);
    },
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
});

test("5xx 是可重试失败：第二次成功即返回，并按 retryDelayMs × 次数等待", async () => {
  const { delays, schedule } = recordingSchedule();
  const failures = [];
  let calls = 0;
  const res = await loadWithBoundedRetry({
    url: "/api/x",
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    maxRetries: 2,
    retryDelayMs: 1_500,
    schedule,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? response(503) : response(200);
    },
    onAttemptFailed: (failure, attempt) => failures.push([failure.kind, attempt]),
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1_500]);
  assert.deepEqual(failures, [["http", 1]]);
});

test("重试用尽：抛 LoadFailedError，attempts = 1 + maxRetries，失败原因可读", async () => {
  const { schedule } = recordingSchedule();
  let calls = 0;
  await assert.rejects(
    () => loadWithBoundedRetry({
      url: "/api/x",
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxRetries: 2,
      retryDelayMs: 10,
      schedule,
      fetchImpl: async () => {
        calls += 1;
        return response(503);
      },
    }),
    (error) => {
      assert.ok(error instanceof LoadFailedError, "应是 LoadFailedError");
      assert.equal(error.attempts, 3);
      assert.equal(error.failure.kind, "http");
      assert.equal(error.failure.status, 503);
      return true;
    },
  );
  assert.equal(calls, 3);
});

test("超时算可重试失败：三次都超时后抛 LoadFailedError(kind=timeout)", async () => {
  const { schedule } = recordingSchedule();
  await assert.rejects(
    () => loadWithBoundedRetry({
      url: "/api/x",
      signal: new AbortController().signal,
      timeoutMs: 15,
      maxRetries: 2,
      retryDelayMs: 5,
      schedule,
      fetchImpl: hangingFetch(),
    }),
    (error) => {
      assert.ok(error instanceof LoadFailedError);
      assert.equal(error.attempts, 3);
      assert.equal(error.failure.kind, "timeout");
      return true;
    },
  );
});

test("超时后重试成功：说明「饿住」是暂时性的，第二次就通", async () => {
  const { schedule } = recordingSchedule();
  let calls = 0;
  const res = await loadWithBoundedRetry({
    url: "/api/x",
    signal: new AbortController().signal,
    timeoutMs: 15,
    maxRetries: 2,
    retryDelayMs: 5,
    schedule,
    fetchImpl: (url, options) => {
      calls += 1;
      if (calls === 1) return hangingFetch()(url, options);
      return Promise.resolve(response(200));
    },
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

test("调用方取消（切走/被取代）：抛 AbortError、不重试、不算失败", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = loadWithBoundedRetry({
    url: "/api/x",
    signal: controller.signal,
    timeoutMs: 5_000,
    maxRetries: 2,
    retryDelayMs: 10,
    fetchImpl: (url, options) => {
      calls += 1;
      return hangingFetch()(url, options);
    },
  });
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    return true;
  });
  assert.equal(calls, 1, "取消后不得再发起下一次尝试");
});

test("404 直接返回给调用方判断，不重试", async () => {
  let calls = 0;
  const res = await loadWithBoundedRetry({
    url: "/api/x",
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    maxRetries: 2,
    retryDelayMs: 10,
    fetchImpl: async () => {
      calls += 1;
      return response(404);
    },
  });
  assert.equal(res.status, 404);
  assert.equal(calls, 1);
});

test("重试等待按次数递增（1×、2×）", async () => {
  const { delays, schedule } = recordingSchedule();
  await assert.rejects(() => loadWithBoundedRetry({
    url: "/api/x",
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    maxRetries: 2,
    retryDelayMs: 1_500,
    schedule,
    fetchImpl: async () => response(500),
  }));
  assert.deepEqual(delays, [1_500, 3_000]);
});

test("isRetryableStatus：5xx / 408 / 429 可重试，其余 4xx 不可", () => {
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(404), false);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(200), false);
});
