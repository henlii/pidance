import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import {
  getAllowedFileRoots,
  isFilePathAllowed,
  isWindowsAbsolutePath,
  normalizeSlashes,
} from "@/lib/file-access";
import {
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
} from "@/lib/file-types";
import { readFileConfig } from "@/lib/file-config";
import { resolveDirentIsDirectory } from "@/lib/file-dirent";
import { isFilePathReferencedBySession } from "@/lib/session-file-references";
import {
  isNoSymlinkRedirection,
  openRegularFileReadonly,
  resolveReadablePath,
} from "@/lib/file-read";
import { handleSaveRequest } from "@/lib/file-save-route";
import {
  copyEntry,
  createDirectory,
  createDirectoryTarGzStream,
  createEmptyFile,
  FileOpsError,
  fileOpsStatus,
  moveEntry,
  renameEntry,
} from "@/lib/file-ops";
import {
  inspectUploadTargets,
  parseUploadConflictStrategy,
  validateUploadFileNames,
} from "@/lib/file-upload";

// 文件管理已与 PTY 同等开放：不再隐藏 node_modules/dist/build 等目录。
const IGNORED_NAMES = new Set<string>();

const IGNORED_SUFFIXES: string[] = [];

const FILE_REQUEST_TYPES = ["list", "read", "download", "meta", "preview", "watch"] as const;
type FileRequestType = typeof FILE_REQUEST_TYPES[number];
const FILE_REQUEST_TYPE_SET = new Set<string>(FILE_REQUEST_TYPES);

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl",
  env: "bash", gitignore: "bash", txt: "text",
  pdf: "pdf", docx: "word",
};

function getLanguage(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  // Special full-name matches
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}

function filePathFromSegments(segments: string[]): string {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

function parseFileRequestType(value: string): FileRequestType | null {
  return FILE_REQUEST_TYPE_SET.has(value) ? (value as FileRequestType) : null;
}

async function getUploadDirectory(segments: string[]): Promise<
  { directory: string } | { response: NextResponse }
> {
  const directory = filePathFromSegments(segments);
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(directory, allowedRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch {
    return { response: NextResponse.json({ error: "Upload directory not found" }, { status: 404 }) };
  }
  if (!stat.isDirectory()) {
    return { response: NextResponse.json({ error: "Upload target is not a directory" }, { status: 400 }) };
  }

  // A browsable directory can be a symlink. Resolve both sides before writes
  // so a symlink inside an allowed root cannot redirect uploads outside it.
  const realDirectory = fs.realpathSync(directory);
  const realRoots = new Set<string>();
  for (const root of allowedRoots) {
    try {
      realRoots.add(fs.realpathSync(root));
    } catch {
      // Ignore stale session roots that no longer exist.
    }
  }
  if (!isFilePathAllowed(realDirectory, realRoots)) {
    return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
  }

  return { directory: realDirectory };
}

function parseUploadFileNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

function parseOpsName(body: unknown, field: string): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function fileOpsErrorResponse(error: unknown): NextResponse {
  if (error instanceof FileOpsError) {
    return NextResponse.json({ error: error.message }, { status: fileOpsStatus(error.code) });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 },
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const type = request.nextUrl.searchParams.get("type") ?? "upload";
    if (type === "save") {
      const target = filePathFromSegments(segments);
      return handleSaveRequest(request, target);
    }

    // 创建/重命名：独立于 upload，避免误走 multipart 解析。
    if (type === "create-file" || type === "create-dir" || type === "rename" || type === "move" || type === "copy") {
      const allowedRoots = await getAllowedFileRoots();
      const body = await request.json().catch(() => null);
      try {
        if (type === "rename") {
          const target = filePathFromSegments(segments);
          const newName = parseOpsName(body, "newName");
          if (!newName) {
            return NextResponse.json({ error: "newName is required" }, { status: 400 });
          }
          const result = renameEntry(target, newName, allowedRoots);
          return NextResponse.json({ path: result.path, name: result.name });
        }
        if (type === "move" || type === "copy") {
          const source = filePathFromSegments(segments);
          const targetDirectory = parseOpsName(body, "targetDirectory");
          if (!targetDirectory) {
            return NextResponse.json({ error: "targetDirectory is required" }, { status: 400 });
          }
          const result = type === "move"
            ? moveEntry(source, targetDirectory, allowedRoots)
            : copyEntry(source, targetDirectory, allowedRoots);
          return NextResponse.json({ path: result.path, name: result.name });
        }
        const directory = filePathFromSegments(segments);
        const name = parseOpsName(body, "name");
        if (!name) {
          return NextResponse.json({ error: "name is required" }, { status: 400 });
        }
        const result = type === "create-file"
          ? createEmptyFile(directory, name, allowedRoots)
          : createDirectory(directory, name, allowedRoots);
        return NextResponse.json({ path: result.path, name: result.name }, { status: 201 });
      } catch (error) {
        return fileOpsErrorResponse(error);
      }
    }

    const uploadDirectory = await getUploadDirectory(segments);
    if ("response" in uploadDirectory) return uploadDirectory.response;
    const { directory } = uploadDirectory;
    if (type === "upload-check") {
      const body = await request.json().catch(() => null) as { fileNames?: unknown } | null;
      const fileNames = parseUploadFileNames(body?.fileNames);
      if (!fileNames) {
        return NextResponse.json({ error: "fileNames must be an array of strings" }, { status: 400 });
      }
      const validationError = validateUploadFileNames(fileNames);
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 });
      }
      return NextResponse.json(inspectUploadTargets(directory, fileNames));
    }

    if (type !== "upload") {
      return NextResponse.json({ error: "Invalid upload request type" }, { status: 400 });
    }

    const strategy = parseUploadConflictStrategy(request.nextUrl.searchParams.get("conflict"));
    if (!strategy) {
      return NextResponse.json({ error: "Invalid conflict strategy" }, { status: 400 });
    }

    // 上传大小已不做限制（写入/上传/保存无限制）。
    const formData = await request.formData();
    const files = formData.getAll("files").filter((entry): entry is File => typeof entry !== "string");
    const fileNames = files.map((file) => file.name);
    const validationError = validateUploadFileNames(fileNames);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const inspection = inspectUploadTargets(directory, fileNames);
    if (strategy === "error" && inspection.conflicts.length > 0) {
      return NextResponse.json({
        error: "One or more files already exist",
        conflicts: inspection.conflicts,
        nonReplaceable: inspection.nonReplaceable,
      }, { status: 409 });
    }

    const conflictSet = new Set(inspection.conflicts);
    const nonReplaceableSet = new Set(inspection.nonReplaceable);
    const uploaded: string[] = [];
    const skipped: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    for (const file of files) {
      const destination = path.join(directory, file.name);
      if (conflictSet.has(file.name) && strategy === "skip") {
        skipped.push(file.name);
        continue;
      }
      if (conflictSet.has(file.name) && nonReplaceableSet.has(file.name)) {
        errors.push({ name: file.name, error: "Cannot replace a directory or symbolic link" });
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(await file.arrayBuffer());
      } catch (error) {
        errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
        continue;
      }

      if (conflictSet.has(file.name)) {
        try {
          fs.unlinkSync(destination);
        } catch (error) {
          errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
      }

      try {
        fs.writeFileSync(destination, bytes, { flag: "wx" });
        uploaded.push(file.name);
      } catch (error) {
        errors.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return NextResponse.json(
      { uploaded, skipped, errors },
      { status: errors.length > 0 ? 207 : 200 },
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);
    const root = path.parse(filePath).root;
    if (filePath === root || filePath.replace(/[\\/]+$/, "") === root.replace(/[\\/]+$/, "")) {
      return NextResponse.json({ error: "Cannot delete root" }, { status: 400 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      throw error;
    }

    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: false });
    } else {
      fs.unlinkSync(filePath);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

function createFileBodyStream(realPath: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  // O_NOFOLLOW 打开：realpath 校验与真正读取之间的最终组件 TOCTOU 防护；
  // fd 交给 ReadStream，在流结束/销毁时 autoClose 自动关闭。
  const fd = openRegularFileReadonly(realPath);
  const fileStream = fs.createReadStream(realPath, { fd, autoClose: true, ...(range ?? {}) });
  let closed = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      fileStream.on("data", (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          closed = true;
          fileStream.destroy();
        }
      });
      fileStream.once("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The browser may cancel media probes before the file stream ends.
        }
      });
      fileStream.once("error", (error) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(error);
        } catch {
          // The response was already abandoned by the client.
        }
      });
    },
    cancel() {
      closed = true;
      fileStream.destroy();
    },
  });
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getContentDisposition(filePath: string, asDownload = false): string {
  const disposition = asDownload ? "attachment" : "inline";
  const fileName = path.basename(filePath);
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

function streamFile(realPath: string, stat: fs.Stats, contentType: string, rangeHeader: string | null, asDownload = false): Response {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
    "Content-Disposition": getContentDisposition(realPath, asDownload),
  };

  if (!rangeHeader) {
    return new Response(createFileBodyStream(realPath), {
      headers: {
        ...headers,
        "Content-Length": String(stat.size),
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(stat.size - suffixLength, 0);
    end = stat.size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
    return new Response(null, {
      status: 416,
      headers: {
        ...headers,
        "Content-Range": `bytes */${stat.size}`,
      },
    });
  }

  end = Math.min(end, stat.size - 1);
  const chunkSize = end - start + 1;
  return new Response(createFileBodyStream(realPath, { start, end }), {
    status: 206,
    headers: {
      ...headers,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    },
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapDocxPreviewHtml(bodyHtml: string, fileName: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #eef1f5; color: #171717; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
  main {
    box-sizing: border-box;
    max-width: 840px;
    min-height: calc(100vh - 56px);
    margin: 0 auto;
    padding: 56px 64px;
    background: #fff;
    box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14);
  }
  .file-title {
    margin: 0 0 28px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e5e7eb;
    color: #6b7280;
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-word;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.1em 0 0.45em; color: #111827; }
  p { margin: 0.65em 0; line-height: 1.7; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 9px; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { color: #2563eb; }
  @media (max-width: 720px) {
    body { padding: 0; background: #fff; }
    main { min-height: 100vh; padding: 28px 22px; box-shadow: none; }
  }
</style>
</head>
<body>
<main>
<div class="file-title">${escapeHtml(fileName)}</div>
${bodyHtml}
</main>
</body>
</html>`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: segments } = await params;
    const filePath = filePathFromSegments(segments);
    const rawType = request.nextUrl.searchParams.get("type") ?? "list";
    const type = parseFileRequestType(rawType);
    if (!type) {
      return NextResponse.json({ error: "Invalid file request type" }, { status: 400 });
    }
    const sessionId = request.nextUrl.searchParams.get("sessionId");

    const allowedRoots = await getAllowedFileRoots();
    const allowedByRoot = isFilePathAllowed(filePath, allowedRoots);
    const allowedBySessionReference =
      !allowedByRoot &&
      type !== "list" &&
      await isFilePathReferencedBySession(filePath, sessionId);
    if (!allowedByRoot && !allowedBySessionReference) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    // 读路径统一收敛：realpath + 授权根包含校验（根内 symlink 指向根外 → 拒绝）。
    // 解析出的 realPath 为符号链接解析后的规范路径，后续读/流/列表一律基于它。
    const resolved = resolveReadablePath(filePath, allowedRoots);
    if (resolved.kind === "not-found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    let realPath: string;
    let stat: fs.Stats;
    if (resolved.kind === "ok") {
      realPath = resolved.realPath;
      stat = resolved.stat;
    } else if (resolved.kind === "denied") {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    } else {
      // 不在任何授权根内：仅当路径被会话字面引用且未发生符号链接重定向时放行
      if (!allowedBySessionReference || !isNoSymlinkRedirection(filePath, resolved.realPath)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
      realPath = resolved.realPath;
      stat = resolved.stat;
    }

    if (type === "read") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const imageMime = getImageMime(realPath);
      if (imageMime) {
        if (stat.size > readFileConfig().imagePreviewMaxBytes) {
          return NextResponse.json({ error: "Image too large (>10MB)" }, { status: 413 });
        }
        return streamFile(realPath, stat, imageMime, request.headers.get("range"));
      }
      const audioMime = getAudioMime(realPath);
      if (audioMime) {
        return streamFile(realPath, stat, audioMime, request.headers.get("range"));
      }
      const documentMime = getDocumentMime(realPath);
      if (documentMime) {
        return streamFile(realPath, stat, documentMime, request.headers.get("range"));
      }
      if (stat.size > readFileConfig().textPreviewMaxBytes) {
        return NextResponse.json({ error: "File too large for preview (>256KB)" }, { status: 413 });
      }
      // O_NOFOLLOW 打开 + fstat 复核后读取（TOCTOU 最终组件防护）
      const fd = openRegularFileReadonly(realPath);
      try {
        const content = fs.readFileSync(fd, "utf-8");
        const language = getLanguage(realPath);
        return NextResponse.json({ content, language, size: stat.size, mtimeMs: stat.mtimeMs });
      } finally {
        fs.closeSync(fd);
      }
    }

    if (type === "download") {
      if (stat.isDirectory()) {
        // 目录下载：gzip tar 流；文件名使用 basename.tar.gz
        try {
          const stream = createDirectoryTarGzStream(realPath);
          const archiveName = `${path.basename(realPath) || "folder"}.tar.gz`;
          return new Response(stream, {
            headers: {
              "Content-Type": "application/gzip",
              "Content-Disposition": getContentDisposition(archiveName, true),
              "Cache-Control": "no-cache",
            },
          });
        } catch (error) {
          return fileOpsErrorResponse(error);
        }
      }
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const mime = getImageMime(realPath) || getAudioMime(realPath) || getDocumentMime(realPath) || "application/octet-stream";
      return streamFile(realPath, stat, mime, request.headers.get("range"), true);
    }

    if (type === "meta") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      const imageMime = getImageMime(realPath);
      const audioMime = getAudioMime(realPath);
      const documentMime = getDocumentMime(realPath);
      return NextResponse.json({
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        language: getLanguage(realPath),
        mime: imageMime || audioMime || documentMime || "text/plain",
        previewKind: documentPreviewKind(realPath),
      });
    }

    if (type === "preview") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      if (getFileExt(realPath) !== "docx") {
        return NextResponse.json({ error: "Preview not available for this file type" }, { status: 400 });
      }
      if (stat.size > readFileConfig().docxPreviewMaxBytes) {
        return NextResponse.json({ error: "DOCX too large for preview (>10MB)" }, { status: 413 });
      }

      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml(
        { path: realPath },
        {
          externalFileAccess: false,
          convertImage: mammoth.images.dataUri,
        }
      );
      const html = wrapDocxPreviewHtml(result.value, path.basename(realPath));
      return new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (type === "watch") {
      if (!stat.isFile()) {
        return NextResponse.json({ error: "Not a file" }, { status: 400 });
      }
      let watcher: fs.FSWatcher | null = null;
      let lastMtimeMs = stat.mtimeMs;
      let lastSize = stat.size;
      const stream = new ReadableStream({
        start(controller) {
          const send = (eventName: string, data: Record<string, unknown>) => {
            const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
            try {
              controller.enqueue(new TextEncoder().encode(payload));
            } catch {
              // client disconnected
            }
          };
          // Send initial ping so client knows connection is live
          send("connected", { filePath });
          try {
            watcher = fs.watch(realPath, () => {
              try {
                const s = fs.statSync(realPath);
                // Some platforms emit watch events for file reads/attribute
                // access. Ignore those or the client's refresh read loops.
                if (s.mtimeMs === lastMtimeMs && s.size === lastSize) return;
                lastMtimeMs = s.mtimeMs;
                lastSize = s.size;
                send("change", { mtime: s.mtime.toISOString(), size: s.size });
              } catch {
                send("change", { mtime: new Date().toISOString(), size: 0 });
              }
            });
            watcher.on("error", () => {
              try { controller.close(); } catch { /* ignore */ }
            });
          } catch {
            send("error", { message: "Failed to watch file" });
            controller.close();
          }
        },
        cancel() {
          try { watcher?.close(); } catch { /* ignore */ }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // type === "list"
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }

    // Avoid per-entry stat calls for normal files and directories. Symlinks and
    // filesystems without directory type information use the stat fallback.
    const dirents = fs.readdirSync(realPath, { withFileTypes: true });
    const entries = dirents
      .filter((d) => !IGNORED_NAMES.has(d.name) && !IGNORED_SUFFIXES.some((s) => d.name.endsWith(s)))
      .flatMap((d) => {
        const isDir = resolveDirentIsDirectory(d, path.join(realPath, d.name));
        return isDir === null
          ? []
          : [{ name: d.name, isDir, size: 0, modified: "" }];
      })
      .sort((a, b) => {
        // Dirs first, then files, both alphabetically
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return NextResponse.json({ entries, path: filePath });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
