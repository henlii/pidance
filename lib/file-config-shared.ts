/**
 * 文件管理可调配置的纯类型/默认值/解析（客户端与服务端共用）。
 */
export interface FileConfig {
  indexMaxFiles: number;
  indexGitHardCap: number;
  indexWalkHardCap: number;
  indexMaxWalkDepth: number;
  atResultLimit: number;
  textPreviewMaxBytes: number;
  imagePreviewMaxBytes: number;
  docxPreviewMaxBytes: number;
  browseMaxEntries: number;
}

export const DEFAULT_FILE_CONFIG: FileConfig = {
  indexMaxFiles: 5000,
  indexGitHardCap: 200_000,
  indexWalkHardCap: 50_000,
  indexMaxWalkDepth: 8,
  atResultLimit: 20,
  textPreviewMaxBytes: 10 * 1024 * 1024,
  imagePreviewMaxBytes: 50 * 1024 * 1024,
  docxPreviewMaxBytes: 10 * 1024 * 1024,
  browseMaxEntries: 400,
};

function toPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export function parseFileConfig(raw: unknown): FileConfig {
  const value = (typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw
    : {}) as Record<string, unknown>;
  return {
    indexMaxFiles: toPositiveInt(value.indexMaxFiles, DEFAULT_FILE_CONFIG.indexMaxFiles),
    indexGitHardCap: toPositiveInt(value.indexGitHardCap, DEFAULT_FILE_CONFIG.indexGitHardCap),
    indexWalkHardCap: toPositiveInt(value.indexWalkHardCap, DEFAULT_FILE_CONFIG.indexWalkHardCap),
    indexMaxWalkDepth: toPositiveInt(value.indexMaxWalkDepth, DEFAULT_FILE_CONFIG.indexMaxWalkDepth),
    atResultLimit: toPositiveInt(value.atResultLimit, DEFAULT_FILE_CONFIG.atResultLimit),
    textPreviewMaxBytes: toPositiveInt(value.textPreviewMaxBytes, DEFAULT_FILE_CONFIG.textPreviewMaxBytes),
    imagePreviewMaxBytes: toPositiveInt(value.imagePreviewMaxBytes, DEFAULT_FILE_CONFIG.imagePreviewMaxBytes),
    docxPreviewMaxBytes: toPositiveInt(value.docxPreviewMaxBytes, DEFAULT_FILE_CONFIG.docxPreviewMaxBytes),
    browseMaxEntries: toPositiveInt(value.browseMaxEntries, DEFAULT_FILE_CONFIG.browseMaxEntries),
  };
}
