import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loadSubject = () => jiti.import("./chat-scroll-anchor.ts");

test("findChatAnchorElement：先按 data-chat-anchor，回退 data-message-entry-id", async () => {
  const { findChatAnchorElement } = await loadSubject();
  const container = {
    querySelector(selector) {
      if (selector.includes('data-chat-anchor="message:e1"')) return null;
      if (selector.includes('data-message-entry-id="e1"')) return { id: "msg-el" };
      return null;
    },
  };
  assert.equal(findChatAnchorElement(container, "message:e1").id, "msg-el");
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
