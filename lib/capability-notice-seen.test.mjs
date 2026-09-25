import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_NOTICE_SEEN_KEY,
  MAX_SEEN_CAPABILITY_FEATURES,
  capabilityFeatureOf,
  loadSeenCapabilityFeatures,
  markCapabilityFeatureSeen,
} from "./capability-notice-seen.ts";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, value),
    raw: map,
  };
}

test("从宿主的两条提示句式里取出能力名", () => {
  assert.equal(
    capabilityFeatureOf('Extension UI "onTerminalInput" is limited by the Pidance web client: handlers only receive…'),
    "onTerminalInput",
  );
  assert.equal(
    capabilityFeatureOf('Extension UI "addAutocompleteProvider" is not supported by the Pidance web client.'),
    "addAutocompleteProvider",
  );
});

test("插件自己的通知不做一次性抑制（认不出句式）", () => {
  assert.equal(capabilityFeatureOf("Background task failed"), null);
  assert.equal(capabilityFeatureOf(""), null);
  assert.equal(capabilityFeatureOf('Extension UI "" is not supported'), null);
});

test("标记后能读回，同一能力不会重复写", () => {
  const storage = fakeStorage();
  assert.equal(loadSeenCapabilityFeatures(storage).size, 0);
  markCapabilityFeatureSeen(storage, "onTerminalInput");
  markCapabilityFeatureSeen(storage, "onTerminalInput");
  const seen = loadSeenCapabilityFeatures(storage);
  assert.deepEqual([...seen], ["onTerminalInput"]);
  assert.equal(JSON.parse(storage.raw.get(CAPABILITY_NOTICE_SEEN_KEY)).length, 1);
});

test("有上限：超出保留最新的", () => {
  const storage = fakeStorage();
  for (let i = 0; i < MAX_SEEN_CAPABILITY_FEATURES + 5; i += 1) {
    markCapabilityFeatureSeen(storage, `feature-${i}`);
  }
  const seen = [...loadSeenCapabilityFeatures(storage)];
  assert.equal(seen.length, MAX_SEEN_CAPABILITY_FEATURES);
  assert.equal(seen.includes("feature-0"), false, "最旧的应被丢弃");
  assert.equal(seen.includes(`feature-${MAX_SEEN_CAPABILITY_FEATURES + 4}`), true);
});

test("损坏输入 / 存储不可用都安全降级", () => {
  assert.equal(loadSeenCapabilityFeatures(fakeStorage({ [CAPABILITY_NOTICE_SEEN_KEY]: "{不是 JSON" })).size, 0);
  assert.equal(loadSeenCapabilityFeatures(fakeStorage({ [CAPABILITY_NOTICE_SEEN_KEY]: '{"a":1}' })).size, 0);
  assert.equal(loadSeenCapabilityFeatures(null).size, 0);
  markCapabilityFeatureSeen(null, "onTerminalInput");
  const throwing = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
  };
  assert.equal(loadSeenCapabilityFeatures(throwing).size, 0);
  markCapabilityFeatureSeen(throwing, "onTerminalInput");
});
