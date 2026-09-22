import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeFilePathSlashes, normalizeSlashes, safeDecode, shortenPath, filePathFromApiUrl } = await jiti.import("./file-paths.ts");

test("safeDecode 在 URI 解码失败时保留原值", () => {
  assert.equal(safeDecode("%E0%A4%A"), "%E0%A4%A");
  assert.equal(safeDecode("hello%20world"), "hello world");
});

test("normalizeFilePathSlashes 处理 Windows drive 与 UNC 路径", () => {
  assert.equal(normalizeFilePathSlashes("C:\\Users\\pi\\file.txt"), "C:/Users/pi/file.txt");
  assert.equal(normalizeFilePathSlashes("\\\\server\\share\\file.txt"), "//server/share/file.txt");
});

test("normalizeFilePathSlashes 不改变 POSIX 路径中的反斜杠", () => {
  assert.equal(normalizeFilePathSlashes("/tmp/a\\b.txt"), "/tmp/a\\b.txt");
});

test("normalizeSlashes 无条件归一化反斜杠", () => {
  assert.equal(normalizeSlashes("/tmp/a\\b.txt"), "/tmp/a/b.txt");
});

test("shortenPath 缩写 home 路径", () => {
  assert.equal(shortenPath("/home/alice/project"), "~/project");
  assert.equal(shortenPath("/Users/alice/project"), "~/project");
  assert.equal(shortenPath("/opt/project"), "/opt/project");
});

test("filePathFromApiUrl：从下载/读取用的 API URL 反解文件路径（另存为靠它拿源路径）", () => {
  // 与 encodeFilePathForApi 往返一致（含空格/中文/子目录）
  const original = "/home/moss/作品 集/a b/图片 1.png";
  const encoded = jitiEncoded(original);
  assert.equal(filePathFromApiUrl(`/api/files/${encoded}?type=download`), original);
  assert.equal(filePathFromApiUrl(`/api/files/${encoded}?type=read&mime=image%2Fpng`), original);
  assert.equal(filePathFromApiUrl(`http://127.0.0.1:31416/api/files/${encoded}?type=download`), original);
  // Windows 盘符原样解出，不加前导斜杠
  assert.equal(filePathFromApiUrl("/api/files/C%3A/Users/a.png?type=download"), "C:/Users/a.png");
  // 不是该形态 → null
  assert.equal(filePathFromApiUrl("/api/sessions/x/state"), null);
  assert.equal(filePathFromApiUrl(""), null);
  assert.equal(filePathFromApiUrl("/api/files/?type=download"), null);
  assert.equal(filePathFromApiUrl(undefined), null);
});

function jitiEncoded(filePath) {
  return normalizeFilePathSlashes(filePath).split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
