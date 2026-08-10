/**
 * markdown 渲染链安全回归测试。
 *
 * 固定 lib/markdown.ts 的 rehypeRaw → rehypeSanitize → rehypeKatex 安全边界：
 * - 黑盒：用与 react-markdown 相同的 unified 管线渲染 markdown/HTML 混合输入，
 *   断言所有攻击面不可执行/被剥离；
 * - 白盒：从导出的 rehype 插件元组读取 sanitize schema，固定禁止标签、
 *   事件属性与 URL 协议白名单，防止未来改动悄悄放宽边界。
 *
 * 注意：管线必须给 remark-rehype 传 { allowDangerousHtml: true }（react-markdown
 * 内部默认如此），否则 raw HTML 不会进入 rehype-raw，攻击面测试将失真。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { toHtml } from "hast-util-to-html";

// markdown.ts 走仓库惯例的无扩展名相对 import，node 原生 ESM 解析不了，
// 与 skills-write 测试一致改用 jiti 加载。
const jiti = createJiti(import.meta.url, {
  alias: { "@": path.join(path.dirname(fileURLToPath(import.meta.url)), "..") },
});
const {
  markdownRemarkPlugins,
  markdownRehypePlugins,
  markdownPreviewRemarkPlugins,
  markdownPreviewRehypePlugins,
} = await jiti.import("./markdown.ts");

/** 复刻 react-markdown 的渲染链（remarkParse → remark 插件 → remark-rehype → rehype 插件）。 */
function render(md, { preview = false } = {}) {
  const remarkPlugins = preview ? markdownPreviewRemarkPlugins : markdownRemarkPlugins;
  const rehypePlugins = preview ? markdownPreviewRehypePlugins : markdownRehypePlugins;
  let processor = unified().use(remarkParse);
  for (const plugin of remarkPlugins) processor = processor.use(plugin);
  processor = processor.use(remarkRehype, { allowDangerousHtml: true });
  for (const plugin of rehypePlugins) {
    // 元组 [plugin, options] 须展开为 use(plugin, options)；函数直接 use。
    processor = processor.use(...(Array.isArray(plugin) ? plugin : [plugin]));
  }
  return toHtml(processor.runSync(processor.parse(md)));
}

/** 从导出的插件元组里取出 rehypeSanitize 的 schema（markdown.ts 未单独导出，白盒固定它）。 */
function sanitizeSchema() {
  const entry = markdownRehypePlugins.find((p) => Array.isArray(p) && p[0] && p[0].name === "rehypeSanitize");
  assert.ok(entry, "markdownRehypePlugins 应包含 [rehypeSanitize, schema] 元组");
  return entry[1];
}

const DANGEROUS_EVENT_ATTRS = [
  "onerror",
  "onload",
  "onclick",
  "onmouseover",
  "onmousedown",
  "onkeyup",
  "onfocus",
  "onanimationend",
];

// ---------------------------------------------------------------------------
// 黑盒：可执行标签与脚本
// ---------------------------------------------------------------------------

test("script 标签（含 src 外链）被剥离", () => {
  const cases = [
    "<script>alert(1)</script>",
    '<script src="https://evil.example/x.js"></script>',
    '<script src="data:text/javascript,alert(1)"></script>',
    '<div><script>alert(1)</script>text</div>',
  ];
  for (const md of cases) {
    for (const preview of [false, true]) {
      const html = render(md, { preview });
      assert.ok(!html.includes("<script"), `聊天输出不应含 <script>: ${html}`);
      assert.ok(!html.includes("</script"), `聊天输出不应含 </script>: ${html}`);
      assert.ok(!html.includes("alert"), `聊天输出不应含脚本内容: ${html}`);
    }
  }
});

test("img/svg 事件属性被剥离", () => {
  const cases = [
    '<img src="x.png" onerror="alert(1)">',
    '<svg onload="alert(1)"></svg>',
    '<svg><script>alert(1)</script></svg>',
    '<div onclick="alert(1)">x</div>',
    '<table><tr><td onmouseover="alert(1)">x</td></tr></table>',
    '<img src="x" onerror="alert(1)" onload="alert(2)">',
  ];
  for (const md of cases) {
    for (const preview of [false, true]) {
      const html = render(md, { preview });
      for (const attr of DANGEROUS_EVENT_ATTRS) {
        assert.ok(!html.includes(`${attr}=`), `输出不应含 ${attr}: ${html}`);
      }
      assert.ok(!html.includes("alert"), `输出不应含脚本内容: ${html}`);
    }
  }
});

test("svg/math/embed 等不在白名单的容器被整体移除", () => {
  const cases = [
    "<svg onload=\"alert(1)\"></svg>",
    '<embed src="https://evil.example/x.swf">',
    '<embed src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
    "<math><mtext><img src=x onerror=alert(1)></mtext></math>",
  ];
  for (const md of cases) {
    for (const preview of [false, true]) {
      const html = render(md, { preview });
      assert.ok(!html.includes("<svg"), `输出不应含 <svg>: ${html}`);
      assert.ok(!html.includes("<embed"), `输出不应含 <embed>: ${html}`);
      assert.ok(!html.includes("<math"), `输出不应含 <math>: ${html}`);
      assert.ok(!html.includes("onload"), `输出不应含 onload: ${html}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 黑盒：危险容器标签
// ---------------------------------------------------------------------------

test("iframe/object/style/form/meta 被剥离", () => {
  const cases = [
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<iframe src="https://evil.example"></iframe>',
    '<object data="https://evil.example/x.swf"></object>',
    '<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>',
    '<form action="https://evil.example"><input type="submit"></form>',
    "<style>body{display:none}</style>",
    '<style>@import url("https://evil.example/x.css");</style>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example">',
    '<meta charset="utf-8"><meta name="x" content="y">',
  ];
  for (const md of cases) {
    for (const preview of [false, true]) {
      const html = render(md, { preview });
      for (const tag of ["iframe", "object", "style", "form", "meta"]) {
        assert.ok(!html.includes(`<${tag}`), `输出不应含 <${tag}>: ${html}`);
        assert.ok(!html.includes(`</${tag}`), `输出不应含 </${tag}>: ${html}`);
      }
      assert.ok(!html.includes("srcdoc"), `输出不应含 srcdoc: ${html}`);
      assert.ok(!html.includes("http-equiv"), `输出不应含 http-equiv: ${html}`);
      assert.ok(!html.includes("alert"), `输出不应含脚本内容: ${html}`);
    }
  }
});

test("style 属性与事件属性在任意元素上被剥离", () => {
  const cases = [
    '<img src="x.png" style="background:url(javascript:alert(1))">',
    '<a href="https://e.com" style="position:fixed">x</a>',
    '<div style="background:url(data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)">x</div>',
  ];
  for (const md of cases) {
    for (const preview of [false, true]) {
      const html = render(md, { preview });
      assert.ok(!html.includes("style="), `输出不应含 style 属性: ${html}`);
      assert.ok(!html.includes("javascript:"), `输出不应含 javascript: ${html}`);
      assert.ok(!html.includes("data:image"), `输出不应含 data:image: ${html}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 黑盒：危险 URL 协议
// ---------------------------------------------------------------------------

test("markdown 链接的危险协议 href 被剥离（javascript/data/vbscript）", () => {
  const cases = [
    "[x](javascript:alert(1))",
    "[x](JavaScript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](java&#x73;cript:alert(1))",
    "[x](jav&#x61;script:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](vbscript:msgbox(1))",
    "[x](javascript&#58;alert(1))",
  ];
  for (const md of cases) {
    for (const preview of [false, true]) {
      const html = render(md, { preview });
      assert.ok(!html.includes("href"), `危险链接不应保留 href: ${html}`);
      assert.ok(!html.includes("javascript"), `输出不应含 javascript: ${html}`);
      assert.ok(!html.includes("data:text"), `输出不应含 data:text: ${html}`);
      assert.ok(!html.includes("vbscript"), `输出不应含 vbscript: ${html}`);
      assert.ok(html.includes(">x</a>") || html.includes(">x</a>"), `链接文本应保留: ${html}`);
    }
  }
});

test("原生 HTML 链接的危险协议 href 被剥离（含实体与大小写变体）", () => {
  const cases = [
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href="jav&#x61;script:alert(1)">x</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<a href=" java&#x73;cript:alert(1)">x</a>',
  ];
  for (const md of cases) {
    for (const preview of [false, true]) {
      const html = render(md, { preview });
      assert.ok(!html.includes("href"), `危险链接不应保留 href: ${html}`);
      assert.ok(!html.includes("javascript"), `输出不应含 javascript: ${html}`);
      assert.ok(!html.includes("vbscript"), `输出不应含 vbscript: ${html}`);
    }
  }
});

test("markdown 图片与原生 img 的危险 src 被剥离", () => {
  // data:/javascript: 协议 src 应整体剥离（含 svg+xml 载荷）
  const dangerousSrc = [
    "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+)",
    "![x](javascript:alert(1))",
    '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+" alt="x">',
    '<img src="javascript:alert(1)" alt="x">',
  ];
  for (const md of dangerousSrc) {
    for (const preview of [false, true]) {
      const html = render(md, { preview });
      assert.ok(!html.includes("src="), `危险图片不应保留 src: ${html}`);
      assert.ok(!html.includes("data:image"), `输出不应含 data:image: ${html}`);
      assert.ok(!html.includes("javascript"), `输出不应含 javascript: ${html}`);
      assert.ok(!html.includes("onload"), `输出不应含 onload: ${html}`);
    }
  }
  // 事件属性：src 为安全相对路径可保留，onerror 必须剥离
  for (const preview of [false, true]) {
    const html = render('<img src="x" onerror="alert(1)">', { preview });
    assert.ok(!html.includes("onerror"), `输出不应含 onerror: ${html}`);
    assert.ok(!html.includes("alert"), `输出不应含脚本内容: ${html}`);
  }
});

// ---------------------------------------------------------------------------
// 黑盒：正向用例（合法内容不被误伤）
// ---------------------------------------------------------------------------

test("合法链接/图片/GFM 表格正常保留", () => {
  // 注意：表格行之间必须单换行（GFM 表格要求连续行），段落之间双换行
  const html = render(
    [
      "[ok](https://example.com)",
      "",
      "[m](mailto:a@b.com)",
      "",
      "![alt](https://example.com/a.png)",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      '<a href="https://e.com">t</a>',
    ].join("\n"),
  );
  assert.ok(html.includes('href="https://example.com"'), "https 链接应保留");
  assert.ok(html.includes('href="mailto:a@b.com"'), "mailto 链接应保留");
  assert.ok(html.includes('src="https://example.com/a.png"'), "https 图片应保留");
  assert.ok(html.includes("<table>"), "GFM 表格应保留");
  assert.ok(html.includes("<th>a</th>"), "表格头应保留");
});

test("GFM 删除线/任务列表等语法不受 sanitize 影响", () => {
  const html = render(["- [x] done", "- [ ] todo", "~~gone~~", "`code`"].join("\n"));
  assert.ok(html.includes("task-list-item"), "任务列表样式类应保留");
  assert.ok(html.includes("del"), "删除线应保留");
  assert.ok(html.includes("<code>"), "行内代码应保留");
});

// ---------------------------------------------------------------------------
// 黑盒：KaTeX 数学渲染
// ---------------------------------------------------------------------------

test("聊天链路 KaTeX 内联与块级公式正常渲染", () => {
  const html = render(["inline $x^2$", "$$", "\\int_0^1 x^2 dx", "$$"].join("\n"));
  assert.ok(html.includes('class="katex"'), "内联公式应渲染为 katex");
  assert.ok(html.includes('class="katex-display"'), "块级公式应渲染为 katex-display");
  assert.ok(!html.includes("<script"), "katex 输出不应含脚本");
});

test("文件预览链路（无 katex）不渲染公式但保持安全", () => {
  const html = render("$x^2$", { preview: true });
  assert.ok(!html.includes("katex"), "预览链路不应渲染 katex");
  // 预览链路同样剥离危险内容（注意脚本与链接分行，避免 HTML 块吞掉 markdown 链接）
  const evil = render("<script>alert(1)</script>\n\n[x](javascript:alert(1))", { preview: true });
  assert.ok(!evil.includes("<script"), "预览链路应剥离 script");
  assert.ok(!evil.includes("</script"), "预览链路应剥离 script 闭合标签");
  assert.ok(!evil.includes("href"), "预览链路应剥离危险 href");
  assert.ok(!evil.includes("javascript"), "预览链路不应含 javascript 协议");
});

// ---------------------------------------------------------------------------
// 白盒：sanitize schema 配置
// ---------------------------------------------------------------------------

test("schema 禁止标签列表固定（strip + tagNames 双保险）", () => {
  const schema = sanitizeSchema();
  assert.ok(schema.strip.includes("script"), "strip 应含 script");
  for (const tag of ["iframe", "object", "style", "form"]) {
    assert.ok(schema.strip.includes(tag), `strip 应含 ${tag}`);
    assert.ok(!schema.tagNames.includes(tag), `tagNames 不应允许 ${tag}`);
  }
  for (const tag of ["script", "embed", "meta", "svg", "math", "base", "link"]) {
    assert.ok(!schema.tagNames.includes(tag), `tagNames 不应允许 ${tag}`);
  }
});

test("schema 不允许任何事件属性与 style 属性", () => {
  const schema = sanitizeSchema();
  const wildcard = schema.attributes["*"] ?? [];
  const wildcardStrings = wildcard.map((a) => (Array.isArray(a) ? String(a[0]) : String(a)));
  for (const attr of [...DANGEROUS_EVENT_ATTRS, "style"]) {
    assert.ok(!wildcardStrings.includes(attr), `通配属性不应允许 ${attr}`);
  }
  // 逐标签检查：任何标签的属性表都不含事件/style
  for (const [tag, attrs] of Object.entries(schema.attributes)) {
    if (tag === "*") continue;
    const attrNames = attrs.map((a) => (Array.isArray(a) ? String(a[0]) : String(a)));
    for (const attr of [...DANGEROUS_EVENT_ATTRS, "style"]) {
      assert.ok(!attrNames.includes(attr), `标签 ${tag} 不应允许 ${attr}`);
    }
  }
});

test("schema URL 协议白名单不含 javascript/data/vbscript", () => {
  const schema = sanitizeSchema();
  for (const protocol of ["javascript", "data", "vbscript", "file"]) {
    assert.ok(!schema.protocols.href.includes(protocol), `href 协议不应含 ${protocol}`);
    assert.ok(!schema.protocols.src.includes(protocol), `src 协议不应含 ${protocol}`);
  }
  for (const allowed of ["http", "https"]) {
    assert.ok(schema.protocols.href.includes(allowed), `href 协议应含 ${allowed}`);
    assert.ok(schema.protocols.src.includes(allowed), `src 协议应含 ${allowed}`);
  }
});

test("聊天与文件预览共用同一 sanitize schema", () => {
  const chatEntry = markdownRehypePlugins.find((p) => Array.isArray(p) && p[0] && p[0].name === "rehypeSanitize");
  const previewEntry = markdownPreviewRehypePlugins.find((p) => Array.isArray(p) && p[0] && p[0].name === "rehypeSanitize");
  assert.ok(chatEntry && previewEntry, "两条渲染链路都应配置 rehypeSanitize");
  assert.equal(chatEntry[1], previewEntry[1], "两条链路应引用同一 schema 实例");
  // 预览链路同样启用 rehypeRaw（否则 HTML 注入不会经过 sanitize）
  assert.equal(markdownRehypePlugins[0], markdownPreviewRehypePlugins[0], "两条链路都应先 rehypeRaw");
});
