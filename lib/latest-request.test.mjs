import assert from "node:assert/strict";
import test from "node:test";

import { createLatestRequestGuard } from "./latest-request.ts";

test("只有最新一次请求是 current（先发后到的响应必须被判为过期）", () => {
  const guard = createLatestRequestGuard();
  const first = guard.next();
  assert.equal(guard.isCurrent(first), true);
  const second = guard.next();
  // 旧请求还在飞：它已经过期，后到也不能写状态
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
  const third = guard.next();
  assert.equal(guard.isCurrent(second), false);
  assert.equal(guard.isCurrent(third), true);
});

test("invalidate 让所有在途请求作废（卸载路径）", () => {
  const guard = createLatestRequestGuard();
  const inFlight = guard.next();
  guard.invalidate();
  assert.equal(guard.isCurrent(inFlight), false);
  // 作废之后新开的请求仍然有效
  const next = guard.next();
  assert.equal(guard.isCurrent(next), true);
  assert.equal(guard.isCurrent(inFlight), false);
});

test("两个守卫互不影响（同组件多处并发请求各管各的）", () => {
  const a = createLatestRequestGuard();
  const b = createLatestRequestGuard();
  const idA = a.next();
  const idB = b.next();
  a.next();
  assert.equal(a.isCurrent(idA), false);
  assert.equal(b.isCurrent(idB), true);
});
