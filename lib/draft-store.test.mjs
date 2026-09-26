import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { setDraft, getDraft, clearDraft, forgetDraftIfUnedited, shouldPersistComposerDraft } = await jiti.import("./draft-store.ts");

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

/**
 * 输入框挂载后的「先别用空值删服务端草稿」那道闸（四轮审查 阻断 1）。
 *
 * 场景：插件自己调 onSubmit 而后台没有标签在显示接管 → 宿主把正文写进**会话草稿**
 * （唯一不依赖投递时机的落点）。用户随后打开会话，输入框一挂上就把自己那份（空的）写回
 * 草稿，把刚写下的正文删掉 —— 那台插件编辑器早在 onSubmit 之前就清空了自己，于是字全没了。
 */
test("草稿写入闸：未对齐 + 未编辑 + 空值 → 先别写（别删掉宿主兜底写下的正文）", () => {
  const base = { draftKey: "s1", value: "", touched: false, hydratedKey: null };
  assert.equal(shouldPersistComposerDraft(base), false, "这正是会把服务端草稿删掉的组合");

  assert.equal(shouldPersistComposerDraft({ ...base, hydratedKey: "s1" }), true, "对齐过（找到/没找到都算）就照常写");
  assert.equal(shouldPersistComposerDraft({ ...base, touched: true }), true, "用户动过（哪怕清空）按他的意思写");
  assert.equal(shouldPersistComposerDraft({ ...base, value: "用户打的字" }), true, "非空一定写");
  assert.equal(shouldPersistComposerDraft({ ...base, draftKey: null }), false, "没有草稿 key 时不写");
  assert.equal(
    shouldPersistComposerDraft({ ...base, draftKey: "s2", hydratedKey: "s1" }),
    false,
    "换到还没对齐的新会话：同样是那个危险组合",
  );
});
