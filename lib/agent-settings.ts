/**
 * Pi Agent 默认设置白名单 seam。
 * 读：SettingsManager 合并视图；写：仅公开 setter 覆盖的键 + flush。
 * 不直接拼 JSON 写 settings.json，不碰 TUI 专属键。
 */

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type AgentThinkingLevel = (typeof THINKING_LEVELS)[number];

export const QUEUE_MODES = ["all", "one-at-a-time"] as const;
export type QueueMode = (typeof QUEUE_MODES)[number];

/** GET 响应：合并生效视图 + 只读嵌套数值 */
export interface AgentSettingsView {
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: AgentThinkingLevel | null;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  compaction: {
    enabled: boolean;
    /** 只读：SDK 无公开 setter */
    reserveTokens: number;
    /** 只读：SDK 无公开 setter */
    keepRecentTokens: number;
  };
  retry: {
    enabled: boolean;
    /** 只读：SDK 无公开 setter */
    maxRetries: number;
    /** 只读：SDK 无公开 setter */
    baseDelayMs: number;
  };
  /** 写入生效的作用域说明 */
  scope: "global";
}

/** PUT 白名单：仅这些键可写 */
export interface AgentSettingsPatch {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: AgentThinkingLevel | null;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  compactionEnabled?: boolean;
  retryEnabled?: boolean;
}

export type AgentSettingsPatchError = {
  field: string;
  message: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isThinkingLevel(value: unknown): value is AgentThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isQueueMode(value: unknown): value is QueueMode {
  return typeof value === "string" && (QUEUE_MODES as readonly string[]).includes(value);
}

/**
 * 校验 PUT body：未知键拒绝；类型错误收集；返回规范化 patch。
 * null 表示清空字符串字段（provider/model/thinking）。
 */
export function parseAgentSettingsPatch(
  body: unknown,
): { ok: true; patch: AgentSettingsPatch } | { ok: false; errors: AgentSettingsPatchError[] } {
  if (!isPlainObject(body)) {
    return { ok: false, errors: [{ field: "", message: "body 必须为对象" }] };
  }

  const allowed = new Set([
    "defaultProvider",
    "defaultModel",
    "defaultThinkingLevel",
    "steeringMode",
    "followUpMode",
    "compactionEnabled",
    "retryEnabled",
  ]);

  const errors: AgentSettingsPatchError[] = [];
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      errors.push({ field: key, message: `不允许的字段: ${key}` });
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const patch: AgentSettingsPatch = {};

  if ("defaultProvider" in body) {
    const v = body.defaultProvider;
    if (v === null) {
      // SDK SettingsManager 无 delete/clear 公开 API；暴露清空会让保存静默无效。
      errors.push({
        field: "defaultProvider",
        message: "SDK 暂不支持清空 defaultProvider，请在 settings.json 中手动删除该键",
      });
    } else if (typeof v === "string") {
      const trimmed = v.trim();
      if (!trimmed) {
        errors.push({ field: "defaultProvider", message: "defaultProvider 不能为空字符串" });
      } else if (trimmed.length > 128) {
        errors.push({ field: "defaultProvider", message: "defaultProvider 过长" });
      } else {
        patch.defaultProvider = trimmed;
      }
    } else {
      errors.push({ field: "defaultProvider", message: "defaultProvider 须为 string 或 null" });
    }
  }

  if ("defaultModel" in body) {
    const v = body.defaultModel;
    if (v === null) {
      errors.push({
        field: "defaultModel",
        message: "SDK 暂不支持清空 defaultModel，请在 settings.json 中手动删除该键",
      });
    } else if (typeof v === "string") {
      const trimmed = v.trim();
      if (!trimmed) {
        errors.push({ field: "defaultModel", message: "defaultModel 不能为空字符串" });
      } else if (trimmed.length > 256) {
        errors.push({ field: "defaultModel", message: "defaultModel 过长" });
      } else {
        patch.defaultModel = trimmed;
      }
    } else {
      errors.push({ field: "defaultModel", message: "defaultModel 须为 string 或 null" });
    }
  }

  if ("defaultThinkingLevel" in body) {
    const v = body.defaultThinkingLevel;
    if (v === null) {
      // SDK setDefaultThinkingLevel 需要合法 level；清空用 off 更安全，由 apply 层处理
      patch.defaultThinkingLevel = null;
    } else if (isThinkingLevel(v)) {
      patch.defaultThinkingLevel = v;
    } else {
      errors.push({
        field: "defaultThinkingLevel",
        message: `defaultThinkingLevel 须为 ${THINKING_LEVELS.join("|")} 或 null`,
      });
    }
  }

  // steeringMode / followUpMode 已产品固化为 "all"，不再接受客户端改写。
  if ("steeringMode" in body) {
    errors.push({ field: "steeringMode", message: "steeringMode 已固定为 all，不可配置" });
  }
  if ("followUpMode" in body) {
    errors.push({ field: "followUpMode", message: "followUpMode 已固定为 all，不可配置" });
  }

  if ("compactionEnabled" in body) {
    if (typeof body.compactionEnabled === "boolean") {
      patch.compactionEnabled = body.compactionEnabled;
    } else {
      errors.push({ field: "compactionEnabled", message: "compactionEnabled 须为 boolean" });
    }
  }

  if ("retryEnabled" in body) {
    if (typeof body.retryEnabled === "boolean") {
      patch.retryEnabled = body.retryEnabled;
    } else {
      errors.push({ field: "retryEnabled", message: "retryEnabled 须为 boolean" });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, errors: [{ field: "", message: "至少提供一个可写字段" }] };
  }

  return { ok: true, patch };
}

/** 从 SettingsManager 形状投影只读视图（便于测试注入） */
export interface AgentSettingsReader {
  getDefaultProvider(): string | undefined;
  getDefaultModel(): string | undefined;
  getDefaultThinkingLevel(): string | undefined;
  getSteeringMode(): QueueMode;
  getFollowUpMode(): QueueMode;
  getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number };
}

export function projectAgentSettingsView(manager: AgentSettingsReader): AgentSettingsView {
  const thinking = manager.getDefaultThinkingLevel();
  return {
    defaultProvider: manager.getDefaultProvider() ?? null,
    defaultModel: manager.getDefaultModel() ?? null,
    defaultThinkingLevel: isThinkingLevel(thinking) ? thinking : null,
    steeringMode: manager.getSteeringMode(),
    followUpMode: manager.getFollowUpMode(),
    compaction: manager.getCompactionSettings(),
    retry: manager.getRetrySettings(),
    scope: "global",
  };
}

export interface AgentSettingsWriter extends AgentSettingsReader {
  setDefaultProvider(provider: string): void;
  setDefaultModel(modelId: string): void;
  setDefaultModelAndProvider(provider: string, modelId: string): void;
  setDefaultThinkingLevel(level: AgentThinkingLevel): void;
  setSteeringMode(mode: QueueMode): void;
  setFollowUpMode(mode: QueueMode): void;
  setCompactionEnabled(enabled: boolean): void;
  setRetryEnabled(enabled: boolean): void;
  flush(): Promise<void>;
}

/**
 * 应用白名单 patch。thinking null → "off"（SDK 无 clear）。
 * provider/model 不允许 null（parseAgentSettingsPatch 已拒绝）。
 */
export async function applyAgentSettingsPatch(
  manager: AgentSettingsWriter,
  patch: AgentSettingsPatch,
): Promise<AgentSettingsView> {
  const provider = patch.defaultProvider;
  const model = patch.defaultModel;

  if (provider !== undefined && model !== undefined) {
    manager.setDefaultModelAndProvider(provider, model);
  } else {
    if (provider !== undefined) {
      manager.setDefaultProvider(provider);
    }
    if (model !== undefined) {
      manager.setDefaultModel(model);
    }
  }

  if (patch.defaultThinkingLevel !== undefined) {
    manager.setDefaultThinkingLevel(patch.defaultThinkingLevel ?? "off");
  }
  // 队列投递策略固定为 all（一次可排队多条，不再暴露 one-at-a-time）。
  manager.setSteeringMode("all");
  manager.setFollowUpMode("all");
  if (patch.compactionEnabled !== undefined) {
    manager.setCompactionEnabled(patch.compactionEnabled);
  }
  if (patch.retryEnabled !== undefined) {
    manager.setRetryEnabled(patch.retryEnabled);
  }

  await manager.flush();
  return projectAgentSettingsView(manager);
}

