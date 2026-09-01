import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";
import { projectSessionFileActivitiesIntoExportHtml } from "@/lib/session-activity-export";
import {
  exportSessionFileToJsonl,
  getExportJsonlFileName,
  JSONL_EXPORT_CONTENT_TYPE,
  parseExportFormat,
  SessionExportError,
} from "@/lib/session-export";
import { sessionService } from "@/lib/session-service";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "session.html";
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

/**
 * 解析外部 pi CLI：优先 PATH 上的 `pi`，其次常见安装路径。
 * 不再依赖 @earendil-works/pi-coding-agent npm 包。
 */
async function resolvePiBinary(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", ["pi"], {
      timeout: 5_000,
      env: process.env,
    });
    const path = stdout.trim().split("\n")[0]?.trim();
    if (path && existsSync(path)) return path;
  } catch {
    /* PATH 无 pi */
  }
  const candidates = [
    join(process.env.HOME || "", ".nvm/versions/node", process.version, "bin/pi"),
    "/usr/local/bin/pi",
    join(process.env.HOME || "", ".local/bin/pi"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Patch the exported HTML to fix recursive functions that overflow
 * the call stack on deep linear session trees (e.g., 5000+ entries).
 *
 * ## Root Cause
 * pi-coding-agent's template.js uses recursive helpers to render and
 * navigate the session tree in the exported HTML:
 *
 *   1. sortChildren(node) — recursively sorts children of every node.
 *      Calls itself via node.children.forEach(sortChildren).
 *      On a 5527-entry linear chain (no branches), this recurses 5527
 *      levels deep → stack overflow.
 *
 *   2. mapNodes(node) — recursively indexes tree nodes the first time
 *      a tree item is clicked. Same depth -> same overflow.
 *
 *   3. markActive(node) — recursively marks nodes on the active path.
 *      Calls itself via markActive(child) for each child.
 *      Same depth → same overflow.
 *
 * Both functions are inlined in the HTML by pi-coding-agent at export
 * time. We cannot modify template.js directly (it's in node_modules
 * and would be overwritten on npm install). Instead, we patch the
 * generated HTML string before returning it to the client.
 *
 * ## Fix
 * Replace each recursive function with an iterative equivalent:
 *
 *   sortChildren  → explicit stack (DFS pre-order, push children in
 *                   reverse to maintain order)
 *   mapNodes      → explicit stack (DFS pre-order)
 *   markActive    → two-stack post-order (stack1 for traversal,
 *                   stack2 for processing children before parent)
 *
 * ## Line Ending Normalization
 * This file (route.ts) uses CRLF (Windows), while template.js uses LF
 * (Unix). The template strings in the backtick literals inherit the
 * file's CRLF line endings. At runtime, readFileSync() also returns
 * CRLF on Windows. We normalize everything to LF before matching.
 *
 * The helper `n(s)` strips \r\n → \n on both the HTML and the
 * replacement strings, ensuring cross-platform matching.
 */
function patchExportHtml(html: string): string {
  // Normalize line endings: route.ts is CRLF, template.js is LF.
  // Without this, the replace() below would fail on Windows.
  const n = (s: string) => s.replace(/\r\n/g, "\n");
  html = n(html);

  const replaceRequired = (source: string, name: string, search: string, replacement: string) => {
    const normalizedSearch = n(search);
    const normalizedReplacement = n(replacement);
    const matches = source.split(normalizedSearch).length - 1;
    if (matches !== 1) {
      throw new Error(`Failed to patch exported HTML: ${name} expected 1 match, found ${matches}`);
    }
    return source.replace(normalizedSearch, normalizedReplacement);
  };

  html = replaceRequired(
    html,
    "sortChildren",
    `        function sortChildren(node) {
          node.children.sort((a, b) =>
            new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
          );
          node.children.forEach(sortChildren);
        }`,
    `        function sortChildren(root) {
          const stack = [root];
          while (stack.length) {
            const node = stack.pop();
            node.children.sort((a, b) =>
              new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime()
            );
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }
        }`
  );

  html = replaceRequired(
    html,
    "mapNodes",
    `          function mapNodes(node) {
            treeNodeMap.set(node.entry.id, node);
            node.children.forEach(mapNodes);
          }
          tree.forEach(mapNodes);`,
    `          const stack = [...tree].reverse();
          while (stack.length) {
            const node = stack.pop();
            treeNodeMap.set(node.entry.id, node);
            for (let i = node.children.length - 1; i >= 0; i--) {
              stack.push(node.children[i]);
            }
          }`
  );

  html = replaceRequired(
    html,
    "markActive",
    `        function markActive(node) {
          let has = activePathIds.has(node.entry.id);
          for (const child of node.children) {
            if (markActive(child)) has = true;
          }
          containsActive.set(node, has);
          return has;
        }`,
    `        function markActive(root) {
          // Post-order traversal using two stacks
          const stack1 = [root];
          const stack2 = [];
          while (stack1.length) {
            const node = stack1.pop();
            stack2.push(node);
            for (const child of node.children) {
              stack1.push(child);
            }
          }
          while (stack2.length) {
            const node = stack2.pop();
            let has = activePathIds.has(node.entry.id);
            for (const child of node.children) {
              if (containsActive.get(child)) has = true;
            }
            containsActive.set(node, has);
          }
        }`
  );

  return html;
}

async function exportSession(filePath: string, outputPath: string): Promise<void> {
  // 只用外部 pi CLI（PATH 或常见安装路径），不加载 pi npm 包
  const piBin = await resolvePiBinary();
  if (!piBin) {
    throw new Error("pi CLI not found on PATH; install pi to export HTML sessions");
  }
  await execFileAsync(piBin, ["--export", filePath, outputPath], {
    cwd: process.cwd(),
    timeout: 30_000,
    env: {
      ...process.env,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
    },
    maxBuffer: 1024 * 1024,
  });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const format = parseExportFormat(url.searchParams.get("format"));
  if (format === null) {
    return NextResponse.json({ error: "Unknown export format" }, { status: 400 });
  }

  const inline = url.searchParams.get("inline") === "1";
  const leafId = url.searchParams.get("leafId");

  try {
    const filePath = await sessionService.resolvePath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (format === "jsonl") {
      try {
        const body = exportSessionFileToJsonl(filePath, {
          leafId: leafId && leafId.length > 0 ? leafId : undefined,
        });
        const fileName = getExportJsonlFileName(filePath);
        return new Response(body, {
          headers: {
            "Content-Type": JSONL_EXPORT_CONTENT_TYPE,
            "Content-Disposition": getContentDisposition(fileName, false),
            "Cache-Control": "no-cache",
            "Content-Security-Policy": "frame-ancestors 'none'",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
          },
        });
      } catch (error) {
        if (error instanceof SessionExportError) {
          return NextResponse.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
    }

    const tempDir = join(tmpdir(), "pidance-export");
    mkdirSync(tempDir, { recursive: true });

    const sessionBase = basename(filePath, ".jsonl");
    const fileName = `pi-session-${sessionBase}.html`;
    const exportId = randomUUID();
    const outputPath = join(tempDir, `${exportId}.html`);
    // 有 leafId 时先写同分支临时 JSONL，再交给 Pi exporter，保证消息本体与 activity 同源
    const branchInputPath = join(tempDir, `${exportId}-branch.jsonl`);
    const effectiveLeaf =
      leafId && leafId.length > 0 ? leafId : undefined;
    let htmlSourcePath = filePath;

    try {
      if (effectiveLeaf !== undefined) {
        try {
          const branchJsonl = exportSessionFileToJsonl(filePath, {
            leafId: effectiveLeaf,
          });
          writeFileSync(branchInputPath, branchJsonl, "utf8");
          htmlSourcePath = branchInputPath;
        } catch (error) {
          if (error instanceof SessionExportError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
          }
          throw error;
        }
      }

      await exportSession(htmlSourcePath, outputPath);

      const html = readFileSync(outputPath, "utf8");
      const patchedHtml = patchExportHtml(html);
      // activity 与 HTML 同源：有 leaf 时从临时 branch 文件默认 leaf 收集
      let withActivities: string;
      try {
        withActivities = projectSessionFileActivitiesIntoExportHtml(
          patchedHtml,
          htmlSourcePath,
        );
      } catch (error) {
        if (error instanceof SessionExportError) {
          return NextResponse.json({ error: error.message }, { status: 400 });
        }
        throw error;
      }
      return new Response(withActivities, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": getContentDisposition(fileName, inline),
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
        },
      });
    } finally {
      rmSync(outputPath, { force: true });
      rmSync(branchInputPath, { force: true });
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
