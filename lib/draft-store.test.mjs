import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { setDraft, getDraft, clearDraft, forgetDraftIfUnedited } = await jiti.import("./draft-store.ts");

test("forgetDraftIfUnedited：空草稿或仍是发出去的正文才删", () => {
  setDraft("k1", { value: "sent", images: [] });
  forgetDraftIfUnedited("k1", "sent", 0);
  assert.equal(getDraft("k1"), null);

  setDraft("k2", { value: "new text", images: [] });
  forgetDraftIfUnedited("k2", "sent", 0);
  assert.equal(getDraft("k2")?.value, "new text");

  setDraft("k3", { value: "", images: [{ mimeType: "image/png", data: "xx" }] });
  forgetDraftIfUnedited("k3", "sent", 0);
  assert.equal(getDraft("k3")?.images.length, 1);

  setDraft("k4", { value: "sent", images: [{ mimeType: "image/png" }, { mimeType: "image/jpeg" }] });
  forgetDraftIfUnedited("k4", "sent", 1);
  assert.equal(getDraft("k4")?.images.length, 2, "多出来的图是后来贴的，不能清");
  clearDraft("k4");
});
