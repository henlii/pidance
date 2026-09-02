/**
 * HTML session export: Pi CLI --export plus iterative tree patches and activity projection.
 * SessionService is the product entry; this module is the export implementation.
 */

import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { promisify } from "util";
import { projectSessionFileActivitiesIntoExportHtml } from "./session-activity-export";
import {
  exportSessionFileToJsonl,
  getExportJsonlFileName,
  JSONL_EXPORT_CONTENT_TYPE,
  parseExportFormat,
  SessionExportError,
  type ExportFormat,
} from "./session-export";

const execFileAsync = promisify(execFile);

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

export function patchExportHtml(html: string): string {
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

async function exportSessionWithPiCli(filePath: string, outputPath: string): Promise<void> {
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

export type SessionExportPayload = {
  body: string;
  contentType: string;
  fileName: string;
};

export async function buildSessionExport(
  filePath: string,
  options: { format: ExportFormat; leafId?: string },
): Promise<SessionExportPayload> {
  if (options.format === "jsonl") {
    const body = exportSessionFileToJsonl(filePath, {
      leafId: options.leafId && options.leafId.length > 0 ? options.leafId : undefined,
    });
    return {
      body,
      contentType: JSONL_EXPORT_CONTENT_TYPE,
      fileName: getExportJsonlFileName(filePath),
    };
  }

  const tempDir = join(tmpdir(), "pidance-export");
  mkdirSync(tempDir, { recursive: true });
  const sessionBase = basename(filePath, ".jsonl");
  const fileName = `pi-session-${sessionBase}.html`;
  const exportId = randomUUID();
  const outputPath = join(tempDir, `${exportId}.html`);
  const branchInputPath = join(tempDir, `${exportId}-branch.jsonl`);
  const effectiveLeaf = options.leafId && options.leafId.length > 0 ? options.leafId : undefined;
  let htmlSourcePath = filePath;
  try {
    if (effectiveLeaf !== undefined) {
      const branchJsonl = exportSessionFileToJsonl(filePath, { leafId: effectiveLeaf });
      writeFileSync(branchInputPath, branchJsonl, "utf8");
      htmlSourcePath = branchInputPath;
    }
    await exportSessionWithPiCli(htmlSourcePath, outputPath);
    const html = readFileSync(outputPath, "utf8");
    const patchedHtml = patchExportHtml(html);
    const withActivities = projectSessionFileActivitiesIntoExportHtml(patchedHtml, htmlSourcePath);
    return {
      body: withActivities,
      contentType: "text/html; charset=utf-8",
      fileName,
    };
  } finally {
    rmSync(outputPath, { force: true });
    rmSync(branchInputPath, { force: true });
  }
}

export { parseExportFormat, SessionExportError };
