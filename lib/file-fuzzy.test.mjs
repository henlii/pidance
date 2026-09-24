import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// 该模块现在依赖 lib/file-paths（引用文本要把绝对路径转成相对），所以走 jiti 解析，
// 与 lib/ 其他测试一致；裸 import("./x.ts") 解析不了无扩展名的相对导入。
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const loadSubject = () => jiti.import("./file-fuzzy.ts");

test("builds closed file mentions and quotes paths containing spaces", async () => {
  const { buildAtMentionText, buildFileAtMentionsText } = await loadSubject();

  assert.equal(buildAtMentionText("notes/todo.md", false), "@notes/todo.md ");
  assert.equal(buildAtMentionText("project files/design brief.md", false), "@\"project files/design brief.md\" ");
  assert.equal(
    buildFileAtMentionsText(["notes/todo.md", "project files/design brief.md"]),
    "@notes/todo.md @\"project files/design brief.md\" ",
  );
});

test("引用文本：绝对路径按 cwd 转相对后再组 @ 引用", async () => {
  const { buildFileReferenceText } = await loadSubject();

  // 项目内的绝对路径 → 相对 @ 引用（agent 的 read 工具按 cwd 解析）
  assert.equal(buildFileReferenceText("/repo/src/a.ts", "/repo"), "@src/a.ts ");
  assert.equal(buildFileReferenceText("/repo/src/b.ts", "/repo/"), "@src/b.ts ");
  // 已经是相对路径：没有 cwd 时原样保留
  assert.equal(buildFileReferenceText("src/c.ts"), "@src/c.ts ");
  // cwd 之外的绝对路径：不硬套相对路径，保留绝对形式
  assert.equal(buildFileReferenceText("/elsewhere/d.ts", "/repo"), "@/elsewhere/d.ts ");
  // Windows 盘符：cwd 之外要归一成正斜杠（@ 引用与 read 都按正斜杠解析，
  // 直接给 `@D:\tmp\a.ts ` 是坏引用）
  assert.equal(buildFileReferenceText("D:\\tmp\\a.ts", "C:\\repo"), "@D:/tmp/a.ts ");
  // Windows 盘符：cwd 之内先转相对，结果同样归一
  assert.equal(buildFileReferenceText("C:\\repo\\src\\a.ts", "C:\\repo"), "@src/a.ts ");
  // 含空格的路径沿用引号形式
  assert.equal(buildFileReferenceText("/repo/my dir/e.ts", "/repo"), "@\"my dir/e.ts\" ");
});
