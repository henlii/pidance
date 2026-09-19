import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./chat-scroll-anchor.ts");
}

function pending(overrides = {}) {
  return {
    generation: 1,
    sessionId: "A",
    visibleCount: 50,
    distance: 800,
    renderedHeadKey: "turn-0",
    anchor: { entryId: "e-0", offset: 40 },
    ...overrides,
  };
}

test("数据 prepend 尚未扩窗：渲染头变了也不消费", async () => {
  const { shouldApplyPrependCompensation } = await loadSubject();
  const snap = pending();
  // 40 项计划、visibleCount 50；服务端 prepend 80 后计划 120，窗口仍是末 50
  // 渲染头已经不是 turn-0，但 visibleCount 还没涨 → 必须留着快照
  assert.equal(
    shouldApplyPrependCompensation({
      pending: snap,
      sessionId: "A",
      generation: 1,
      renderedHeadKey: "pre-70",
      visibleCount: 50,
    }),
    false,
  );
  // 同一次事务把 visibleCount 补到 130 后才消费
  assert.equal(
    shouldApplyPrependCompensation({
      pending: snap,
      sessionId: "A",
      generation: 1,
      renderedHeadKey: "pre-0",
      visibleCount: 130,
    }),
    true,
  );
});

test("连续两次本地扩窗：各自 generation，旧快照不能套新窗口", async () => {
  const { shouldApplyPrependCompensation } = await loadSubject();
  const first = pending({ generation: 1, renderedHeadKey: "m50", visibleCount: 50 });
  assert.equal(
    shouldApplyPrependCompensation({
      pending: first,
      sessionId: "A",
      generation: 1,
      renderedHeadKey: "m0",
      visibleCount: 100,
    }),
    true,
  );
  const second = pending({ generation: 2, renderedHeadKey: "m0", visibleCount: 100 });
  assert.equal(
    shouldApplyPrependCompensation({
      pending: second,
      sessionId: "A",
      generation: 1,
      renderedHeadKey: "older",
      visibleCount: 150,
    }),
    false,
  );
  assert.equal(
    shouldApplyPrependCompensation({
      pending: second,
      sessionId: "A",
      generation: 2,
      renderedHeadKey: "older",
      visibleCount: 150,
    }),
    true,
  );
});

test("A→B→A：旧 generation 不得消费新会话的窗口", async () => {
  const { shouldApplyPrependCompensation } = await loadSubject();
  const fromFirstVisit = pending({ generation: 1, sessionId: "A" });
  assert.equal(
    shouldApplyPrependCompensation({
      pending: fromFirstVisit,
      sessionId: "A",
      generation: 3,
      renderedHeadKey: "other",
      visibleCount: 100,
    }),
    false,
  );
});

test("切会话 / 空快照 / 未知头不套用", async () => {
  const { shouldApplyPrependCompensation } = await loadSubject();
  const snap = pending();
  assert.equal(shouldApplyPrependCompensation({ pending: null, sessionId: "A", generation: 1, renderedHeadKey: "b", visibleCount: 100 }), false);
  assert.equal(shouldApplyPrependCompensation({ pending: snap, sessionId: "B", generation: 1, renderedHeadKey: "b", visibleCount: 100 }), false);
  assert.equal(shouldApplyPrependCompensation({ pending: snap, sessionId: "A", generation: 1, renderedHeadKey: null, visibleCount: 100 }), false);
});

test("findChatAnchorElement：message 身份在分组后回退到 process", async () => {
  const { findChatAnchorElement } = await loadSubject();
  const container = {
    querySelector(selector) {
      if (selector.includes('data-chat-anchor="message:e1"')) return null;
      if (selector.includes('data-chat-anchor="process:e1"')) return { id: "process-el" };
      return null;
    },
  };
  assert.equal(findChatAnchorElement(container, "message:e1").id, "process-el");
});

test("pickReadingAnchor：优先覆盖阅读线的在视块，否则取最近", async () => {
  const { pickReadingAnchor } = await loadSubject();
  const covering = pickReadingAnchor({
    clientHeight: 580,
    items: [
      { id: "user", offset: 50, height: 80 },
      { id: "process", offset: 203, height: 400 },
      { id: "below", offset: 900, height: 100 },
    ],
  });
  assert.equal(covering?.id, "process");
  assert.equal(covering?.offset, 203);
  const nearest = pickReadingAnchor({
    clientHeight: 692,
    items: [
      { id: "user", offset: 90, height: 80 },
      { id: "process", offset: 323, height: 400 },
    ],
  });
  assert.equal(nearest?.id, "process");
});

test("scrollTopForAnchorOffset：把锚点消息贴回捕获时的容器顶偏移", async () => {
  const { scrollTopForAnchorOffset } = await loadSubject();
  assert.equal(
    scrollTopForAnchorOffset({
      elementTop: 420,
      containerTop: 0,
      scrollTop: 100,
      offset: 20,
    }),
    500,
  );
});

test("40 项计划 / visibleCount 50 / prepend 80：只在窗口补齐后消费一次", async () => {
  const { shouldApplyPrependCompensation } = await loadSubject();
  const { growVisibleCountOnAppend, getVisibleRenderWindow } = await import("./chat-lazy-load.ts");
  const snap = pending({ renderedHeadKey: "p0", visibleCount: 50, generation: 1 });
  // hydrate 先落地：窗口仍是末 50，渲染头已经变，但 visibleCount 未涨
  assert.equal(
    shouldApplyPrependCompensation({
      pending: snap,
      sessionId: "A",
      generation: 1,
      renderedHeadKey: "p70",
      visibleCount: 50,
    }),
    false,
  );
  const grown = growVisibleCountOnAppend(50, 40, 120);
  assert.equal(grown, 130);
  assert.deepEqual(getVisibleRenderWindow(120, grown), { startIndex: 0, hasMore: false });
  assert.equal(
    shouldApplyPrependCompensation({
      pending: snap,
      sessionId: "A",
      generation: 1,
      renderedHeadKey: "pre0",
      visibleCount: grown,
    }),
    true,
  );
});

test("scrollDeltaForBoxHeightChange：顶在视口上方则全量补偿（含跨越），顶已在视口内/下不补", async () => {
  const { scrollDeltaForBoxHeightChange } = await loadSubject();
  // 整块在上方
  assert.equal(
    scrollDeltaForBoxHeightChange({ prevHeight: 400, nextHeight: 2400, nextTop: 0, viewportTop: 500 }),
    2000,
  );
  assert.equal(
    scrollDeltaForBoxHeightChange({ prevHeight: 400, nextHeight: 200, nextTop: 0, viewportTop: 500 }),
    -200,
  );
  // 实测：占位 1040、顶在视口上方 879px，已跨进视口 161px。顶仍在上方 → 全量补偿，稳住下方的回答
  assert.equal(
    scrollDeltaForBoxHeightChange({ prevHeight: 1040, nextHeight: 1998, nextTop: -879, viewportTop: 0 }),
    958,
  );
  // 顶已经在视口里：增长发生在阅读窗口内
  assert.equal(
    scrollDeltaForBoxHeightChange({ prevHeight: 400, nextHeight: 2000, nextTop: 800, viewportTop: 500 }),
    0,
  );
  assert.equal(
    scrollDeltaForBoxHeightChange({ prevHeight: 800, nextHeight: 4000, nextTop: 500, viewportTop: 500 }),
    0,
  );
});
